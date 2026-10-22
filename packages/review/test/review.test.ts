import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { before, describe, test } from "node:test"
import { Board } from "@mcp-horde/board"
import { loadSyntax } from "@mcp-horde/context"
import { checkVerdicts, collectReview, disagreements, type GateCheck, REVIEW_SCHEMA, renderDiff, renderVerdicts, reviewPrompt } from "../src/lib.js"

const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "horde-review-")))
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd })
    .toString()
    .trim()

before(() => loadSyntax())

/** A repository with a task whose attempt changed login.ts and added a test, and its board. */
async function fixture() {
  const repo = tmp()
  git(repo, "init", "-q")
  fs.mkdirSync(path.join(repo, "src"))
  fs.writeFileSync(path.join(repo, "src", "login.ts"), "export function login(user: string) {\n  return check(user)\n}\n")
  fs.writeFileSync(path.join(repo, "src", "db.ts"), "export const db = 1\n")
  fs.writeFileSync(path.join(repo, "src", "config.ts"), `${Array.from({ length: 12 }, (_, i) => `export const v${i + 1} = ${i + 1}`).join("\n")}\n`)
  git(repo, "add", "-A")
  git(repo, "commit", "-qm", "init")
  const base = git(repo, "rev-parse", "HEAD")
  const board = await Board.open(repo, tmp())
  const t = (
    await board.plan([
      {
        title: "Rate limit login",
        goal: "Limit failed logins.",
        acceptance: ["429 after 5 failures per minute", "the limit is configurable", "failures are logged"],
        scope: ["src/**"],
      },
    ])
  ).tasks[0]!
  const { attempt } = await board.assign(t.id, "w")
  await board.bindWorkspace(t.id, attempt.token, { path: repo, base })
  fs.writeFileSync(
    path.join(repo, "src", "login.ts"),
    "const LIMIT = 5\nexport function login(user: string) {\n  if (failures(user) > LIMIT) return 429\n  return check(user)\n}\n",
  )
  fs.writeFileSync(path.join(repo, "src", "login.test.ts"), "test('429', () => {})\n")
  return { repo, board, id: t.id }
}

