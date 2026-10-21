import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { Board } from "@mcp-horde/board"
import { logDirFor } from "@mcp-horde/verify"
import { connect, git, type Harness, isolatedEnv, type Mock, makeRepo, until } from "./harness.js"
import { startMockLlm } from "./mock-llm.js"

// The simple path the way an agent that has never seen the horde uses it: horde_do, horde_wait,
// horde_land, and horde_tell / horde_drop when something goes wrong.

// The project's one check: every .txt file says "ok" (a hint fixes it, except for stubborn.txt),
// and the guard file a test commits to master breaks it.
const CHECK = `const fs = require("fs")
const bad = []
for (const f of fs.readdirSync(".").filter((f) => f.endsWith(".txt"))) {
  if (fs.readFileSync(f, "utf8").trim() === "ok") continue
  bad.push([f, "Error: " + f + " must say ok." + (f === "stubborn.txt" ? "" : " TOOL: echo ok > " + f + " && git add -A && git commit -qm fix")])
}
if (fs.existsSync("broken.flag")) bad.push(["broken.flag", "Error: broken.flag exists"])
// Passes alone on either side, fails only once the worker's file and master's move meet.
if (fs.existsSync("third.txt") && fs.existsSync("gate.txt")) bad.push(["third.txt+gate.txt", "Error: third.txt and gate.txt must not exist together"])
// TAP so several failures are each reported (the generic extractor only sees one in a block).
console.log("TAP version 13")
bad.forEach(([f, message], i) => {
  console.log("not ok " + (i + 1) + " - " + f)
  console.log("  ---")
  console.log("  message: " + message)
  console.log("  ...")
})
if (bad.length) process.exit(1)
`

let h: Harness
let mock: Mock
let repo: string
let tmp: string
const boardState = () => path.join(tmp, "board-state")
const idOf = (text: string) => text.match(/\bt-[0-9a-f]+\b/)![0]
const branches = () => git(repo, "branch", "--list", "horde/*")
const baselineBranches = () => git(repo, "branch", "--list", "horde/base-*")

/** Baseline checkouts left under the worktree directory (they are named base-<sha>-<hex>). */
function baselineLeftovers(): string[] {
  const root = path.join(tmp, "worktrees")
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      if (e.name.startsWith("base-")) out.push(path.join(dir, e.name))
      walk(path.join(dir, e.name))
    }
  }
  if (fs.existsSync(root)) walk(root)
  return out
}

/** The next outcome other than a permission request; the test repo's OpenCode config asks before shell commands. */
async function settle(id: string): Promise<string> {
  for (;;) {
    const out = await h.call("horde_wait", { ids: [id], timeout_seconds: 120 })
    if (!/ NEEDS YOU /.test(out)) return out
    await h.call("horde_tell", { id, approve: true })
  }
}

