import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { Board } from "@mcp-horde/board"
import { logDirFor } from "@mcp-horde/verify"
import { git, type Harness, type Mock, makeRepo } from "./harness.js"
import { createHordeEnv, type HordeEnv } from "./horde-support.js"

// The simple path the way an agent that has never seen the horde uses it: horde_do, horde_wait,
// horde_land, and horde_tell / horde_drop when something goes wrong.

describe("the simple path: horde_do, horde_wait, horde_land (real opencode, mock LLM)", { timeout: 600_000 }, () => {
  let env: HordeEnv
  let h: Harness
  let mock: Mock
  let repo: string
  let tmp: string
  let boardState: () => string
  let idOf: (text: string) => string
  let branches: () => string
  let baselineBranches: () => string
  let baselineLeftovers: () => string[]
  let settle: (id: string) => Promise<string>

  before(async () => {
    env = await createHordeEnv()
    ;({ h, mock, repo, tmp, boardState, idOf, branches, baselineBranches, baselineLeftovers, settle } = env)
  })

  after(async () => {
    await env.close()
  })

  test("three calls: delegate, collect a checked and reviewed outcome, land it", async () => {
    const started = await h.call("horde_do", {
      goal: "Write the greeting file.\nRUN: echo ok > hello.txt && git add hello.txt && git commit -qm hello",
      done: ["hello.txt says ok", "nothing else changes"],
      scope: ["hello.txt"],
    })
    assert.match(started, /^t-\w+ working: "Write the greeting file" · mock\/mock \(tier 0 of 2\) · worktree horde\/t-\w+/, started)
    assert.match(started, /scope: hello\.txt/)
    assert.match(
      started,
      /checked by: check test \(node check\.js · cwd: \. · env: none\) · the tests related to the change after each round, every check before landing/,
    )
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
      /checks ✓ test · review: 1 of 2 criteria met, 1 unproven \(by mock\/pricey\) · ⚠ the worker's report names a\.ts, b\.ts, a\.test\.ts, which its diff does not touch/,
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

  test("a by-hand rebase in the worktree lands a conflict's commit with no new gate round", async () => {
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
    const tip = git(r, "rev-parse", "HEAD")
    const refused = await h.call("horde_land", { id })
    assert.match(refused, /conflict with master in conflict\.txt/, refused)
    // The answer names the worktree root and the exact by-hand commands, beside horde_tell and horde_drop.
    const root = refused.match(/git -C (\S+) rebase master/)![1]!
    assert.match(refused, /resolve it yourself: git -C \S+ rebase master, fix conflict\.txt, git -C \S+ rebase --continue/, refused)
    assert.match(refused, /horde_tell .*a fresh gate round, then horde_land again/, refused)
    assert.match(refused, /horde_drop/, refused)
    assert.doesNotMatch(refused, /carried-over baseline/, refused)
    // The orchestrator resolves it by hand in the worker's worktree: the rebase stops on the
    // conflict (git exits non-zero), so catch it and resolve.
    try {
      git(root, "-c", "core.editor=true", "rebase", "master")
    } catch {
      // expected: the rebase stopped on the conflict
    }
    fs.writeFileSync(path.join(root, "conflict.txt"), "worker\n")
    git(root, "add", "conflict.txt")
    git(root, "-c", "core.editor=true", "rebase", "--continue")
    // No new gate round: the landing re-checks the result and fast-forwards the one commit.
    const landed = await h.call("horde_land", { id })
    assert.match(landed, new RegExp(`^landed ${id} on master: 1 commit\\(s\\)`), landed)
    assert.equal(git(r, "rev-list", "--count", `${tip}..HEAD`), "1", "only the worker's commit landed, no empty duplicates of master's")
    assert.equal(git(r, "show", "--name-only", "--format=", "HEAD"), "conflict.txt", "and it only touches the worker's file")
  })

  test("work already cherry-picked onto master is recognised and closed without an empty commit", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } }, tiers: ["mock/mock", "mock/pricey"] }))
    git(r, "add", "horde.json")
    git(r, "commit", "-qm", "checks")
    const started = await h.call("horde_do", {
      directory: r,
      goal: "Write cherry.txt.\nRUN: echo ok > cherry.txt && git add cherry.txt && git commit -qm cherry",
      done: ["cherry.txt says ok"],
      scope: ["cherry.txt"],
    })
    const id = idOf(started)
    const branch = started.match(/worktree (horde\/[\w-]+)/)![1]!
    await settle(id)
    const before = git(r, "rev-parse", "HEAD")
    // The orchestrator lands the worker's commit by hand: cherry-pick it onto master.
    git(r, "cherry-pick", git(r, "rev-parse", branch))
    assert.equal(git(r, "rev-list", "--count", `${before}..HEAD`), "1", "master now has the worker's change")
    const landed = await h.call("horde_land", { id })
    assert.match(
      landed,
      new RegExp(`^${id}'s 1 commit\\(s\\) are already on master \\(patch-identical\\): nothing to land · task done, worktree and branch removed`),
      landed,
    )
    assert.equal(git(r, "rev-list", "--count", `${before}..HEAD`), "1", "no empty commit was added on top of the cherry-pick")
    assert.equal(git(r, "branch", "--list", "horde/*"), "", "the branch is gone")
    assert.equal((await Board.open(r, boardState())).task(id).status, "done")
  })

  test("only some commits already on master are refused before rebasing, naming both sets", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } }, tiers: ["mock/mock", "mock/pricey"] }))
    git(r, "add", "horde.json")
    git(r, "commit", "-qm", "checks")
    const before = git(r, "rev-parse", "HEAD")
    const started = await h.call("horde_do", {
      directory: r,
      goal: "Write two files.\nRUN: echo one > one.txt && git add one.txt && git commit -qm one\nRUN: echo two > two.txt && git add two.txt && git commit -qm two",
      done: ["one.txt and two.txt say ok"],
      scope: ["one.txt", "two.txt"],
    })
    const id = idOf(started)
    const branch = started.match(/worktree (horde\/[\w-]+)/)![1]!
    await settle(id)
    const [first] = git(r, "rev-list", "--reverse", `${before}..${branch}`).split("\n")
    // The orchestrator cherry-picks only the first of the worker's two commits.
    git(r, "cherry-pick", first!)
    assert.equal(git(r, "rev-list", "--count", `${before}..HEAD`), "1", "master now has the first commit")
    const refused = await h.call("horde_land", { id })
    assert.match(
      refused,
      new RegExp(`^not landed: 1 of 2 commits of ${id} are already on master; landing the rest would replay those 1 as empty commits\\.`),
      refused,
    )
    assert.match(refused, /already on master: \w+ one/, refused)
    assert.match(refused, /not on master: \w+ two/, refused)
    assert.match(refused, new RegExp(`horde_drop \\{id: "${id}", landed: true\\}`), refused)
    assert.equal(git(r, "rev-list", "--count", `${before}..HEAD`), "1", "master did not move further")
    assert.equal(git(r, "rev-list", "--count", `${before}..${branch}`), "2", "the worker's branch was not rebased")
    await h.call("horde_drop", { id })
  })

  test("horde_drop {landed: true} records the attempt as accepted, not failed", async () => {
    const id = idOf(
      await h.call("horde_do", {
        goal: "Write the dropped file.\nRUN: echo ok > dropped.txt && git add dropped.txt && git commit -qm dropped",
        done: ["dropped.txt says ok"],
        scope: ["dropped.txt"],
      }),
    )
    await settle(id)
    const dropped = await h.call("horde_drop", { id, reason: "cherry-picked it myself", landed: true })
    assert.match(dropped, new RegExp(`^${id} landed by hand: the attempt is recorded as accepted, its worktree and branch are removed`), dropped)
    const task = (await Board.open(repo, boardState())).task(id)
    assert.equal(task.status, "done")
    const attempt = task.attempts.at(-1)!
    assert.equal(attempt.outcome, "accepted")
    assert.equal(attempt.note, "landed by hand: cherry-picked it myself")
  })
})
