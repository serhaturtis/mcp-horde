import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { Board } from "@mcp-horde/board"
import { connect, git, type Harness, isolatedEnv, type Mock, makeRepo } from "./harness.js"
import { startMockLlm } from "./mock-llm.js"

// The simple path the way an agent that has never seen the horde uses it: horde_do, horde_wait,
// horde_land, and horde_tell / horde_drop when something goes wrong.

// The project's one check: every .txt file says "ok" (a hint fixes it, except for stubborn.txt),
// and the guard file a test commits to master breaks it.
const CHECK = `const fs = require("fs")
for (const f of fs.readdirSync(".").filter((f) => f.endsWith(".txt"))) {
  if (fs.readFileSync(f, "utf8").trim() === "ok") continue
  console.log("Error: " + f + " must say ok." + (f === "stubborn.txt" ? "" : " TOOL: echo ok > " + f + " && git add -A && git commit -qm fix"))
  process.exit(1)
}
if (fs.existsSync("broken.flag")) {
  console.log("Error: broken.flag exists")
  process.exit(1)
}
`

let h: Harness
let mock: Mock
let repo: string
let tmp: string
const boardState = () => path.join(tmp, "board-state")
const idOf = (text: string) => text.match(/\bt-[0-9a-f]+\b/)![0]
const branches = () => git(repo, "branch", "--list", "horde/*")

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
    const landed = await h.call("horde_land", { id })
    assert.match(
      landed,
      new RegExp(`^landed ${id} on master: 1 commit\\(s\\) · checks ✓ test on master's tip before updating it · task done, worktree and branch removed`),
      landed,
    )
    assert.equal(fs.readFileSync(path.join(repo, "hello.txt"), "utf8").trim(), "ok")
    assert.equal(git(repo, "rev-parse", "HEAD~1"), before, "exactly the worker's commit, on top of master")
    assert.equal(branches(), "", "the merged branch is gone")
    const board = await Board.open(repo, boardState())
    assert.equal(board.task(id).status, "done")
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
    // Master moves on, in a way that only fails together with the worker's change... or at all.
    fs.writeFileSync(path.join(repo, "broken.flag"), "x")
    git(repo, "add", "broken.flag")
    git(repo, "commit", "-qm", "master moves on")
    const head = git(repo, "rev-parse", "HEAD")
    const refused = await h.call("horde_land", { id })
    assert.match(refused, new RegExp(`^not landed: ${id}'s commits fail the checks on top of master:`), refused)
    assert.match(refused, /broken\.flag exists/)
    assert.match(refused, /master is unchanged; the worker is now on top of it\./)
    assert.equal(git(repo, "rev-parse", "HEAD"), head, "master did not move")
    assert.ok(!fs.existsSync(path.join(repo, "third.txt")))
    // Fixed on master: the same task lands now (its verdict stands; the landing re-checks).
    git(repo, "rm", "-q", "broken.flag")
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

  test("horde_drop closes a task whose worker never started", async () => {
    const board = await Board.open(repo, boardState())
    const [task] = (await board.plan([{ title: "Stale claim", goal: "Never started.", acceptance: [], scope: [] }])).tasks
    const dropped = await h.call("horde_drop", { id: task!.id, reason: "stale" })
    assert.match(dropped, new RegExp(`^dropped ${task!.id}: it had no worker`), dropped)
    assert.equal((await Board.open(repo, boardState())).task(task!.id).status, "failed")
    await assert.rejects(h.call("horde_drop", { id: "t-0000" }), /unknown agent/)
  })
})
