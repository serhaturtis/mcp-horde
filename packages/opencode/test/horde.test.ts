import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { Board } from "@mcp-horde/board"
import { logDirFor } from "@mcp-horde/verify"
import { connect, git, type Harness, isolatedEnv, type Mock, makeRepo } from "./harness.js"
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
    assert.equal(git(hooked, "rev-parse", branch), workerHead, "the worker's branch is back where it was")
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
})
