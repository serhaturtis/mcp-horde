import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { before, describe, test } from "node:test"
import { Board } from "@mcp-horde/board"
import { loadSyntax } from "@mcp-horde/context"
import { checkVerdicts, collectReview, disagreements, renderDiff, renderVerdicts, reviewPrompt } from "../src/lib.js"

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
    assert.ok(r.shown.get("src/login.ts")?.has(4), "context lines may be cited too")
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

  test("a task without a recorded workspace needs a path", async () => {
    const board = new Board(tmp())
    const t = (await board.plan([{ title: "x", goal: "y" }])).tasks[0]!
    await assert.rejects(collectReview(board, t.id), /no workspace on record/)
  })
})