describe("the simple path: horde_do, horde_wait, horde_land (real opencode, mock LLM)", { timeout: 600_000 }, () => {
  before(async () => {
    mock = await startMockLlm()
    ;({ tmp, repo } = makeRepo(mock.url))
    fs.writeFileSync(path.join(repo, "check.js"), CHECK)
    fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify({ verify: { checks: { test: "node check.js" } }, tiers: ["mock/mock", "mock/pricey"] }))
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "checks")
    h = await connect({ ...isolatedEnv(tmp, repo), HORDE_BOARD_STATE_DIR: boardState() })
  })

  after(async () => {
    await h?.call("opencode_server", { action: "stop" }).catch(() => undefined)
    await h?.close()
    mock?.close()
  })

  test("three calls: delegate, collect a checked and reviewed outcome, land it", async () => {
    const started = await h.call("horde_do", {
      goal: "Write the greeting file.\nRUN: echo ok > hello.txt && git add hello.txt && git commit -qm hello",
      done: ["hello.txt says ok", "nothing else changes"],
      scope: ["hello.txt"],
    })
    assert.match(started, /^t-\w+ working: "Write the greeting file" · mock\/mock \(tier 0 of 2\) · worktree horde\/t-\w+/, started)
    assert.match(started, /scope: hello\.txt/)
    assert.match(started, /checked by: test \(node check\.js\) · the tests related to the change after each round, every check before landing/)
    assert.match(started, /→ horde_wait \{ids: \["t-\w+"\]\}/)
    const id = idOf(started)

    // The worker asks before running shell commands (this repo's OpenCode config says "ask").
    const asks = await h.call("horde_wait", { ids: [id], timeout_seconds: 120 })
    assert.match(
      asks,
      new RegExp(`^${id} NEEDS YOU · "Write the greeting file"\n  wants to run: echo ok > hello.txt ; git add hello.txt ; git commit -qm hello`),
      asks,
    )
    assert.match(asks, new RegExp(`→ horde_tell {id: "${id}", approve: true}`))
    assert.match(await h.call("horde_tell", { id, approve: true }), /allowed: shell echo ok > hello\.txt/)

    const ready = await settle(id)
    assert.match(ready, new RegExp(`^${id} READY · "Write the greeting file"`), ready)
    // The mock's canned report names files it never touched: the outcome says so.
    assert.match(
      ready,
      /checks ✓ test · review: 1 of 2 criteria met, 1 unproven · ⚠ the worker's report names a\.ts, b\.ts, a\.test\.ts, which its diff does not touch/,
    )
    assert.match(ready, /changed 1 file\(s\) \(\+1 −0\): hello\.txt/)
    assert.match(ready, /branch horde\/t-\w+ · diff: git -C \S+ diff [0-9a-f]{10}/)
    // A criterion the review could not prove comes with the call that gets it proven.
    assert.match(ready, /unproven: "nothing else changes" → horde_tell \{id: "t-\w+", message: "Show that this holds/)
    assert.match(ready, /\$\d.* · mock\/mock \(tier 0; tier 1 is mock\/pricey\)/)
    assert.match(ready, new RegExp(`→ horde_land \\{id: "${id}"\\}`))

    const before = git(repo, "rev-parse", "HEAD")
    const logs = logDirFor(path.join(tmp, "xdg-state", "mcp-horde", "verify", "logs"), ready.match(/diff: git -C (\S+) diff/)![1]!)
    assert.ok(fs.existsSync(logs), "the gate kept its check logs while the task lived")
    const landed = await h.call("horde_land", { id })
    assert.match(
      landed,
      new RegExp(`^landed ${id} on master: 1 commit\\(s\\) · checks ✓ test on master's tip before updating it · task done, worktree and branch removed`),
      landed,
    )
    assert.ok(!fs.existsSync(logs), "and they went with the worktree")
    assert.equal(fs.readFileSync(path.join(repo, "hello.txt"), "utf8").trim(), "ok")
    assert.equal(git(repo, "rev-parse", "HEAD~1"), before, "exactly the worker's commit, on top of master")
    assert.equal(branches(), "", "the merged branch is gone")
    const board = await Board.open(repo, boardState())
    assert.equal(board.task(id).status, "done")
  })

  test("without a commit-msg hook, leftover uncommitted work is still committed during landing", async () => {
    const id = idOf(
      await h.call("horde_do", {
        goal: "Write the kept file.\nRUN: echo ok > kept.txt && git add kept.txt && git commit -qm kept",
        done: ["kept.txt says ok"],
        scope: ["kept.txt", "loose.txt"],
      }),
    )
    const ready = await settle(id)
    assert.match(ready, new RegExp(`^${id} READY`), ready)
    const worktree = ready.match(/diff: git -C (\S+) diff/)![1]!
    fs.writeFileSync(path.join(worktree, "loose.txt"), "ok\n")
    assert.match(await h.call("horde_land", { id }), /^landed t-\w+ on master: 2 commit\(s\)/)
    assert.equal(fs.readFileSync(path.join(repo, "loose.txt"), "utf8").trim(), "ok")
  })

  test("a failure says why and what changed; horde_tell gets it fixed; then it lands", async () => {
    const id = idOf(
      await h.call("horde_do", {
        goal: "Write the stubborn file.\nRUN: echo nope > stubborn.txt && git add stubborn.txt && git commit -qm stubborn",
        done: ["stubborn.txt says ok"],
        scope: ["stubborn.txt"],
      }),
    )
    const failed = await settle(id)
    assert.match(failed, new RegExp(`^${id} FAILED · "Write the stubborn file" \\(checks failed after 2 round\\(s\\)\\)`), failed)
    assert.match(failed, /stubborn\.txt must say ok/)
    assert.match(failed, /changed 1 file\(s\) \(\+1 −0\): stubborn\.txt\n {4}stubborn\.txt\n {4}\+nope/)
    assert.match(failed, /branch horde\/t-\w+ · diff: git -C \S+ diff [0-9a-f]{10}/)
    assert.match(failed, /tier 1 is mock\/pricey/)
    assert.match(
      failed,
      /→ horde_tell \{id: "t-\w+", message: "<a precise hint>"\} \(its checks run again\) · horde_tell \{id: "t-\w+", message, model: "mock\/pricey"\}/,
    )

    const told = await h.call("horde_tell", { id, message: "TOOL: echo ok > stubborn.txt && git add -A && git commit -qm fix" })
    assert.match(told, /it works again; its checks run again when it finishes/)
    assert.match(await settle(id), new RegExp(`^${id} READY`))
    assert.match(await h.call("horde_land", { id }), /^landed t-\w+ on master: 2 commit\(s\)/)
    assert.equal(fs.readFileSync(path.join(repo, "stubborn.txt"), "utf8").trim(), "ok")
  })

  test("landing never breaks your branch: commits that fail on top of it leave it untouched", async () => {
    const id = idOf(
      await h.call("horde_do", {
        goal: "Write the third file.\nRUN: echo ok > third.txt && git add third.txt && git commit -qm third",
        done: ["third.txt says ok"],
        scope: ["third.txt"],
      }),
    )
    assert.match(await settle(id), /READY/)
    // Master moves on, in a way that only fails together with the worker's change.
    fs.writeFileSync(path.join(repo, "gate.txt"), "ok\n")
    git(repo, "add", "gate.txt")
    git(repo, "commit", "-qm", "master moves on")
    const head = git(repo, "rev-parse", "HEAD")
    const refused = await h.call("horde_land", { id })
    assert.match(refused, new RegExp(`^not landed: ${id}'s commits fail the checks on top of master:`), refused)
    assert.match(refused, /third\.txt and gate\.txt must not exist together/)
    assert.match(refused, /master is unchanged; the worker is now on top of it\./)
    assert.equal(git(repo, "rev-parse", "HEAD"), head, "master did not move")
    assert.ok(!fs.existsSync(path.join(repo, "third.txt")))
    // Fixed on master: the same task lands now (its verdict stands; the landing re-checks).
    git(repo, "rm", "-q", "gate.txt")
    git(repo, "commit", "-qm", "fix master")
    assert.match(await h.call("horde_land", { id }), /^landed t-\w+ on master: 1 commit\(s\)/)
    assert.ok(fs.existsSync(path.join(repo, "third.txt")))
  })

  test("horde_tell changes a running task's scope; horde_drop stops it and removes its worktree and branch", async () => {
    const started = await h.call("horde_do", { goal: "Take your time.\nRUN: sleep 30", done: ["it waited"], scope: ["slow/**"] })
    const id = idOf(started)
    assert.match(await h.call("horde_tell", { id, scope: ["slow/**", "docs/**"] }), /its scope is now slow\/\*\*, docs\/\*\*/)
    const board = await Board.open(repo, boardState())
    assert.deepEqual(board.task(id).scope, ["slow/**", "docs/**"])
    const worktree = started.match(/worktree (horde\/t-\w+)/)![1]!
    assert.match(branches(), new RegExp(worktree))
    const dropped = await h.call("horde_drop", { id, reason: "not needed" })
    assert.match(dropped, new RegExp(`^dropped ${id}: the worker stopped, the attempt is recorded as failed, and its worktree and branch are removed`), dropped)
    assert.equal(branches(), "")
    assert.equal((await Board.open(repo, boardState())).task(id).status, "failed")
    await assert.rejects(h.call("horde_wait", { ids: [id] }), /unknown agent|no longer tracked|disposed/)
  })

  test("landing as one commit: the repository's commit-msg hook judges the message first", async () => {
    const { tmp: at, repo: hooked } = makeRepo(mock.url)
    const marker = path.join(at, "land-check.ran")
    fs.writeFileSync(path.join(hooked, "old.txt"), "stale\n")
    fs.writeFileSync(
      path.join(hooked, "horde.json"),
      JSON.stringify({
        verify: {
          checks: {
            ok: "true",
            // Landing-only, so seeing it run proves the checks ran after the hook accepted the message.
            land: { command: `node -e "require('fs').writeFileSync(process.argv[1], 'ran')" ${JSON.stringify(marker)}`, when: "land" },
          },
        },
        tiers: ["mock/mock", "mock/pricey"],
      }),
    )
    git(hooked, "add", ".")
    git(hooked, "commit", "-qm", "checks")
    // Carried over as the worktree's baseline: it must not land with the task.
    fs.writeFileSync(path.join(hooked, "carried.txt"), "carried\n")
    const hooks = path.join(at, "hooks")
    fs.mkdirSync(hooks)
    fs.writeFileSync(
      path.join(hooks, "commit-msg"),
      '#!/bin/sh\nif git diff --cached --name-status | grep -q "^D"; then\n  grep -q "^DELETE:" "$1" || { echo "commit-msg: removing a file needs a DELETE: line" >&2; exit 1; }\nfi\nprintf "\\nCo-authored-by: commit-msg hook\\n" >> "$1"\n',
    )
    if (process.platform !== "win32") fs.chmodSync(path.join(hooks, "commit-msg"), 0o755)
    git(hooked, "config", "core.hooksPath", hooks)

    const started = await h.call("horde_do", {
      directory: hooked,
      goal: 'Delete the stale file.\nRUN: rm old.txt && git add -A && git commit -qm "DELETE: drop old.txt"',
      done: ["old.txt is gone"],
      scope: ["old.txt"],
    })
    const id = idOf(started)
    const branch = started.match(/worktree (horde\/[\w-]+)/)![1]!
    const ready = await settle(id)
    assert.match(ready, /READY/)
    const worktree = ready.match(/diff: git -C (\S+) diff/)![1]!
    const head = git(hooked, "rev-parse", "HEAD")
    const workerHead = git(hooked, "rev-parse", branch)

    // Uncommitted work in a repository with a commit-msg hook: refused before anything moves,
    // since landing would commit it with --no-verify and bypass the hook.
    fs.writeFileSync(path.join(worktree, "leftover.txt"), "left\n")
    const leftovers = await h.call("horde_land", { id })
    assert.match(leftovers, /^not landed: .*still has uncommitted changes/, leftovers)
    assert.ok(leftovers.includes(path.join(hooks, "commit-msg")), leftovers)
    assert.match(
      leftovers,
      new RegExp(
        `horde_tell \\{id: "${id}", message: "Commit your remaining changes with git commit; this repository's commit-msg hook judges the message"\\}`,
      ),
      leftovers,
    )
    assert.match(leftovers, new RegExp(`horde_land \\{id: "${id}", message\\}`), leftovers)
    assert.equal(git(hooked, "rev-parse", "HEAD"), head, "master did not move")
    assert.equal(git(hooked, "rev-parse", branch), workerHead, "the worker's branch did not move")
    assert.ok(!fs.existsSync(marker), "no check ran")
    fs.rmSync(path.join(worktree, "leftover.txt"))

    // The hook rejects the message: the branch is restored and the checks never run.
    const refused = await h.call("horde_land", { id, message: "drop the stale file" })
    assert.match(refused, /did not pass the repository's commit-msg hook/, refused)
    assert.match(refused, /removing a file needs a DELETE: line/, refused)
    assert.match(refused, new RegExp(`horde_land \\{id: "${id}", message:`))
    assert.equal(git(hooked, "rev-parse", "HEAD"), head, "master did not move")
    assert.equal(git(hooked, "log", "-1", "--format=%s", branch), "DELETE: drop old.txt", "the worker's branch still holds its work")
    assert.ok(!fs.existsSync(marker), "the checks did not run")

    // Accepted (and edited by the hook): one commit with that message, the baseline left out.
    const landed = await h.call("horde_land", { id, message: "DELETE: drop old.txt" })
    assert.match(landed, new RegExp(`^landed ${id} on master: 1 commit\\(s\\)`), landed)
    assert.ok(fs.existsSync(marker), "the checks ran")
    assert.equal(git(hooked, "rev-list", "--count", `${head}..HEAD`), "1", "exactly one commit")
    assert.equal(git(hooked, "log", "-1", "--format=%s"), "DELETE: drop old.txt")
    assert.match(git(hooked, "log", "-1", "--format=%B"), /Co-authored-by: commit-msg hook/, "the hook's edit is in the landed commit")
    assert.ok(!fs.existsSync(path.join(hooked, "old.txt")))
    assert.equal(git(hooked, "status", "--porcelain"), "?? carried.txt", "the carried-over change stays uncommitted, never landed")
    assert.equal(git(hooked, "branch", "--list", "horde/*"), "", "the merged branch is gone")
  })

  test("with a commit-msg hook: the gate sends uncommitted work back to git commit, and landing keeps the checked hashes", async () => {
    const { tmp: at, repo: hooked } = makeRepo(mock.url)
    fs.writeFileSync(path.join(hooked, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } }, tiers: ["mock/mock", "mock/pricey"] }))
    git(hooked, "add", ".")
    git(hooked, "commit", "-qm", "checks")
    const hooks = path.join(at, "hooks")
    fs.mkdirSync(hooks)
    const hook = path.join(hooks, "commit-msg")
    fs.writeFileSync(hook, "#!/bin/sh\nexit 0\n")
    if (process.platform !== "win32") fs.chmodSync(hook, 0o755)
    git(hooked, "config", "core.hooksPath", hooks)

    const seen = mock.requests.length
    const started = await h.call("horde_do", {
      directory: hooked,
      goal: 'Write the file and leave another change uncommitted.\nRUN: echo ok > file.txt && git add file.txt && git commit -qm "add file" && echo loose > loose.txt',
      done: ["file.txt says ok"],
      scope: ["file.txt", "loose.txt"],
    })
    const id = idOf(started)
    const branch = started.match(/worktree (horde\/[\w-]+)/)![1]!
    // The first prompt points the worker at the hook it must commit through.
    const prompts = (mock.requests.slice(seen) as { messages?: { role: string; content: unknown }[] }[])
      .flatMap((r) => r.messages ?? [])
      .map((m) => (typeof m.content === "string" ? m.content : ((m.content as { text?: string }[] | undefined) ?? []).map((p) => p.text ?? "").join(" ")))
      .join("\n")
    assert.ok(prompts.includes(`commit-msg hook at ${hook}`), prompts)

    const ready = await settle(id)
    assert.match(ready, new RegExp(`^${id} READY`), ready)
    // The gate sent the uncommitted change back; the worker only became ready after committing it.
    assert.equal(git(hooked, "log", "-1", "--format=%s", branch), "test: commit the work")
    const workerHead = git(hooked, "rev-parse", branch)
    const landed = await h.call("horde_land", { id })
    assert.match(landed, new RegExp(`^landed ${id} on master: 2 commit\\(s\\)`), landed)
    assert.equal(git(hooked, "rev-parse", "HEAD"), workerHead, "fast-forward kept the checked commits' hashes")
    assert.equal(fs.readFileSync(path.join(hooked, "file.txt"), "utf8").trim(), "ok")
    assert.equal(fs.readFileSync(path.join(hooked, "loose.txt"), "utf8").trim(), "loose")
  })

  test("horde_do refuses up front in a repository without checks, and says how to add them", async () => {
    const bare = path.join(tmp, "no-checks")
    fs.mkdirSync(bare)
    fs.writeFileSync(path.join(bare, "README.md"), "# nothing to run\n")
    git(bare, "init", "-q")
    git(bare, "add", ".")
    git(bare, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init")
    await assert.rejects(h.call("horde_do", { goal: "Change the README.", directory: bare }), (err: Error) => {
      assert.match(err.message, /no checks found in .*no-checks, so nothing was started/)
      assert.match(err.message, /"verify": \{"checks"/)
      return true
    })
    assert.deepEqual((await Board.open(bare, boardState())).tasks(), [], "no task was planned")
    // Checks only in the working tree: the workers' gates read HEAD's horde.json and would find none.
    fs.writeFileSync(path.join(bare, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } } }))
    await assert.rejects(h.call("horde_do", { goal: "Change the README.", directory: bare }), /horde\.json are not committed, so nothing was started/)
  })

  test("horde_drop closes a task whose worker never started", async () => {
    const board = await Board.open(repo, boardState())
    const [task] = (await board.plan([{ title: "Stale claim", goal: "Never started.", acceptance: [], scope: [] }])).tasks
    const dropped = await h.call("horde_drop", { id: task!.id, reason: "stale" })
    assert.match(dropped, new RegExp(`^dropped ${task!.id}: it had no worker`), dropped)
    assert.equal((await Board.open(repo, boardState())).task(task!.id).status, "failed")
    await assert.rejects(h.call("horde_drop", { id: "t-0000" }), /unknown agent/)
  })

  test("a check that already fails where the task started does not block READY or landing", async () => {
    // Master itself is broken in a file no task touches.
    fs.writeFileSync(path.join(repo, "known.txt"), "bad\n")
    git(repo, "add", "known.txt")
    git(repo, "commit", "-qm", "already broken")
    const start = git(repo, "rev-parse", "--short=8", "HEAD")
    const id = idOf(
      await h.call("horde_do", {
        goal: "Write the second greeting.\nRUN: echo ok > hello2.txt && git add hello2.txt && git commit -qm hello2",
        done: ["hello2.txt says ok"],
        scope: ["hello2.txt"],
      }),
    )
    const ready = await settle(id)
    assert.match(ready, new RegExp(`^${id} READY`), ready)
    assert.match(ready, new RegExp(`⚠ test fails at ${start} where the task started too \\(not caused by this work\\)`), ready)
    const landed = await h.call("horde_land", { id })
    assert.match(landed, new RegExp(`^landed ${id} on master:`), landed)
    assert.match(landed, /⚠ test fails at master's tip too \(not caused by this work\)/, landed)
    assert.equal(fs.readFileSync(path.join(repo, "hello2.txt"), "utf8").trim(), "ok")
    assert.equal(fs.readFileSync(path.join(repo, "known.txt"), "utf8").trim(), "bad", "the known failure is left as it was")
    assert.equal(branches(), "")
    assert.deepEqual(baselineLeftovers(), [])
  })

  test("a new failure is still the task's, and only it is shown", async () => {
    const id = idOf(
      await h.call("horde_do", {
        goal: "Break the stubborn file again.\nRUN: echo nope > stubborn.txt && git add stubborn.txt && git commit -qm break",
        done: ["stubborn.txt says ok"],
        scope: ["stubborn.txt"],
      }),
    )
    const failed = await settle(id)
    assert.match(failed, new RegExp(`^${id} FAILED · "Break the stubborn file again" \\(checks failed after 2 round\\(s\\)\\)`), failed)
    assert.match(failed, /stubborn\.txt must say ok/, failed)
    assert.doesNotMatch(failed, /known\.txt must say ok/, failed)
    assert.equal(baselineBranches(), "")
    assert.deepEqual(baselineLeftovers(), [])
  })

  test("two READY tasks landed together never put an unchecked combination on the branch", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(
      path.join(r, "check.js"),
      `const fs = require("fs")
if (fs.existsSync("a.txt") && fs.existsSync("b.txt")) {
  console.log("TAP version 13")
  console.log("not ok 1 - a+b")
  console.log("  ---")
  console.log("  message: Error: a.txt and b.txt must not exist together")
  console.log("  ...")
  process.exit(1)
}
console.log("TAP version 13")
console.log("1..0")
`,
    )
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { test: "node check.js" } }, tiers: ["mock/mock", "mock/pricey"] }))
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    const idA = idOf(
      await h.call("horde_do", {
        directory: r,
        goal: "Write a.txt.\nRUN: echo ok > a.txt && git add a.txt && git commit -qm a",
        done: ["a.txt exists"],
        scope: ["a.txt"],
      }),
    )
    const idB = idOf(
      await h.call("horde_do", {
        directory: r,
        goal: "Write b.txt.\nRUN: echo ok > b.txt && git add b.txt && git commit -qm b",
        done: ["b.txt exists"],
        scope: ["b.txt"],
      }),
    )
    await settle(idA)
    await settle(idB)
    const [la, lb] = await Promise.all([h.call("horde_land", { id: idA }), h.call("horde_land", { id: idB })])
    const both = [la, lb]
    assert.equal(both.filter((x) => /^landed /.test(x)).length, 1, `exactly one lands:\n${both.join("\n\n")}`)
    assert.equal(
      both.filter((x) => /a\.txt and b\.txt must not exist together/.test(x)).length,
      1,
      `the other re-checks the combination:\n${both.join("\n\n")}`,
    )
    assert.equal(
      [fs.existsSync(path.join(r, "a.txt")), fs.existsSync(path.join(r, "b.txt"))].filter(Boolean).length,
      1,
      "the unchecked combination never landed",
    )
    await h.call("horde_drop", { id: /^landed /.test(la) ? idB : idA })
  })

  test("a task that carried over uncommitted changes lands only its own commits, checked as landed", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(path.join(r, "old.txt"), "stale\n")
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } }, tiers: ["mock/mock", "mock/pricey"] }))
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    fs.writeFileSync(path.join(r, "carried.txt"), "carried\n")
    const id = idOf(
      await h.call("horde_do", {
        directory: r,
        goal: "Delete old.txt.\nRUN: rm old.txt && git add -A && git commit -qm drop-old",
        done: ["old.txt is gone"],
        scope: ["old.txt"],
      }),
    )
    await settle(id)
    const landed = await h.call("horde_land", { id })
    assert.match(landed, new RegExp(`^landed ${id} on master: 1 commit\\(s\\)`), landed)
    assert.ok(!fs.existsSync(path.join(r, "old.txt")), "the task's change landed")
    assert.equal(git(r, "status", "--porcelain"), "?? carried.txt", "the user's uncommitted change stays uncommitted")
    assert.equal(git(r, "show", "--name-only", "--format=", "HEAD"), "old.txt", "only the task's own commit landed, never the carried-over change")
  })

  test("a check that writes a file during landing never puts that file on the branch", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(
      path.join(r, "horde.json"),
      JSON.stringify({
        verify: { checks: { ok: "true", land: { command: `node -e "require('fs').writeFileSync('report.xml', 'x')"`, when: "land" } } },
        tiers: ["mock/mock", "mock/pricey"],
      }),
    )
    git(r, "add", "horde.json")
    git(r, "commit", "-qm", "checks")
    const id = idOf(
      await h.call("horde_do", {
        directory: r,
        goal: "Write keep.txt.\nRUN: echo ok > keep.txt && git add keep.txt && git commit -qm keep",
        done: ["keep.txt exists"],
        scope: ["keep.txt"],
      }),
    )
    await settle(id)
    assert.match(await h.call("horde_land", { id }), new RegExp(`^landed ${id} on master: 1 commit\\(s\\)`))
    assert.ok(fs.existsSync(path.join(r, "keep.txt")))
    assert.ok(!fs.existsSync(path.join(r, "report.xml")), "the check's report.xml never landed")
    assert.equal(git(r, "status", "--porcelain"), "", "and the checkout is left clean")
  })

  test("landing onto a branch that is an ancestor of the task's base rebases and checks the work there", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } }, tiers: ["mock/mock", "mock/pricey"] }))
    git(r, "add", "horde.json")
    git(r, "commit", "-qm", "checks")
    fs.writeFileSync(path.join(r, "second.txt"), "s\n")
    git(r, "add", "second.txt")
    git(r, "commit", "-qm", "second")
    const id = idOf(
      await h.call("horde_do", {
        directory: r,
        goal: "Write anc.txt.\nRUN: echo ok > anc.txt && git add anc.txt && git commit -qm anc",
        done: ["anc.txt exists"],
        scope: ["anc.txt"],
      }),
    )
    await settle(id)
    git(r, "reset", "--hard", "HEAD~1")
    const landed = await h.call("horde_land", { id })
    assert.match(landed, new RegExp(`^landed ${id} on master: 1 commit\\(s\\)`), landed)
    assert.ok(fs.existsSync(path.join(r, "anc.txt")), "the work landed on the older branch")
    assert.ok(!fs.existsSync(path.join(r, "second.txt")), "the older branch's tree is the base, not the task's original base")
  })

  test("a rebase conflict names the conflicting files, never the user's uncommitted changes", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(path.join(r, "conflict.txt"), "base\n")
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } }, tiers: ["mock/mock", "mock/pricey"] }))
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    const id = idOf(
      await h.call("horde_do", {
        directory: r,
        goal: "Change conflict.txt to worker.\nRUN: echo worker > conflict.txt && git add -A && git commit -qm worker",
        done: ["conflict.txt says worker"],
        scope: ["conflict.txt"],
      }),
    )
    await settle(id)
    fs.writeFileSync(path.join(r, "conflict.txt"), "master\n")
    git(r, "add", "conflict.txt")
    git(r, "commit", "-qm", "master change")
    const refused = await h.call("horde_land", { id })
    assert.match(refused, /not landed: .*conflict with master in conflict\.txt/, refused)
    assert.doesNotMatch(refused, /collides with your uncommitted changes/, refused)
    await h.call("horde_drop", { id })
  })

  test("a fast-forward refused by the user's uncommitted changes names them", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } }, tiers: ["mock/mock", "mock/pricey"] }))
    git(r, "add", "horde.json")
    git(r, "commit", "-qm", "checks")
    const id = idOf(
      await h.call("horde_do", {
        directory: r,
        goal: "Write u.txt.\nRUN: echo worker > u.txt && git add u.txt && git commit -qm u",
        done: ["u.txt exists"],
        scope: ["u.txt"],
      }),
    )
    await settle(id)
    fs.writeFileSync(path.join(r, "u.txt"), "mine\n")
    const refused = await h.call("horde_land", { id })
    assert.match(refused, /collide with your uncommitted changes/, refused)
    assert.match(refused, /u\.txt/, refused)
    await h.call("horde_drop", { id })
  })

  test("after a conflict, a worker that rebased onto the target passes its next gate and lands only its own commits", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(path.join(r, "conflict.txt"), "base\n")
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } }, tiers: ["mock/mock", "mock/pricey"] }))
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    const id = idOf(
      await h.call("horde_do", {
        directory: r,
        goal: "Change conflict.txt to worker.\nRUN: echo worker > conflict.txt && git add -A && git commit -qm worker",
        done: ["conflict.txt says worker"],
        scope: ["conflict.txt"],
      }),
    )
    await settle(id)
    // Master changes the same file (a conflict) and adds one outside the worker's scope.
    fs.writeFileSync(path.join(r, "conflict.txt"), "master\n")
    fs.writeFileSync(path.join(r, "master.txt"), "out\n")
    git(r, "add", "-A")
    git(r, "commit", "-qm", "master changes")
    const tip = git(r, "rev-parse", "HEAD")
    const refused = await h.call("horde_land", { id })
    assert.match(refused, /conflict with master/, refused)
    // The worker rebases onto master, resolving the conflict in its own favour.
    await h.call("horde_tell", {
      id,
      message: "TOOL: git rebase master; echo worker > conflict.txt; git add conflict.txt; GIT_EDITOR=true git rebase --continue",
    })
    const ready = await settle(id)
    assert.match(ready, new RegExp(`^${id} READY`), ready)
    assert.doesNotMatch(ready, /outside the allowed scope/, ready)
    const landed = await h.call("horde_land", { id })
    assert.match(landed, new RegExp(`^landed ${id} on master: 1 commit\\(s\\)`), landed)
    assert.equal(git(r, "rev-list", "--count", `${tip}..HEAD`), "1", "only the worker's commit landed, no empty duplicates of master's")
    assert.equal(git(r, "show", "--name-only", "--format=", "HEAD"), "conflict.txt", "and it only touches the worker's file")
  })

  test("the same after a conflict with a carried-over baseline: the baseline is still never landed", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(path.join(r, "conflict.txt"), "base\n")
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } }, tiers: ["mock/mock", "mock/pricey"] }))
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    // Carried over as the worktree's baseline.
    fs.writeFileSync(path.join(r, "carried.txt"), "carried\n")
    const id = idOf(
      await h.call("horde_do", {
        directory: r,
        goal: "Change conflict.txt to worker.\nRUN: echo worker > conflict.txt && git add -A && git commit -qm worker",
        done: ["conflict.txt says worker"],
        scope: ["conflict.txt"],
      }),
    )
    await settle(id)
    fs.writeFileSync(path.join(r, "conflict.txt"), "master\n")
    fs.writeFileSync(path.join(r, "master.txt"), "out\n")
    git(r, "add", "conflict.txt", "master.txt")
    git(r, "commit", "-qm", "master changes")
    const refused = await h.call("horde_land", { id })
    assert.match(refused, /conflict with master/, refused)
    await h.call("horde_tell", {
      id,
      message: "TOOL: git rebase master; echo worker > conflict.txt; git add conflict.txt; GIT_EDITOR=true git rebase --continue",
    })
    const ready = await settle(id)
    assert.match(ready, new RegExp(`^${id} READY`), ready)
    const landed = await h.call("horde_land", { id })
    assert.match(landed, new RegExp(`^landed ${id} on master: 1 commit\\(s\\)`), landed)
    assert.equal(git(r, "show", "--name-only", "--format=", "HEAD"), "conflict.txt", "the carried-over baseline never landed")
    assert.equal(git(r, "status", "--porcelain"), "?? carried.txt", "the carried-over change stays uncommitted in the checkout")
  })

  test("a workers.land command's file is committed on top and landed, judged by the checks", async () => {
    const { tmp: at, repo: r } = makeRepo(mock.url)
    const marker = path.join(at, "land-check.ran")
    // The land command writes the rebased HEAD's subject; the land check asserts it is the worker's.
    fs.writeFileSync(
      path.join(r, "horde.json"),
      JSON.stringify({
        verify: {
          checks: {
            ok: "true",
            land: {
              command: `node -e "require('fs').readFileSync('generated.txt','utf8').trim()==='worker'||process.exit(1);require('fs').writeFileSync(process.argv[1],'ran')" ${JSON.stringify(marker)}`,
              when: "land",
            },
          },
        },
        workers: { land: { command: "git log -1 --format=%s > generated.txt", message: "chore: generated" } },
        tiers: ["mock/mock", "mock/pricey"],
      }),
    )
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    const id = idOf(
      await h.call("horde_do", {
        directory: r,
        goal: "Write worker.txt.\nRUN: echo ok > worker.txt && git add worker.txt && git commit -qm worker",
        done: ["worker.txt exists"],
        scope: ["worker.txt"],
      }),
    )
    await settle(id)
    // Master moves so the landing actually rebases the worker's commit onto a new tip.
    fs.writeFileSync(path.join(r, "master.txt"), "m\n")
    git(r, "add", "master.txt")
    git(r, "commit", "-qm", "master moves")
    const landed = await h.call("horde_land", { id })
    assert.match(landed, new RegExp(`^landed ${id} on master: 2 commit\\(s\\)`), landed)
    assert.ok(fs.existsSync(marker), "the land check ran and passed")
    assert.equal(fs.readFileSync(path.join(r, "generated.txt"), "utf8").trim(), "worker", "the command's file landed")
    assert.equal(git(r, "log", "-1", "--format=%s"), "chore: generated", "the land commit has the configured message")
  })

  test("a failed land check leaves the worker's branch without the workers.land commit or its files", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(
      path.join(r, "horde.json"),
      JSON.stringify({
        verify: {
          checks: {
            test: `node -e "const fs=require('fs'); if (fs.existsSync('worker.txt') && fs.existsSync('generated.txt')) { console.log('TAP version 13'); console.log('not ok 1 - both'); console.log('  ---'); console.log('  message: Error: worker.txt and generated.txt must not exist together'); console.log('  ...'); process.exit(1) }"`,
          },
        },
        workers: { land: "node -e \"require('fs').writeFileSync('generated.txt', 'x')\"" },
        tiers: ["mock/mock", "mock/pricey"],
      }),
    )
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    const started = await h.call("horde_do", {
      directory: r,
      goal: "Write worker.txt.\nRUN: echo ok > worker.txt && git add worker.txt && git commit -qm worker",
      done: ["worker.txt exists"],
      scope: ["worker.txt"],
    })
    const id = idOf(started)
    const branch = started.match(/worktree (horde\/[\w-]+)/)![1]!
    await settle(id)
    const refused = await h.call("horde_land", { id })
    assert.match(refused, /^not landed: .*'s commits fail the checks on top of master:/, refused)
    assert.equal(git(r, "log", "-1", "--format=%s", branch), "worker", "the workers.land commit is gone from the branch")
    assert.ok(!git(r, "show", "--name-only", "--format=", branch).split("\n").includes("generated.txt"), "nor the file it wrote")
    await h.call("horde_drop", { id })
  })

  test("a failed workers.land command leaves the worker's branch without its files", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(
      path.join(r, "horde.json"),
      JSON.stringify({
        verify: { checks: { test: "true" } },
        workers: { land: "node -e \"require('fs').writeFileSync('generated.txt', 'x'); process.exit(1)\"" },
        tiers: ["mock/mock", "mock/pricey"],
      }),
    )
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    const started = await h.call("horde_do", {
      directory: r,
      goal: "Write worker.txt.\nRUN: echo ok > worker.txt && git add worker.txt && git commit -qm worker",
      done: ["worker.txt exists"],
      scope: ["worker.txt"],
    })
    const id = idOf(started)
    const branch = started.match(/worktree (horde\/[\w-]+)/)![1]!
    const ready = await settle(id)
    const worktree = ready.match(/diff: git -C (\S+) diff/)![1]!
    const refused = await h.call("horde_land", { id })
    assert.match(refused, /^not landed: .*workers\.land step failed/, refused)
    assert.equal(git(r, "log", "-1", "--format=%s", branch), "worker", "the worker's branch keeps only its own work")
    assert.ok(!fs.existsSync(path.join(worktree, "generated.txt")), "the command's file was not kept in the worktree")
    await h.call("horde_drop", { id })
  })
})