describe("review", () => {
  test("the change is shown with new-file line numbers, and what may be cited is known", async () => {
    const { board, id } = await fixture()
    const r = await collectReview(board, id)
    assert.deepEqual(r.criteria, ["429 after 5 failures per minute", "the limit is configurable", "failures are logged"])
    assert.match(r.diff, /=== src\/login\.ts[\s\S]*L1 \+const LIMIT = 5[\s\S]*L3 \+ {2}if \(failures\(user\) > LIMIT\) return 429/)
    assert.match(r.diff, /=== src\/login\.test\.ts\n@@\nL1 \+test\('429'/, "untracked files are part of the change")
    assert.ok(r.shown.get("src/login.ts")?.has(4), "context lines are shown too")
    assert.deepEqual([...r.changed.get("src/login.ts")!], [1, 3], "the lines the change adds, for untouched checks")
    assert.ok(r.diffFiles.has("src/login.ts") && r.diffFiles.has("src/login.test.ts"))
    assert.deepEqual(r.hunks.get("src/login.ts"), [[1, 5]], "the hunk covers its context lines too")
    assert.deepEqual([...r.touched].sort(), ["src/login.ts: function login (2-5)", "src/login.ts: variable LIMIT (1-1)"])
    const prompt = reviewPrompt(r)
    assert.match(prompt, /# Acceptance criteria\n1\. 429 after 5 failures per minute\n2\. the limit is configurable\n3\. failures are logged/)
    assert.match(prompt, /"met" needs evidence/)
  })

  test("citations are checked: an unfounded met is unclear, a missing verdict too", async () => {
    const { board, id } = await fixture()
    const r = await collectReview(board, id)
    const v = checkVerdicts(r, {
      verdicts: [
        {
          criterion: 1,
          status: "met",
          evidence: [
            { file: "src/login.ts", line: 3 },
            { file: "./src/login.ts", line: 1 },
            { file: "src/login.ts", line: 99 },
          ],
          note: "returns 429",
        },
        { criterion: 2, status: "met", evidence: [{ file: "src/other.ts", line: 1 }], note: "configurable" },
      ],
    })
    assert.deepEqual(
      v.map((x) => [x.status, x.evidence.length]),
      [
        ["met", 2],
        ["unclear", 0],
        ["unclear", 0],
      ],
    )
    assert.match(v[0]!.note, /1 citation\(s\) not in the change were dropped/)
    assert.match(v[1]!.note, /said met, but cited no line of the change/)
    assert.match(v[2]!.note, /gave no verdict/)
    const text = renderVerdicts(r, v, "mid/kimi")
    assert.match(text, /^review t-\w+ "Rate limit login" by mid\/kimi: 1\/3 met\n✓ 1\. 429 after 5 failures per minute — src\/login\.ts:1-3\n {4}returns 429/)
    assert.match(text, /\? 2\. the limit is configurable\n {4}configurable \(said met/)
    const other = checkVerdicts(r, { verdicts: [{ criterion: 1, status: "not_met", evidence: [], note: "no" }] })
    assert.deepEqual(disagreements({ model: "a", verdicts: v }, { model: "b", verdicts: other }), ["criterion 1: a says met, b says not_met"])
  })

  test("the gate's checks are listed and may be cited as evidence; without them the prompt is unchanged", async () => {
    const { board, id } = await fixture()
    const r = await collectReview(board, id)
    const checks: GateCheck[] = [
      { name: "test", pass: true, summary: "12 passing" },
      { name: "lint", pass: false },
    ]
    const prompt = reviewPrompt(r, checks)
    assert.match(prompt, /# Checks the gate ran\n✓ test: 12 passing\n✗ lint\n# How to answer/)
    assert.match(prompt, /\{"check": "<name>"\}/)
    assert.doesNotMatch(prompt, /Tests passing is checked elsewhere/)
    const plain = reviewPrompt(r)
    assert.equal(plain, reviewPrompt(r, undefined))
    assert.equal(plain, reviewPrompt(r, []))
    assert.doesNotMatch(plain, /# Checks the gate ran|"check"/)
    assert.match(plain, /Tests passing is checked elsewhere; judge behaviour\./)
  })

  test("the review schema accepts a line, a check or an untouched path as evidence", () => {
    const items = REVIEW_SCHEMA.properties.verdicts.items.properties.evidence.items as unknown as { anyOf: { required: string[] }[] }
    assert.deepEqual(
      items.anyOf.map((x) => x.required),
      [["file", "line"], ["check"], ["untouched"]],
    )
  })

  test("a passed check supports met only for a criterion about checks; a failed one and an invalid line are dropped together", async () => {
    const { board, id } = await fixture()
    const r = await collectReview(board, id)
    const v = checkVerdicts(
      r,
      {
        verdicts: [
          { criterion: 1, status: "met", evidence: [{ check: "test" }], note: "tests pass" },
          { criterion: 2, status: "met", evidence: [{ check: "lint" }], note: "lint passes" },
          { criterion: 3, status: "not_met", evidence: [{ file: "src/login.ts", line: 99 }, { check: "nope" }], note: "not logged" },
        ],
      },
      [
        { name: "test", pass: true },
        { name: "lint", pass: false },
      ],
    )
    assert.deepEqual(
      v.map((x) => [x.status, x.evidence.length, x.checks]),
      [
        ["unclear", 0, ["test"]],
        ["unclear", 0, []],
        ["not_met", 0, []],
      ],
    )
    assert.match(v[0]!.note, /said met, but cited no line of the change/)
    assert.match(v[1]!.note, /said met, but cited no line of the change/)
    assert.match(v[2]!.note, /2 citation\(s\) not in the change were dropped/)
    const [tests] = checkVerdicts(
      { ...r, criteria: ["existing tests pass"] },
      { verdicts: [{ criterion: 1, status: "met", evidence: [{ check: "test" }], note: "tests pass" }] },
      [
        { name: "test", pass: true },
        { name: "lint", pass: false },
      ],
    )
    assert.equal(tests!.status, "met")
    assert.deepEqual(tests!.checks, ["test"])
    const text = renderVerdicts(r, v, "mid/kimi")
    assert.match(text, /\? 1\. 429 after 5 failures per minute — checks: test/)
    const combo = renderVerdicts(
      r,
      [{ criterion: 1, text: "429", status: "met", evidence: [{ file: "src/login.ts", line: 3 }], checks: ["test"], untouched: [], note: "" }],
      "mid/kimi",
    )
    assert.match(combo, /— src\/login\.ts:3, checks: test/)
  })

  test("an untouched citation is kept only for an existing file or line the change does not touch", async () => {
    const { board, id } = await fixture()
    const r = await collectReview(board, id)
    assert.match(reviewPrompt(r), /\{"untouched": "<path>"\} or \{"untouched": "<path>:<line>"\}/)
    const unchanged = { ...r, criteria: ["src/db.ts is not changed", "src/db.ts is not changed", "src/db.ts is not changed"] }
    const v = checkVerdicts(unchanged, {
      verdicts: [
        {
          criterion: 1,
          status: "met",
          evidence: [{ untouched: "src/db.ts" }, { untouched: "no/such/file.ts" }, { untouched: "the CLI parser" }],
          note: "db unchanged",
        },
        { criterion: 2, status: "met", evidence: [{ untouched: "src/login.ts" }], note: "login unchanged" },
        {
          criterion: 3,
          status: "met",
          evidence: [{ untouched: "./src/db.ts:1" }, { untouched: "src/db.ts:99" }],
          note: "db line unchanged",
        },
      ],
    })
    assert.deepEqual(
      v.map((x) => [x.status, x.untouched]),
      [
        ["met", ["src/db.ts"]],
        ["unclear", []],
        ["met", ["src/db.ts:1"]],
      ],
    )
    assert.match(v[0]!.note, /2 citation\(s\) not in the change were dropped/)
    assert.match(v[1]!.note, /said met, but cited no line of the change/)
    assert.match(v[1]!.note, /1 citation\(s\) not in the change were dropped/)
    assert.match(v[2]!.note, /1 citation\(s\) not in the change were dropped/)
    const text = renderVerdicts(unchanged, v, "mid/kimi")
    assert.match(text, /✓ 1\. src\/db\.ts is not changed — untouched: src\/db\.ts/)
    assert.match(text, /✓ 3\. src\/db\.ts is not changed — untouched: src\/db\.ts:1/)
  })

  test("a file the diff budget left out is never counted as untouched", async () => {
    const { repo, board, id } = await fixture()
    const config = path.join(repo, "src", "config.ts")
    const lines = fs.readFileSync(config, "utf8").trimEnd().split("\n")
    lines[1] = "export const v2 = 22"
    fs.writeFileSync(config, `${lines.join("\n")}\n`)
    const r = await collectReview(board, id, { maxDiffChars: 1 })
    assert.ok(r.omitted.includes("src/login.ts") && r.omitted.includes("src/login.test.ts"))
    assert.ok(r.diffFiles.has("src/login.ts") && r.hunks.has("src/login.ts"), "files and hunks survive the budget")
    const [file] = checkVerdicts(r, {
      verdicts: [{ criterion: 1, status: "met", evidence: [{ untouched: "src/login.ts" }, { untouched: "src/login.test.ts" }], note: "not changed" }],
    })
    assert.equal(file!.status, "unclear")
    assert.deepEqual(file!.untouched, [])
    assert.ok(!r.hunks.get("src/config.ts")?.some(([start, end]) => 12 >= start && 12 <= end), "line 12 is outside the hunk")
    const [line] = checkVerdicts(
      { ...r, criteria: ["line 12 of src/config.ts is not changed"] },
      { verdicts: [{ criterion: 1, status: "met", evidence: [{ untouched: "src/config.ts:12" }], note: "line not changed" }] },
    )
    assert.equal(line!.status, "met")
    assert.deepEqual(line!.untouched, ["src/config.ts:12"])
  })

  test("a met backed only by an unchanged context line is unclear", async () => {
    const { board, id } = await fixture()
    const r = await collectReview(board, id)
    assert.ok(r.shown.get("src/login.ts")?.has(4), "the context line is shown")
    assert.ok(!r.changed.get("src/login.ts")?.has(4), "but the change does not add it")
    const [v] = checkVerdicts(r, {
      verdicts: [{ criterion: 1, status: "met", evidence: [{ file: "src/login.ts", line: 4 }], note: "context" }],
    })
    assert.equal(v!.status, "unclear")
    assert.deepEqual(v!.evidence, [])
    assert.match(v!.note, /said met, but cited no line of the change/)
    assert.match(v!.note, /1 citation\(s\) not in the change were dropped/)
  })

  test("the diff budget keeps whole small files and lists the rest; hunk lines starting with dashes are not headers", () => {
    const raw = [
      "diff --git a/big.sql b/big.sql",
      "--- a/big.sql",
      "+++ b/big.sql",
      "@@ -1,2 +1,2 @@",
      "--- old comment",
      "+++ new value",
      ` ${"x".repeat(500)}`,
      "diff --git a/small.ts b/small.ts",
      "--- a/small.ts",
      "+++ b/small.ts",
      "@@ -10,1 +10,1 @@ fn",
      "-a",
      "+b",
    ].join("\n")
    const all = renderDiff(raw, 10_000)
    assert.ok(all.shown.get("big.sql")?.has(1) && all.shown.get("big.sql")?.has(2), "the +++ line inside a hunk is an added line")
    assert.match(all.diff, /L1 \+\+\+ new value/)
    const tight = renderDiff(raw, 100)
    assert.deepEqual(tight.omitted, ["big.sql"])
    assert.ok(tight.shown.has("small.ts") && !tight.shown.has("big.sql"))
  })

  test("a deleted file is named instead of vanishing from the review", async () => {
    const { repo, board, id } = await fixture()
    fs.rmSync(path.join(repo, "src", "login.ts"))
    const r = await collectReview(board, id)
    assert.match(r.diff, /=== src\/login\.ts \(deleted\)/)
    assert.equal(r.shown.get("src/login.ts"), undefined)
    assert.ok(r.diffFiles.has("src/login.ts") && r.deleted.has("src/login.ts"))
    const [file] = checkVerdicts(r, {
      verdicts: [{ criterion: 1, status: "met", evidence: [{ untouched: "src/login.ts" }], note: "unchanged" }],
    })
    assert.equal(file!.status, "unclear")
    assert.deepEqual(file!.untouched, [])
    const [line] = checkVerdicts(r, {
      verdicts: [{ criterion: 1, status: "met", evidence: [{ untouched: "src/login.ts:1" }], note: "unchanged" }],
    })
    assert.equal(line!.status, "unclear")
    assert.deepEqual(line!.untouched, [])
  })

  test("a deletion-only change makes its hunk lines touched, while a line outside stays untouched", async () => {
    const { repo, board, id } = await fixture()
    const config = path.join(repo, "src", "config.ts")
    const lines = fs.readFileSync(config, "utf8").trimEnd().split("\n")
    fs.writeFileSync(config, `${lines.filter((_, i) => i !== 5).join("\n")}\n`)
    const r = await collectReview(board, id)
    assert.equal(r.changed.get("src/config.ts"), undefined, "nothing was added")
    assert.ok(r.diffFiles.has("src/config.ts"))
    assert.deepEqual(r.hunks.get("src/config.ts"), [[3, 8]])
    const v = checkVerdicts(
      { ...r, criteria: ["failures are logged", "src/config.ts line 10 is not changed", "failures are logged"] },
      {
        verdicts: [
          { criterion: 1, status: "met", evidence: [{ untouched: "src/config.ts:5" }], note: "inside the hunk" },
          { criterion: 2, status: "met", evidence: [{ untouched: "src/config.ts:10" }], note: "far outside" },
          { criterion: 3, status: "not_met", evidence: [], note: "not relevant" },
        ],
      },
    )
    assert.deepEqual(
      v.map((x) => [x.status, x.untouched]),
      [
        ["unclear", []],
        ["met", ["src/config.ts:10"]],
        ["not_met", []],
      ],
    )
  })

  test("an untracked file too large to show is listed as not shown", async () => {
    const { repo, board, id } = await fixture()
    fs.writeFileSync(path.join(repo, "src", "huge.txt"), "x".repeat(200_001))
    const r = await collectReview(board, id)
    assert.deepEqual(r.omitted, ["src/huge.txt"])
    assert.match(reviewPrompt(r), /not shown in this review: src\/huge\.txt/)
  })

  test("a task without a recorded workspace needs a path", async () => {
    const board = new Board(tmp())
    const t = (await board.plan([{ title: "x", goal: "y" }])).tasks[0]!
    await assert.rejects(collectReview(board, t.id), /no workspace on record/)
  })
})
