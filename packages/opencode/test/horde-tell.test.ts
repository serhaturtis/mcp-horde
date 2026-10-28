import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { Board } from "@mcp-horde/board"
import { git, type Harness, type Mock, makeRepo } from "./harness.js"
import { createHordeEnv, type HordeEnv } from "./horde-support.js"

// The simple path the way an agent that has never seen the horde uses it: horde_do, horde_wait,
// horde_land, and horde_tell / horde_drop when something goes wrong.

describe("the simple path: horde_do, horde_wait, horde_land (real opencode, mock LLM)", { timeout: 600_000 }, () => {
  let env: HordeEnv
  let h: Harness
  let mock: Mock
  let repo: string
  let boardState: () => string
  let idOf: (text: string) => string
  let branches: () => string
  let settle: (id: string) => Promise<string>

  before(async () => {
    env = await createHordeEnv()
    ;({ h, mock, repo, boardState, idOf, branches, settle } = env)
  })

  after(async () => {
    await env.close()
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

  test("horde_tell with done replaces the done-criteria and the worker is told them", async () => {
    const id = idOf(
      await h.call("horde_do", {
        goal: "Write the greeting file.\nRUN: echo ok > greet.txt && git add greet.txt && git commit -qm greet",
        done: ["greet.txt says ok", "a second criterion", "a third criterion"],
        scope: ["greet.txt"],
      }),
    )
    const failed = await settle(id)
    assert.match(failed, new RegExp(`^${id} FAILED`), failed)
    assert.match(failed, /a third criterion/, failed)
    const told = await h.call("horde_tell", {
      id,
      message: "The work is finished; keep it as it is.",
      done: ["greet.txt says ok"],
    })
    assert.match(told, /its done-criteria are now: 1\. greet\.txt says ok/, told)
    assert.deepEqual((await Board.open(repo, boardState())).task(id).acceptance, ["greet.txt says ok"])
    // The worker's next turn carries the new criteria in the message it received.
    assert.match(await h.call("opencode_output", { id, scope: "all" }), /Your task's done-criteria changed; they are now:\n1\. greet\.txt says ok/)
    const ready = await settle(id)
    assert.match(ready, new RegExp(`^${id} READY`), ready)
    assert.match(ready, /review: 1 of 1 criteria met \(by mock\/pricey\)/, ready)
    await h.call("horde_drop", { id })
  })

  test("horde_tell with done alone re-judges a review-failed task under the new criteria", async () => {
    const id = idOf(
      await h.call("horde_do", {
        goal: "Write the second greeting.\nRUN: echo ok > greet2.txt && git add greet2.txt && git commit -qm greet2",
        done: ["greet2.txt says ok", "another criterion", "one more criterion"],
        scope: ["greet2.txt"],
      }),
    )
    const failed = await settle(id)
    assert.match(failed, new RegExp(`^${id} FAILED`), failed)
    assert.match(failed, /one more criterion/, failed)
    const told = await h.call("horde_tell", { id, done: ["greet2.txt says ok"] })
    assert.match(told, /its done-criteria are now: 1\. greet2\.txt says ok/, told)
    assert.match(told, /re-checking the finished work under the new done-criteria/, told)
    assert.deepEqual((await Board.open(repo, boardState())).task(id).acceptance, ["greet2.txt says ok"])
    // The same work is judged again: horde_wait reports a new outcome, READY under the new criteria.
    const ready = await settle(id)
    assert.match(ready, new RegExp(`^${id} READY`), ready)
    assert.match(ready, /review: 1 of 1 criteria met/, ready)
    await h.call("horde_drop", { id })
  })

  test("horde_tell with done alone re-judges a READY task under the new criteria", async () => {
    const id = idOf(
      await h.call("horde_do", {
        goal: "Write the passing file.\nRUN: echo ok > passed.txt && git add passed.txt && git commit -qm passed",
        done: ["passed.txt says ok"],
        scope: ["passed.txt"],
      }),
    )
    assert.match(await settle(id), new RegExp(`^${id} READY`))
    const told = await h.call("horde_tell", {
      id,
      done: ["passed.txt says ok", "a second criterion", "a third criterion"],
    })
    assert.match(told, /its done-criteria are now: 1\. passed\.txt says ok 2\. a second criterion 3\. a third criterion/, told)
    assert.match(told, /re-checking the finished work under the new done-criteria/, told)
    assert.deepEqual((await Board.open(repo, boardState())).task(id).acceptance, ["passed.txt says ok", "a second criterion", "a third criterion"])
    // The earlier READY does not stand: the same work is judged again under the new criteria.
    const again = await settle(id)
    assert.doesNotMatch(again, new RegExp(`^${id} READY`), again)
    assert.match(again, new RegExp(`^${id} FAILED`), again)
    assert.match(again, /a third criterion/, again)
    await h.call("horde_drop", { id })
  })

  test("horde_tell refuses done with no criteria and the 'nothing to tell' error names it", async () => {
    const id = idOf(
      await h.call("horde_do", {
        goal: "Write the empty file.\nRUN: echo ok > empty.txt && git add empty.txt && git commit -qm empty",
        done: ["empty.txt says ok"],
        scope: ["empty.txt"],
      }),
    )
    assert.match(await settle(id), new RegExp(`^${id} READY`))
    await assert.rejects(h.call("horde_tell", { id, done: [] }), /done needs at least one criterion/)
    assert.deepEqual((await Board.open(repo, boardState())).task(id).acceptance, ["empty.txt says ok"])
    await assert.rejects(h.call("horde_tell", { id }), /nothing to tell: pass message, approve, model, scope or done/)
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
    assert.ok(
      refused.includes(
        'The first commit, "horde: uncommitted changes carried over from the main checkout", is the carried-over baseline; leave it as it is, it never lands.',
      ),
      refused,
    )
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

  test("a by-hand rebase with a carried-over baseline replays it first and lands only the worker's commit", async () => {
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
    git(r, "add", "conflict.txt")
    git(r, "commit", "-qm", "master change")
    const tip = git(r, "rev-parse", "HEAD")
    const refused = await h.call("horde_land", { id })
    assert.match(refused, /conflict with master/, refused)
    const root = refused.match(/git -C (\S+) rebase master/)![1]!
    // The by-hand rebase replays the baseline first; the worker's commit conflicts after it.
    try {
      git(root, "-c", "core.editor=true", "rebase", "master")
    } catch {
      // expected: the rebase stopped on the conflict
    }
    fs.writeFileSync(path.join(root, "conflict.txt"), "worker\n")
    git(root, "add", "conflict.txt")
    git(root, "-c", "core.editor=true", "rebase", "--continue")
    assert.deepEqual(git(root, "log", "--reverse", "--format=%s", `${tip}..HEAD`).split("\n"), [
      "horde: uncommitted changes carried over from the main checkout",
      "worker",
    ])
    const landed = await h.call("horde_land", { id })
    assert.match(landed, new RegExp(`^landed ${id} on master: 1 commit\\(s\\)`), landed)
    assert.equal(git(r, "rev-list", "--count", `${tip}..HEAD`), "1", "only the worker's commit landed")
    assert.equal(git(r, "show", "--name-only", "--format=", "HEAD"), "conflict.txt", "the carried-over baseline never landed")
    assert.equal(git(r, "status", "--porcelain"), "?? carried.txt", "the carried-over change stays uncommitted in the checkout")
  })

  test("a scope change alone re-checks a task the audit failed for an out-of-scope file", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } }, tiers: ["mock/mock", "mock/pricey"] }))
    git(r, "add", "horde.json")
    git(r, "commit", "-qm", "checks")
    const started = await h.call("horde_do", {
      directory: r,
      goal: "Write b.txt.\nRUN: echo ok > b.txt && git add b.txt && git commit -qm b",
      done: ["b.txt says ok"],
      scope: ["a.txt"],
    })
    const id = idOf(started)
    const failed = await settle(id)
    assert.match(failed, new RegExp(`^${id} FAILED`), failed)
    assert.match(failed, /outside the allowed scope/, failed)
    // The FAILED outcome suggests a scope change, naming the out-of-scope file.
    assert.match(failed, /scope: \[\.\.\.\]\} to allow b\.txt/, failed)
    // Other audit categories get no binaries hint.
    assert.doesNotMatch(failed, /"warn": \["binaries"\]/, failed)
    // Telling it the new scope with no message re-runs the gate under it: a fresh outcome, then READY.
    assert.match(await h.call("horde_tell", { id, scope: ["a.txt", "b.txt"] }), /re-checking the finished work under the new scope/)
    const ready = await settle(id)
    assert.match(ready, new RegExp(`^${id} READY`), ready)
    assert.match(await h.call("horde_land", { id }), /^landed t-\w+ on master: 1 commit\(s\)/)
    assert.equal(fs.readFileSync(path.join(r, "b.txt"), "utf8").trim(), "ok")
  })

  test("the FAILED outcome says how a binary deliverable stops blocking the audit", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } }, tiers: ["mock/mock", "mock/pricey"] }))
    git(r, "add", "horde.json")
    git(r, "commit", "-qm", "checks")
    const started = await h.call("horde_do", {
      directory: r,
      goal: `Write the icon.\nRUN: mkdir -p docs && node -e "require('fs').writeFileSync('docs/icon.png', Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00,0x01,0x02,0x03]))" && git add -A && git commit -qm icon`,
      done: ["docs/icon.png is the icon"],
      scope: ["docs/**"],
    })
    const id = idOf(started)
    const failed = await settle(id)
    assert.match(failed, new RegExp(`^${id} FAILED`), failed)
    assert.match(failed, /binaries: docs\/icon\.png adds or changes a binary file/, failed)
    // The audit's binaries category blocks by default; the outcome names the file and the rule that changes it.
    assert.match(failed, /the audit blocks added or changed binaries and files over 1 MB by default: docs\/icon\.png/, failed)
    assert.match(failed, /"warn": \["binaries"\]/, failed)
    assert.match(failed, /"generated": \["<globs>"\]/, failed)
    assert.match(failed, /"off": \["binaries"\]/, failed)
    assert.match(failed, new RegExp(`horde_tell \\{id: "${id}", message: "Run your checks again"\\}`), failed)
    await h.call("horde_drop", { id })
  })

  test("the FAILED outcome keeps a scope hint when a long check failure trims it from the verdict", async () => {
    const { repo: r } = makeRepo(mock.url)
    // Twelve TAP failures are more than the verdict's 1500-character budget, so its optional
    // audit lines are dropped; the hint must come from the stored findings instead.
    fs.writeFileSync(
      path.join(r, "noisy.js"),
      `const fs = require("fs")
console.log("TAP version 13")
if (!fs.existsSync("b.txt")) {
  console.log("1..0")
} else {
  for (let i = 0; i < 12; i++) {
    console.log("not ok " + (i + 1) + " - case " + i)
    console.log("  ---")
    console.log("  message: " + "x".repeat(300))
    console.log("  ...")
  }
  process.exitCode = 1
}
`,
    )
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { test: "node noisy.js" } }, tiers: ["mock/mock"] }))
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    const id = idOf(
      await h.call("horde_do", {
        directory: r,
        goal: "Write b.txt.\nRUN: echo ok > b.txt && git add b.txt && git commit -qm b",
        done: ["b.txt says ok"],
        scope: ["a.txt"],
      }),
    )
    const failed = await settle(id)
    assert.match(failed, new RegExp(`^${id} FAILED`), failed)
    assert.doesNotMatch(failed, /outside the allowed scope/, "the verdict text was trimmed before its audit lines")
    assert.match(failed, /scope: \[\.\.\.\]\} to allow b\.txt/, failed)
    await h.call("horde_drop", { id })
  })

  test("a wait without ids ignores a task disposed while it waits", async () => {
    // A task already reported READY is dropped while the wait blocks on another: its disposed
    // session is the normal end of it, not a "Could not read" error.
    const done = idOf(
      await h.call("horde_do", {
        goal: "Write the reported file.\nRUN: echo ok > reported.txt && git add reported.txt && git commit -qm reported",
        done: ["reported.txt says ok"],
        scope: ["reported.txt"],
      }),
    )
    assert.match(await settle(done), / READY /)
    const finishing = idOf(
      await h.call("horde_do", {
        goal: "Finish soon.\nRUN: sleep 3 && echo ok > finish.txt && git add finish.txt && git commit -qm finish",
        done: ["finish.txt says ok"],
        scope: ["finish.txt"],
      }),
    )
    assert.match(await h.call("horde_wait", { ids: [finishing], timeout_seconds: 120 }), / NEEDS YOU /)
    await h.call("horde_tell", { id: finishing, approve: true })
    const waiting = h.call("horde_wait", { timeout_seconds: 120 })
    await new Promise((r) => setTimeout(r, 1_000))
    await h.call("horde_drop", { id: done, reason: "not needed" })
    const out = await waiting
    assert.doesNotMatch(out, /Could not read/, out)
    assert.doesNotMatch(out, /disposed or deleted/, out)
    assert.match(out, new RegExp(`^${finishing} READY`), out)
    await h.call("horde_drop", { id: finishing })
  })
})