describe("the gate review runs outside the worker limit and its failure fails the task", { timeout: 600_000 }, () => {
  let rv: Harness
  let rvmock: Mock
  let rvrepo: string
  let rvtmp: string

  const rid = (text: string) => text.match(/\bt-[0-9a-f]+\b/)![0]
  const rrepo = (check: string, tiers: string[]): string => {
    const { repo } = makeRepo(rvmock.url, { permission: { bash: "allow" } })
    fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify({ verify: { checks: { test: check } }, tiers }))
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "checks")
    return repo
  }
  const rsettle = async (id: string, seconds = 180): Promise<string> => {
    for (;;) {
      const out = await rv.call("horde_wait", { ids: [id], timeout_seconds: seconds })
      if (/ NEEDS YOU /.test(out)) {
        await rv.call("horde_tell", { id, approve: true })
        continue
      }
      return out
    }
  }

  before(async () => {
    rvmock = await startMockLlm()
    ;({ tmp: rvtmp, repo: rvrepo } = makeRepo(rvmock.url))
    rv = await connect({ ...isolatedEnv(rvtmp, rvrepo), HORDE_OPENCODE_MAX_RUNNING: "1" })
  })

  after(async () => {
    await rv?.call("opencode_server", { action: "stop" }).catch(() => undefined)
    await rv?.close()
    rvmock?.close()
  })

  test("a task's review still runs (and judges it) when the running limit is full", async () => {
    const dir = rrepo(`node -e "setTimeout(() => process.exit(0), 5000)"`, ["mock/mock", "mock/pricey"])
    const started = await rv.call("horde_do", {
      directory: dir,
      goal: "Write the greeting file.\nRUN: echo ok > hello.txt && git add hello.txt && git commit -qm hello",
      done: ["hello.txt says ok"],
      scope: ["hello.txt"],
    })
    const id = rid(started)
    // The worker finishes and its gate starts the (slow) checks; the idle worker holds no slot.
    await until(async () => /gate: running checks/.test(await rv.call("opencode_status", { ids: [id] })), 90_000, 100)
    // Fill the single running slot while the checks run.
    await rv.call("opencode_spawn", { prompt: "SLOW hog one", name: "review-hog" })
    const ready = await rsettle(id)
    assert.match(ready, new RegExp(`^${id} READY`), ready)
    assert.match(ready, /review: 1 of 1 criteria met/, ready)
    await rv.call("opencode_interrupt", { id: "review-hog" })
  })

  test("a reviewer that errors twice fails the task, saying the review could not run", async () => {
    // The reviewer is the cheapest tier model other than the worker's; make that model broken.
    const dir = rrepo(`node -e "process.exit(0)"`, ["mock/mock", "broken/model"])
    const started = await rv.call("horde_do", {
      directory: dir,
      goal: "Write the greeting file.\nRUN: echo ok > hello.txt && git add hello.txt && git commit -qm hello",
      done: ["hello.txt says ok"],
      scope: ["hello.txt"],
    })
    const id = rid(started)
    const failed = await rsettle(id, 300)
    assert.match(failed, new RegExp(`^${id} FAILED`), failed)
    assert.doesNotMatch(failed, /READY/)
    assert.match(failed, /review could not run/, failed)
    assert.match(failed, /Cannot initialize broken\/model/, failed)
    assert.match(failed, /horde_tell \{id: "t-\w+", message: "Run the review again"\}/, failed)
  })

  test("a criterion judged not met on the last round fails the task, naming it", async () => {
    const dir = rrepo(`node -e "process.exit(0)"`, ["mock/mock", "mock/pricey"])
    const started = await rv.call("horde_do", {
      directory: dir,
      goal: "Write the greeting file.\nRUN: echo ok > hello.txt && git add hello.txt && git commit -qm hello",
      done: ["hello.txt says ok", "nothing else changes", "third.txt says ok"],
      scope: ["hello.txt"],
    })
    const id = rid(started)
    const failed = await rsettle(id)
    assert.match(failed, new RegExp(`^${id} FAILED`), failed)
    assert.match(failed, /1 criterion not met/, failed)
    assert.match(failed, /third\.txt says ok/, failed)
  })

  test("a fix round that errors reports the error, not the round count", async () => {
    // The check fails with a message that makes the fix round's prompt a provider error.
    const dir = rrepo(`node -e "console.log('Error: FAIL400'); process.exit(1)"`, ["mock/mock", "mock/pricey"])
    const started = await rv.call("horde_do", {
      directory: dir,
      goal: "Write the result file.\nRUN: echo ok > result.txt && git add result.txt && git commit -qm result",
      done: ["result.txt says ok"],
      scope: ["result.txt"],
    })
    const id = rid(started)
    const failed = await rsettle(id)
    assert.match(failed, new RegExp(`^${id} FAILED`), failed)
    assert.match(failed, /error: bad request from mock/, failed)
    assert.doesNotMatch(failed, /checks failed after/, failed)
  })
})

describe("horde_investigate: read-only workers that answer with a checked report", { timeout: 600_000 }, () => {
  let iv: Harness
  let ivmock: Mock
  let ivrepo: string
  let ivtmp: string
  const boardState = () => path.join(ivtmp, "board-state")
  const iid = (text: string) => text.match(/\bt-[0-9a-f]+\b/)![0]

  before(async () => {
    ivmock = await startMockLlm()
    ;({ tmp: ivtmp, repo: ivrepo } = makeRepo(ivmock.url))
    fs.writeFileSync(path.join(ivrepo, "horde.json"), JSON.stringify({ tiers: ["mock/mock", "mock/pricey"] }))
    fs.writeFileSync(path.join(ivrepo, "greeting.txt"), "hello\n")
    git(ivrepo, "add", ".")
    git(ivrepo, "commit", "-qm", "base")
    iv = await connect({ ...isolatedEnv(ivtmp, ivrepo), HORDE_BOARD_STATE_DIR: boardState() })
  })

  after(async () => {
    await iv?.call("opencode_server", { action: "stop" }).catch(() => undefined)
    await iv?.close()
    ivmock?.close()
  })

  test("a valid JSON answer becomes a REPORT, listed by default, and its worktree is discarded", async () => {
    const findings = [
      { title: "greeting present", severity: "info", file: "greeting.txt", line: 1, evidence: "ran grep hello greeting.txt", confidence: "high" },
      { title: "a critical bug", severity: "critical", file: "greeting.txt", line: 1, evidence: "ran grep hello greeting.txt", confidence: "high" },
    ]
    const question = `Find the greeting.\nJSON: ${JSON.stringify({ summary: "the greeting is in greeting.txt", findings })}`
    const started = await iv.call("horde_investigate", { question, want: ["which file has the greeting"], focus: ["greeting.txt"] })
    assert.match(started, /^t-\w+ investigating: "Find the greeting" · mock\/mock \(tier 0 of 2\) · worktree horde\/t-\w+/, started)
    assert.doesNotMatch(started, /checked by:/, started)
    const id = iid(started)

    // horde_wait with no ids lists the investigation by default.
    const report = await iv.call("horde_wait", { timeout_seconds: 120 })
    assert.match(report, new RegExp(`^${id} REPORT · "Find the greeting"`), report)
    assert.match(report, /the greeting is in greeting\.txt/, report)
    assert.match(report, /findings \(2\):/, report)
    assert.ok(report.indexOf("[critical]") < report.indexOf("[info]"), `severity order:\n${report}`)
    assert.match(report, /greeting\.txt:1 · high · ✓ cited/, report)
    const reportFile = report.match(/full report: (\S+)/)![1]!
    assert.ok(fs.existsSync(reportFile), reportFile)
    const saved = JSON.parse(fs.readFileSync(reportFile, "utf8"))
    assert.equal(saved.task, id)
    assert.equal(saved.findings[0].severity, "critical")
    assert.equal(saved.findings[0].cite, "✓ cited")

    // Done on the board, worktree and branch removed, and nothing lands.
    assert.equal((await Board.open(ivrepo, boardState())).task(id).status, "done")
    assert.equal(git(ivrepo, "branch", "--list", "horde/*"), "")
    await assert.rejects(iv.call("horde_land", { id }), /finished investigation/)
  })

  test("a finding citing a missing file or a line past its end is marked", async () => {
    const findings = [
      { title: "ghost", severity: "medium", file: "nope.txt", line: 1, evidence: "ran ls", confidence: "low" },
      { title: "too deep", severity: "high", file: "greeting.txt", line: 99, evidence: "ran wc -l", confidence: "medium" },
    ]
    const id = iid(await iv.call("horde_investigate", { question: `Check the files.\nJSON: ${JSON.stringify({ summary: "two broken citations", findings })}` }))
    const report = await iv.call("horde_wait", { ids: [id], timeout_seconds: 120 })
    assert.match(report, /nope\.txt not found/, report)
    assert.match(report, /line 99 past end \(1 line\)/, report)
  })

  test("an answer that never becomes valid JSON is FAILED with its tail", async () => {
    const id = iid(await iv.call("horde_investigate", { question: "Find the bug. JSON-NEVER" }))
    const failed = await iv.call("horde_wait", { ids: [id], timeout_seconds: 120 })
    assert.match(failed, new RegExp(`^${id} FAILED · "Find the bug" \\(the answer never became valid JSON\\)`), failed)
    assert.match(failed, /still prose/, failed)
    assert.doesNotMatch(failed, /REPORT/, failed)
  })
})
