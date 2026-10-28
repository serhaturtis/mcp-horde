import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, mock as mockTimers, test } from "node:test"
import { Board, renderSummary } from "@mcp-horde/board"
import { lockDirFor } from "@mcp-horde/verify"
import type { Backend } from "../src/backend.js"
import type { Config } from "../src/config.js"
import { Fleet, GATE_REVIEW_TIMEOUT_MS, type Hooks, type Snapshot, scopeGlobs } from "../src/fleet.js"
import { outcome } from "../src/horde.js"
import { type AgentRecord, OWNER_STALE_MS, ownerAlive, SELF, Store } from "../src/state.js"
import { emptyTrack, type Track } from "../src/tracker.js"
import { connect, git, type Harness, isolatedEnv, type Mock, makeRepo, until } from "./harness.js"
import { startMockLlm } from "./mock-llm.js"

describe("fleet fixes: ownership and helpers", () => {
  const record = (id: string, owner?: AgentRecord["owner"], ownerSeen?: number): AgentRecord => ({
    id,
    server: "local",
    directory: "/tmp",
    policy: "ask",
    questions: "ask",
    limits: {},
    createdAt: 0,
    reportedSeq: 0,
    owner,
    ownerSeen,
  })

  test("an owner with a stale heartbeat is dead, even when its PID is alive (reused)", () => {
    const other = { pid: process.pid, host: SELF.host, token: "someone-else" }
    assert.equal(ownerAlive(other), true, "no heartbeat: the PID check decides")
    assert.equal(ownerAlive(other, Date.now()), true)
    assert.equal(ownerAlive(other, Date.now() - OWNER_STALE_MS - 1), false)
    assert.equal(ownerAlive({ ...other, host: "elsewhere" }, Date.now() - OWNER_STALE_MS - 1), false, "another host's stale owner too")
    assert.equal(ownerAlive(SELF, 0), true, "we are alive whatever the record says")
  })

  test("update does not overwrite a record another process has claimed", () => {
    const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "horde-update-")))
    store.put(record("ses_mine", SELF))
    store.update("ses_mine", { name: "mine" })
    assert.equal(store.get("ses_mine")?.name, "mine")
    store.put({ ...store.get("ses_mine")!, owner: { ...SELF, token: "someone-else" } })
    store.update("ses_mine", { name: "stale" })
    assert.equal(store.get("ses_mine")?.name, "mine")
  })

  test("a claim re-reads the record under the lock: only one process gets an orphan", () => {
    const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "horde-claim-")))
    const dead = { pid: 999_999_999, host: SELF.host, token: "dead" }
    store.put(record("ses_orphan", dead))
    const claimable = (r: AgentRecord) => r.owner?.token === "me" || !ownerAlive(r.owner, r.ownerSeen)
    const mine = { pid: process.pid, host: SELF.host, token: "me" }
    const first = store.claim("ses_orphan", mine, claimable)
    assert.equal(first?.owner?.token, "me")
    assert.ok(first?.ownerSeen, "a claim starts the heartbeat")
    // A second process (alive, fresh heartbeat on the record now) cannot take it.
    const theirs = { pid: process.pid, host: SELF.host, token: "them" }
    assert.equal(
      store.claim("ses_orphan", theirs, (r) => r.owner?.token === "them" || !ownerAlive(r.owner, r.ownerSeen)),
      undefined,
    )
    assert.equal(store.get("ses_orphan")?.owner?.token, "me")
    assert.equal(store.claim("ses_missing", mine, claimable), undefined)
  })

  test("the synchronous lock takes over a dead holder's lock and times out on a live one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "horde-lock-"))
    const store = new Store(dir)
    fs.writeFileSync(path.join(dir, "x.lock"), JSON.stringify({ pid: 999_999_999, host: SELF.host, token: "t" }))
    assert.equal(
      store.lockSync("x", () => 42),
      42,
    )
    assert.ok(!fs.existsSync(path.join(dir, "x.lock")), "released")
    fs.writeFileSync(path.join(dir, "x.lock"), JSON.stringify({ pid: process.pid, host: SELF.host, token: "t" }))
    assert.throws(() => store.lockSync("x", () => 1, 100), /timed out waiting/)
  })

  test("scope paths become globs for the profile and the gate's audit", () => {
    assert.deepEqual(scopeGlobs(["src/", "./test/a.ts", "lib\\x\\"]), ["src/**", "test/a.ts", "lib/x/**"])
  })

  test("a task's locks never name paths outside its scope", async () => {
    const { tmp, repo } = makeRepo("http://127.0.0.1:1")
    const board = await Board.open(repo, path.join(tmp, "board-state"))
    const task = (await board.plan([{ title: "Scoped", goal: "g", scope: ["src/a.ts"] }])).tasks[0]!
    const { attempt } = await board.assign(task.id)
    await assert.rejects(board.lock(task.id, attempt.token, ["package.json"]), new RegExp(`outside ${task.id}'s scope \\(src/a\\.ts\\)`))
    assert.deepEqual(board.locks(), [], "a refused lock takes nothing")
    await board.lock(task.id, attempt.token, ["src/a.ts"])
    assert.deepEqual(
      board.locks().map((l) => l.path),
      ["src/a.ts"],
    )
  })
})

let h: Harness
let mock: Mock
let repo: string
let tmp: string
let boardState: string
/** The Claude Code session id the harness server publishes its news file under. */
const NEWS_SESSION = "test-news-session"

describe("fleet fixes: gates, tasks and worktrees (real opencode, mock LLM)", { timeout: 600_000 }, () => {
  before(async () => {
    mock = await startMockLlm()
    ;({ tmp, repo } = makeRepo(mock.url))
    boardState = path.join(tmp, "board-state")
    h = await connect({
      ...isolatedEnv(tmp, repo),
      HORDE_OPENCODE_MAX_RUNNING: "2",
      HORDE_BOARD_STATE_DIR: boardState,
      CLAUDE_CODE_SESSION_ID: NEWS_SESSION,
    })
  })

  after(async () => {
    await h?.call("opencode_server", { action: "stop" }).catch(() => undefined)
    await h?.close()
    mock?.close()
  })

  const idOf = (text: string) => text.match(/\bt-[0-9a-f]+\b/)![0]
  /** The fleet's record on disk for the agent working a task (it is written as the gate decides). */
  function agentRecord(taskId: string): AgentRecord | undefined {
    const dir = path.join(tmp, "state", "agents")
    for (const f of fs.readdirSync(dir)) {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as AgentRecord
      if (r.task?.id === taskId) return r
    }
    return undefined
  }
  /** The next outcome other than a permission request (this repo's config asks before shell). */
  async function settle(id: string): Promise<string> {
    for (;;) {
      const out = await h.call("horde_wait", { ids: [id], timeout_seconds: 120 })
      if (!/ NEEDS YOU /.test(out)) return out
      await h.call("horde_tell", { id, approve: true })
    }
  }

  test("a text attachment over the inline limit is refused before anything starts", async () => {
    fs.writeFileSync(path.join(repo, "big.txt"), "x".repeat(300 * 1024))
    await assert.rejects(
      h.call("opencode_spawn", { prompt: "read it", name: "big", files: ["big.txt"] }),
      /big\.txt is a 300 KB text file[\s\S]*limited to 256 KB/,
    )
    assert.doesNotMatch(await h.call("opencode_status"), /big \(ses_/)
  })

  test("an attachment over the total limit is refused before it is read", async () => {
    fs.writeFileSync(path.join(repo, "big.bin"), Buffer.alloc(20 * 1024 * 1024 + 1))
    await assert.rejects(
      h.call("opencode_spawn", { prompt: "read it", name: "bigbin", files: ["big.bin"] }),
      /big\.bin is 20\.0 MB; attachments are limited to 20 MB/,
    )
    assert.doesNotMatch(await h.call("opencode_status"), /bigbin \(ses_/)
    fs.rmSync(path.join(repo, "big.bin"))
  })

  test("a gate failure waits for a running slot instead of exceeding the limit", async () => {
    const dir = path.join(repo, "gq")
    fs.mkdirSync(dir, { recursive: true })
    // Slow enough to start two other agents while it runs; fails until fixed.txt exists.
    const check = `node -e "setTimeout(() => process.exit(require('fs').existsSync('fixed.txt') ? 0 : (console.log('Error: fixed.txt is missing. TOOL: echo fixed > fixed.txt'), 1)), 4000)"`
    fs.writeFileSync(path.join(dir, "horde.json"), JSON.stringify({ verify: { checks: { check } } }))
    await h.call("opencode_spawn", { prompt: "start", name: "gq", directory: "gq", permissions: "allow", gate: { max_rounds: 2 } })
    await until(async () => /gq .*— IDLE[\s\S]*gate: running checks/.test(await h.call("opencode_status", { ids: ["gq"] })), 60_000, 100)
    // The idle agent holds no slot: both go to new agents.
    await h.call("opencode_spawn", { prompt: "SLOW hog one", name: "hog1" })
    await h.call("opencode_spawn", { prompt: "SLOW hog two", name: "hog2" })
    const queued = await until(async () => {
      const s = await h.call("opencode_status", { ids: ["gq"] })
      return /gate: failed; fix queued/.test(s) && s
    }, 60_000)
    assert.match(queued, /gq .*— IDLE/, "the fix waits: the running limit is reached")
    assert.match(await h.call("opencode_status", { ids: ["hog1", "hog2"] }), /hog1 .*— RUNNING[\s\S]*hog2 .*— RUNNING/)
    await h.call("opencode_interrupt", { id: "hog1" })
    // A slot is free: the fix goes out on a later tick and the second round passes.
    const done = await h.call("opencode_wait", { ids: ["gq"], timeout_seconds: 120 })
    assert.match(done, /gq .*— IDLE[\s\S]*gate: ✓ PASS \(round 2\/2\)/, done)
    assert.ok(fs.existsSync(path.join(dir, "fixed.txt")))
    await h.call("opencode_interrupt", { id: "hog2" })
  })

  test("board tasks: options are checked before an attempt starts; a task being worked is refused; no merge while it waits", async () => {
    const board = await Board.open(repo, boardState)
    const task = (await board.plan([{ title: "Say hi", goal: "Say hi.\nRUN: echo hi > hi.txt", scope: ["hi.txt"] }])).tasks[0]!
    await assert.rejects(h.call("opencode_spawn", { task: task.id, name: "tw", model: "mock/nope" }), /Unknown model "mock\/nope"/)
    assert.equal(board.task(task.id).attempts.length, 0, "a spawn that fails its checks records no attempt")
    // permissions "ask": the board command is trusted, the RUN line waits for an answer.
    await h.call("opencode_spawn", { task: task.id, name: "tw", permissions: "ask" })
    assert.match(await h.call("opencode_wait", { ids: ["tw"], timeout_seconds: 120 }), /tw .*— NEEDS_INPUT/)
    await assert.rejects(
      h.call("opencode_spawn", { task: task.id, name: "tw2" }),
      new RegExp(`${task.id} is being worked by tw; wait, interrupt or dispose it first`),
    )
    assert.equal(board.task(task.id).attempts.length, 1, "the working attempt was not replaced")
    await assert.rejects(h.call("opencode_worktree", { id: "tw", action: "merge" }), /tw is waiting for an answer/)
    await assert.rejects(h.call("opencode_worktree", { id: "tw", action: "commit" }), /only diff works meanwhile/)
    await h.call("opencode_worktree", { id: "tw", action: "diff" })
    await h.call("opencode_dispose", { id: "tw", worktree: "discard" })
  })

  test("after a sync the judged turn is not gated again; the next turn is", async () => {
    fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify({ verify: { checks: { ok: `node -e "process.exit(0)"` } } }))
    git(repo, "add", "horde.json")
    git(repo, "commit", "-qm", "checks")
    const first = await h.call("opencode_spawn", {
      prompt: "TOOL: echo mine > ds.txt",
      name: "ds",
      isolation: "worktree",
      permissions: "allow",
      gate: true,
      wait: true,
      timeout_seconds: 120,
    })
    assert.match(first, /gate: ✓ PASS \(round 1\/2\)/, first)
    fs.writeFileSync(path.join(repo, "theirs.txt"), "theirs\n")
    git(repo, "add", "theirs.txt")
    git(repo, "commit", "-qm", "theirs")
    const synced = await h.call("opencode_worktree", { id: "ds", action: "sync" })
    assert.match(synced, /rebased 1 commit\(s\)[\s\S]*The gate does not re-run by itself; it judges the turn that message starts\./, synced)
    await new Promise((r) => setTimeout(r, 1500))
    assert.doesNotMatch(await h.call("opencode_status", { ids: ["ds"] }), /gate:/, "no gate for the turn judged before the sync")
    const next = await h.call("opencode_message", { id: "ds", message: "re-check", wait: true, timeout_seconds: 120 })
    assert.match(next, /gate: ✓ PASS \(round 1\/2\)/, next)
    await h.call("opencode_dispose", { id: "ds", worktree: "discard" })
  })

  test("a worktree gate reads a rule committed on the main checkout while the task runs", async () => {
    const { repo: r } = makeRepo(mock.url, { permission: { bash: "allow" } })
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { ok: `node -e "process.exit(0)"` } } }))
    git(r, "add", "horde.json")
    git(r, "commit", "-qm", "checks")
    const failed = await h.call("opencode_spawn", {
      prompt: `TOOL: node -e "require('fs').writeFileSync('logo.bin', Buffer.from([0,1,2,3]))"`,
      name: "rules",
      directory: r,
      isolation: "worktree",
      permissions: "allow",
      gate: { max_rounds: 1 },
      wait: true,
      timeout_seconds: 120,
    })
    assert.match(failed, /gate: ✗ FAIL \(round 1\/1\)/, failed)
    assert.match(failed, /binaries/, failed)
    // The orchestrator commits the looser rule on the target branch; the worktree does not have it.
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { ok: `node -e "process.exit(0)"` }, audit: { warn: ["binaries"] } } }))
    git(r, "add", "horde.json")
    git(r, "commit", "-qm", "warn binaries")
    const passed = await h.call("opencode_message", { id: "rules", message: "run the checks again", wait: true, timeout_seconds: 120 })
    assert.match(passed, /gate: ✓ PASS \(round 1\/1\)/, passed)
    await h.call("opencode_dispose", { id: "rules", worktree: "discard" })
  })

  test("gate reviews get ten minutes per answer", () => {
    assert.equal(GATE_REVIEW_TIMEOUT_MS, 600_000)
  })

  test("a steer absorbed into a finished turn does not discard its verdict or run the gate again", async () => {
    const { repo: r } = makeRepo(mock.url, { permission: { bash: "allow" } })
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { ok: "true" } }, tiers: ["mock/mock"] }))
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    const started = await h.call("horde_do", {
      directory: r,
      goal: "Write the greeting.\nRUN: echo hello > hello.txt && git add hello.txt && git commit -qm hello\nRUN: sleep 12",
      done: ["hello.txt says hello"],
      scope: ["hello.txt"],
    })
    const id = idOf(started)
    // Wait until the worker has committed and is busy with the slow second step, then steer it
    // into the same turn: the steer's seq is newer than the turn's start.
    await until(
      async () => {
        for (const line of git(r, "worktree", "list", "--porcelain").split("\n"))
          if (line.startsWith("worktree ") && fs.existsSync(path.join(line.slice(9), "hello.txt"))) return true
        return false
      },
      60_000,
      100,
    )
    await h.call("horde_tell", { id, message: "carry on" })
    const out = await h.call("horde_wait", { ids: [id], timeout_seconds: 120 })
    assert.match(out, new RegExp(`^${id} READY`), out)
    assert.match(out, /review: 1 of 1 criteria met \(by mock\/mock, the model that did the work\)/, out)
    // A second gate would spawn another reviewer: wait past a tick and count them.
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const reviews = mock.requests.filter((b) => {
      const msgs = (b as { messages?: { role: string; content: unknown }[] }).messages ?? []
      return msgs.some(
        (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("# Acceptance criteria") && m.content.includes("hello.txt says hello"),
      )
    })
    assert.equal(reviews.length, 1, `the gate reviewed the turn once, got ${reviews.length}`)
    await h.call("opencode_dispose", { id, worktree: "discard" })
  })

  for (const [label, tiers] of [
    ["once", ["mock/pricey"]],
    ["twice", ["mock/pricey", "mock/pricey"]],
  ] as const) {
    test(`tiers naming only the worker's model (${label}) are reviewed by that model, not OpenCode's default`, async () => {
      const { repo: r } = makeRepo(mock.url, { permission: { bash: "allow" } })
      fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { ok: "true" } }, tiers }))
      git(r, "add", ".")
      git(r, "commit", "-qm", "checks")
      const file = `pricey-${label}.txt`
      const criterion = `${file} says hello`
      const started = await h.call("horde_do", {
        directory: r,
        goal: `Write the greeting.\nRUN: echo hello > ${file} && git add ${file} && git commit -qm pricey`,
        done: [criterion],
        scope: [file],
      })
      const id = idOf(started)
      const out = await h.call("horde_wait", { ids: [id], timeout_seconds: 180 })
      assert.match(out, new RegExp(`^${id} READY`), out)
      // The harness's OpenCode default is mock/mock, so only a reviewer chosen from the tiers
      // (the worker's own model here) makes the outcome say mock/pricey.
      assert.match(out, /review: 1 of 1 criteria met \(by mock\/pricey, the model that did the work\)/, out)
      const reviews = mock.requests.filter((b) => {
        const msgs = (b as { messages?: { role: string; content: unknown }[] }).messages ?? []
        return msgs.some(
          (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("# Acceptance criteria") && m.content.includes(criterion),
        )
      })
      assert.equal(reviews.length, 1)
      assert.equal((reviews[0] as { model?: string }).model, "pricey", "the reviewer was the worker's model, not the OpenCode default")
      await h.call("opencode_dispose", { id, worktree: "discard" })
    })
  }

  test("a gate review with no answer from the first reviewer retries on another model", async () => {
    const { repo: r } = makeRepo(mock.url, { permission: { bash: "allow" } })
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { ok: "true" } }, tiers: ["mock/mock", "broken/model", "mock/other"] }))
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    const started = await h.call("horde_do", {
      directory: r,
      goal: "Write the greeting.\nRUN: echo hello > greeting.txt && git add greeting.txt && git commit -qm greeting",
      done: ["greeting.txt says hello"],
      scope: ["greeting.txt"],
    })
    const id = idOf(started)
    const out = await h.call("horde_wait", { ids: [id], timeout_seconds: 180 })
    assert.match(out, new RegExp(`^${id} READY`), out)
    assert.match(out, /review: 1 of 1 criteria met \(by mock\/other\)/, out)
    const reviews = mock.requests.filter((b) => {
      const msgs = (b as { messages?: { role: string; content: unknown }[] }).messages ?? []
      return msgs.some(
        (m) =>
          m.role === "user" && typeof m.content === "string" && m.content.includes("# Acceptance criteria") && m.content.includes("greeting.txt says hello"),
      )
    })
    assert.equal(reviews.length, 1)
    assert.equal((reviews[0] as { model?: string }).model, "other", "the retry used the next tier model")
    await h.call("opencode_dispose", { id, worktree: "discard" })
  })

  test("a gate whose reviewers both give no answer fails closed", async () => {
    const { repo: r } = makeRepo(mock.url, { permission: { bash: "allow" } })
    // A second unrunnable model, so first reviewer and retry both fail to start.
    const config = JSON.parse(fs.readFileSync(path.join(r, "opencode.json"), "utf8"))
    config.provider.broken.models.other = { name: "Broken other", tool_call: true }
    fs.writeFileSync(path.join(r, "opencode.json"), JSON.stringify(config))
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { ok: "true" } }, tiers: ["mock/mock", "broken/model", "broken/other"] }))
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    const started = await h.call("horde_do", {
      directory: r,
      goal: "Write the greeting.\nRUN: echo hello > hi.txt && git add hi.txt && git commit -qm hi",
      done: ["hi.txt says hello"],
      scope: ["hi.txt"],
    })
    const id = idOf(started)
    const out = await h.call("horde_wait", { ids: [id], timeout_seconds: 180 })
    assert.match(out, new RegExp(`^${id} FAILED`), out)
    assert.match(out, /review could not run/, out)
    assert.match(out, /Cannot initialize broken\/other/, out)
    await h.call("opencode_dispose", { id, worktree: "discard" })
  })

  test("a refused message leaves no leftover commit; the next plain land is refused as leftovers", async () => {
    const { tmp: at, repo: hooked } = makeRepo(mock.url)
    fs.writeFileSync(path.join(hooked, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } }, tiers: ["mock/mock", "mock/pricey"] }))
    git(hooked, "add", ".")
    git(hooked, "commit", "-qm", "checks")
    const hooks = path.join(at, "hooks")
    fs.mkdirSync(hooks)
    const hook = path.join(hooks, "commit-msg")
    fs.writeFileSync(hook, '#!/bin/sh\ngrep -q "^feat:" "$1" || { echo "message must start with feat:" >&2; exit 1; }\n')
    if (process.platform !== "win32") fs.chmodSync(hook, 0o755)
    git(hooked, "config", "core.hooksPath", hooks)

    const started = await h.call("horde_do", {
      directory: hooked,
      goal: 'Write the file.\nRUN: echo ok > done.txt && git add done.txt && git commit -qm "feat: add done"',
      done: ["done.txt says ok"],
      scope: ["done.txt", "loose.txt"],
    })
    const id = idOf(started)
    const branch = started.match(/worktree (horde\/[\w-]+)/)![1]!
    const ready = await settle(id)
    assert.match(ready, /READY/)
    const worktree = ready.match(/diff: git -C (\S+) diff/)![1]!
    const head = git(hooked, "rev-parse", "HEAD")
    const workerHead = git(hooked, "rev-parse", branch)

    fs.writeFileSync(path.join(worktree, "loose.txt"), "loose\n")
    const refused = await h.call("horde_land", { id, message: "bad" })
    assert.match(refused, /did not pass the repository's commit-msg hook/, refused)
    assert.match(refused, /message must start with feat:/, refused)
    assert.equal(git(hooked, "rev-parse", "HEAD"), head, "master did not move")
    assert.equal(git(hooked, "rev-parse", branch), workerHead, "no leftover commit was left on the branch")
    assert.match(git(worktree, "status", "--porcelain"), /\?\? loose\.txt/, "the leftovers are uncommitted again")
    assert.equal(fs.readFileSync(path.join(worktree, "loose.txt"), "utf8"), "loose\n")

    const again = await h.call("horde_land", { id })
    assert.match(again, /still has uncommitted changes/, again)
  })

  test("a git-ignored core.hooksPath (husky) is judged when landing without a message", async () => {
    const { repo: hooked } = makeRepo(mock.url)
    fs.writeFileSync(path.join(hooked, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } }, tiers: ["mock/mock", "mock/pricey"] }))
    git(hooked, "add", ".")
    git(hooked, "commit", "-qm", "checks")
    // husky v9: core.hooksPath points at a directory git ignores, so it is absent from the worktree
    // and the worker's `git commit` there runs no hook.
    const husky = path.join(hooked, ".husky", "_")
    fs.mkdirSync(husky, { recursive: true })
    fs.writeFileSync(path.join(husky, "commit-msg"), '#!/bin/sh\ngrep -q "^feat:" "$1" || { echo "message must start with feat:" >&2; exit 1; }\n')
    if (process.platform !== "win32") fs.chmodSync(path.join(husky, "commit-msg"), 0o755)
    fs.appendFileSync(path.join(hooked, ".gitignore"), ".husky/_\n")
    git(hooked, "add", ".gitignore")
    git(hooked, "commit", "-qm", "ignore husky internals")
    git(hooked, "config", "core.hooksPath", ".husky/_")

    const started = await h.call("horde_do", {
      directory: hooked,
      goal: "Write the file.\nRUN: echo ok > file.txt && git add file.txt && git commit -qm whatever",
      done: ["file.txt says ok"],
      scope: ["file.txt"],
    })
    const id = idOf(started)
    assert.match(await settle(id), /READY/)

    const refused = await h.call("horde_land", { id })
    assert.match(refused, /did not pass the repository's commit-msg hook/, refused)
    assert.match(refused, /message must start with feat:/, refused)
    assert.match(refused, /commit [0-9a-f]{10} \(whatever\)/, refused)

    const landed = await h.call("horde_land", { id, message: "feat: x" })
    assert.match(landed, /^landed t-\w+ on master: 1 commit\(s\)/, landed)
  })

  test("two concurrent lands on one repository both succeed: the second waits for the first", async () => {
    const { repo: r } = makeRepo(mock.url)
    // A slow check makes the two lands overlap without the queue, so they would redo each other's
    // checks; with the per-repository queue the second waits and both land on the first attempt.
    fs.writeFileSync(
      path.join(r, "horde.json"),
      JSON.stringify({ verify: { checks: { slow: `node -e "setTimeout(() => process.exit(0), 2000)"` } }, tiers: ["mock/mock"] }),
    )
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    const a = await h.call("horde_do", {
      directory: r,
      goal: "Write the file.\nRUN: echo a > a.txt && git add a.txt && git commit -qm a",
      done: ["a.txt says a"],
      scope: ["a.txt"],
    })
    const b = await h.call("horde_do", {
      directory: r,
      goal: "Write the file.\nRUN: echo b > b.txt && git add b.txt && git commit -qm b",
      done: ["b.txt says b"],
      scope: ["b.txt"],
    })
    assert.match(await settle(idOf(a)), /READY/)
    assert.match(await settle(idOf(b)), /READY/)
    const [la, lb] = await Promise.all([h.call("horde_land", { id: idOf(a) }), h.call("horde_land", { id: idOf(b) })])
    assert.match(la, /^landed /, la)
    assert.match(lb, /^landed /, lb)
  })

  test("a failed land does not block the next queued land of the same repository", async () => {
    const { repo: r } = makeRepo(mock.url)
    // workers.land runs only at landing and fails in a worktree that holds a.txt (task A's file),
    // so A's landing fails while B's succeeds; the queue must let B land anyway.
    fs.writeFileSync(
      path.join(r, "horde.json"),
      JSON.stringify({
        verify: { checks: { ok: "true" } },
        workers: { land: `node -e "process.exit(require('fs').existsSync('a.txt') ? 1 : 0)"` },
        tiers: ["mock/mock"],
      }),
    )
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    const a = await h.call("horde_do", {
      directory: r,
      goal: "Write the file.\nRUN: echo a > a.txt && git add a.txt && git commit -qm a",
      done: ["a.txt says a"],
      scope: ["a.txt"],
    })
    const b = await h.call("horde_do", {
      directory: r,
      goal: "Write the file.\nRUN: echo b > b.txt && git add b.txt && git commit -qm b",
      done: ["b.txt says b"],
      scope: ["b.txt"],
    })
    assert.match(await settle(idOf(a)), /READY/)
    assert.match(await settle(idOf(b)), /READY/)
    const [la, lb] = await Promise.all([h.call("horde_land", { id: idOf(a) }), h.call("horde_land", { id: idOf(b) })])
    assert.match(la, /not landed/, la)
    assert.match(lb, /^landed /, lb)
  })

  test("opencode_dispose closes a task-bound agent's board attempt as failed", async () => {
    const board = await Board.open(repo, boardState)
    const task = (await board.plan([{ title: "Dispose me", goal: "Wait a while.\nRUN: sleep 60", scope: ["disp.txt"] }])).tasks[0]!
    await h.call("opencode_spawn", { task: task.id, name: "dispose-me", permissions: "allow" })
    await h.call("opencode_dispose", { id: "dispose-me", worktree: "discard" })
    const closed = board.task(task.id)
    assert.equal(closed.status, "failed", "the task is closed, not working forever")
    assert.equal(closed.attempts[0]?.outcome, "failed")
    assert.equal(closed.attempts[0]?.note, "disposed")
  })

  test("a gate verdict updates the news file at once and board_summary shows the task failed-but-open", async () => {
    const { repo: r } = makeRepo(mock.url, { permission: { bash: "allow" } })
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { nope: `node -e "process.exit(1)"` } }, tiers: ["mock/mock"] }))
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    const started = await h.call("horde_do", {
      directory: r,
      goal: "Write the file.\nRUN: echo hi > g.txt && git add g.txt && git commit -qm g",
      done: ["g.txt says hi"],
      scope: ["g.txt"],
    })
    const id = idOf(started)
    // The record is written just before the news file: its final verdict marks the gate's decision.
    const record = await until(
      async () => {
        const r = agentRecord(id)
        return r?.gateState?.verdict?.final ? r : undefined
      },
      180_000,
      50,
    )
    const seen = Date.now()
    assert.ok(seen - record.gateState!.verdict!.at < 1_000, "the verdict was just recorded")
    const newsFile = path.join(tmp, "state", "news", `${NEWS_SESSION}.json`)
    await until(
      async () => {
        try {
          const news = JSON.parse(fs.readFileSync(newsFile, "utf8")) as { waiting: { id: string }[] }
          return news.waiting.some((w) => w.id === id)
        } catch {
          return false
        }
      },
      5_000,
      25,
    )
    assert.ok(Date.now() - seen < 1_000, `the news file named the task within a second of the verdict (${Date.now() - seen}ms)`)
    const summary = renderSummary(await Board.open(r, boardState), 4_000)
    assert.match(summary, new RegExp(`failed \\(open\\)  ${id} "`), summary)
    assert.match(summary, /gate failed after 2 rounds; open for horde_tell/, summary)
    assert.doesNotMatch(summary, new RegExp(`review  ${id}`), "no verdict is pending: it is not in review")
    await h.call("horde_drop", { id })
  })

  test("a gate whose check never started does not consume a round or reach the worker", async () => {
    const { repo: r } = makeRepo(mock.url, { permission: { bash: "allow" } })
    fs.writeFileSync(
      path.join(r, "horde.json"),
      JSON.stringify({ verify: { checks: { test: { command: "true", slots: 1 } }, timeoutSeconds: 2 }, tiers: ["mock/mock"] }),
    )
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    // Hold the check's only slot as a live process: withLock waits, and the retry cannot start either.
    const lockDir = await lockDirFor(r, path.join(tmp, "xdg-state", "mcp-horde", "verify"))
    fs.mkdirSync(lockDir, { recursive: true })
    const lockFile = path.join(lockDir, "check-test.0.lock")
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: os.hostname(), token: "held" }))
    const before = mock.requests.length
    try {
      const started = await h.call("horde_do", {
        directory: r,
        goal: "Write the file.\nRUN: echo hi > s.txt && git add s.txt && git commit -qm s",
        done: ["s.txt says hi"],
        scope: ["s.txt"],
      })
      const id = idOf(started)
      const out = await h.call("horde_wait", { ids: [id], timeout_seconds: 120 })
      assert.match(out, /FAILED/, out)
      assert.match(out, /check-test/, out)
      assert.match(out, new RegExp(`held by pid ${process.pid}`), out)
      assert.match(out, /not the worker's failure/, out)
      assert.doesNotMatch(out, /checks failed after 1 round/, "the lost slot was not counted as the worker's round")
      const fixes = mock.requests.slice(before).filter((b) => JSON.stringify(b).includes("This task is not done yet"))
      assert.equal(fixes.length, 0, "the lost slot was never sent back to the worker")
      const record = agentRecord(id)
      assert.equal(record?.gateState?.round, 0, "no round was consumed")
      assert.equal(record?.gateState?.verdict?.final, true)
      await h.call("horde_drop", { id })
    } finally {
      fs.rmSync(lockFile, { force: true })
    }
  })
})

describe("fleet fixes: a brief OpenCode stall is absorbed by the wait", () => {
  test("a wait round whose activeSet() rejects once returns the outcome instead of throwing", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "horde-wait-"))
    const store = new Store(tmp)
    store.put({
      id: "ses_wait",
      server: "local",
      directory: tmp,
      policy: "ask",
      questions: "ask",
      limits: {},
      createdAt: 0,
      reportedSeq: 0,
      owner: SELF,
      ownerSeen: Date.now(),
    })
    const backend = {
      client: {},
      info: { key: "local" },
      events: new EventEmitter(),
      streaming: false,
      dead: false,
    } as unknown as Backend
    const config: Config = {
      username: "opencode",
      allowInsecure: false,
      serverMode: "shared",
      bin: "opencode",
      directory: tmp,
      defaultPermissions: "ask",
      maxRunning: 0,
      maxRunningFrom: "test",
      stateDir: path.join(tmp, "state"),
      worktreeDir: path.join(tmp, "worktrees"),
      channel: false,
      elicitTimeoutMs: 600_000,
    }
    const hooks: Hooks = {
      canElicit: () => false,
      askPermission: async () => undefined,
      askQuestion: async () => undefined,
      settled: () => {},
    }
    const fleet = new Fleet(backend, config, store, hooks)
    try {
      let activeCalls = 0
      const fleetAny = fleet as unknown as {
        activeSet: () => Promise<Set<string>>
        snapshot: (ref: string, active?: Set<string>) => Promise<Snapshot>
        tick: () => Promise<void>
      }
      // The background tick is the monitor's job, not this wait's: keep its activeSet() call out.
      fleetAny.tick = async () => {}
      fleetAny.activeSet = async () => {
        if (++activeCalls === 1) throw new Error("listing active sessions failed: aborted due to timeout")
        return new Set(["ses_wait"])
      }
      fleetAny.snapshot = async (ref, active) => {
        if (!active) throw new Error("listing active sessions failed: aborted due to timeout")
        return {
          id: ref,
          title: "",
          state: "idle",
          directory: tmp,
          policy: "ask",
          questionPolicy: "ask",
          limits: {},
          pending: { permissions: [], questions: [] },
          unreported: [],
          steps: 0,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          children: [],
        }
      }
      const result = await fleet.waitFor(["ses_wait"], "all", 5_000)
      assert.equal(activeCalls, 2, "the first activeSet() rejected and the next one answered")
      assert.equal(result.timedOut, false)
      assert.ok(result.snapshots.some((s) => s.id === "ses_wait"))
      assert.deepEqual([...result.errors], [])
    } finally {
      fleet.close()
    }
  })
})

describe("fleet fixes: outcomes after a wait", () => {
  test("outcome renders the wait's in-memory state without refreshing or re-reading the agent", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "horde-outcome-"))
    const store = new Store(tmp)
    const backend = {
      client: {},
      info: { key: "local" },
      events: new EventEmitter(),
      streaming: false,
      dead: true,
    } as unknown as Backend
    const config: Config = {
      username: "opencode",
      allowInsecure: false,
      serverMode: "shared",
      bin: "opencode",
      directory: tmp,
      defaultPermissions: "ask",
      maxRunning: 0,
      maxRunningFrom: "test",
      stateDir: path.join(tmp, "state"),
      worktreeDir: path.join(tmp, "worktrees"),
      channel: false,
      elicitTimeoutMs: 600_000,
    }
    const hooks: Hooks = {
      canElicit: () => false,
      askPermission: async () => undefined,
      askQuestion: async () => undefined,
      settled: () => {},
    }
    const fleet = new Fleet(backend, config, store, hooks)
    const boardState = process.env.HORDE_BOARD_STATE_DIR
    process.env.HORDE_BOARD_STATE_DIR = path.join(tmp, "board-state")
    try {
      const live = {
        record: {
          id: "ses_live",
          server: "local",
          directory: tmp,
          policy: "ask",
          questions: "ask",
          limits: {},
          createdAt: Date.now(),
          reportedSeq: 0,
          owner: SELF,
          ownerSeen: Date.now(),
        },
        track: emptyTrack(),
        loaded: true,
        state: "running",
        pending: { permissions: [], questions: [] },
        children: new Set<string>(),
        childTracks: new Map(),
        hotChildren: new Map(),
        liveText: "",
        handled: new Set<string>(),
        dialogs: new Map(),
      }
      let refreshes = 0
      let snapshots = 0
      const fleetAny = fleet as unknown as {
        get: (ref: string) => Promise<unknown>
        refresh: (live: unknown) => Promise<never>
        snapshot: (ref: string) => Promise<never>
      }
      fleetAny.get = async () => live
      fleetAny.refresh = async () => {
        refreshes++
        throw new Error("outcome must not refresh")
      }
      fleetAny.snapshot = async () => {
        snapshots++
        throw new Error("outcome must not re-read the agent")
      }

      const text = await outcome(fleet, "ses_live", { live: true })
      assert.match(text, /^ses_live working · .* · starting$/)
      assert.equal(refreshes, 0)
      assert.equal(snapshots, 0)
    } finally {
      if (boardState === undefined) delete process.env.HORDE_BOARD_STATE_DIR
      else process.env.HORDE_BOARD_STATE_DIR = boardState
      fleet.close()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe("fleet fixes: request and refresh deadlines", () => {
  // Drains the microtask queue (setImmediate is not mocked, so it runs after pending microtasks).
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

  const configFor = (tmp: string): Config => ({
    username: "opencode",
    allowInsecure: false,
    serverMode: "shared",
    bin: "opencode",
    directory: tmp,
    defaultPermissions: "ask",
    maxRunning: 0,
    maxRunningFrom: "test",
    stateDir: path.join(tmp, "state"),
    worktreeDir: path.join(tmp, "worktrees"),
    channel: false,
    elicitTimeoutMs: 600_000,
  })

  const hooksFor = (): Hooks => ({
    canElicit: () => false,
    askPermission: async () => undefined,
    askQuestion: async () => undefined,
    settled: () => {},
  })

  const backendFor = (client: unknown): Backend =>
    ({
      client,
      info: { key: "local" },
      events: new EventEmitter(),
      streaming: false,
      dead: true,
    }) as unknown as Backend

  test("get does not blame another session for a record with no owner", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "horde-owner-"))
    const store = new Store(tmp)
    const fleet = new Fleet(backendFor({}), configFor(tmp), store, hooksFor())
    try {
      store.put({ id: "ses_orphan", server: "local", directory: tmp, policy: "ask", questions: "ask", limits: {}, createdAt: 0, reportedSeq: 0 })
      // syncStore would claim it; this is the fallback after a claim that did not happen.
      ;(fleet as unknown as { syncStore: () => void }).syncStore = () => {}
      await assert.rejects(fleet.get("ses_orphan"), (err: Error) => !/another MCP session/.test(err.message) && /has no live owner/.test(err.message))
    } finally {
      fleet.close()
    }
  })

  test("a request whose promise never settles rejects at the bound, naming it once", async (t) => {
    mockTimers.timers.enable({ apis: ["setTimeout"] })
    t.after(() => mockTimers.timers.reset())
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "horde-req-"))
    const store = new Store(tmp)
    const backend = backendFor({ session: { get: () => new Promise(() => {}) } })
    const fleet = new Fleet(backend, configFor(tmp), store, hooksFor())
    try {
      const p = fleet.session("ses_x")
      mockTimers.timers.tick(35_000)
      await assert.rejects(p, { message: "loading session ses_x did not finish within 35s" })
    } finally {
      fleet.close()
    }
  })

  test("a refresh that never settles rejects at REFRESH_MS and the next one starts a new run", async (t) => {
    mockTimers.timers.enable({ apis: ["setTimeout"] })
    t.after(() => mockTimers.timers.reset())
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "horde-refresh-"))
    const store = new Store(tmp)
    store.put({
      id: "ses_x",
      server: "local",
      directory: tmp,
      policy: "ask",
      questions: "ask",
      limits: {},
      createdAt: 0,
      reportedSeq: 0,
      owner: SELF,
      ownerSeen: Date.now(),
    })
    const fleet = new Fleet(backendFor({}), configFor(tmp), store, hooksFor())
    try {
      let calls = 0
      const fleetAny = fleet as unknown as {
        doRefresh: () => Promise<void>
        live: Map<string, { running?: Promise<void> }>
      }
      fleetAny.doRefresh = () => {
        calls++
        return calls === 1 ? new Promise(() => {}) : Promise.resolve()
      }
      const first = fleet.snapshot("ses_x")
      await flush()
      assert.equal(calls, 1)
      mockTimers.timers.tick(120_000)
      await assert.rejects(first, { message: "refreshing the agent did not finish within 120s" })
      assert.equal(fleetAny.live.get("ses_x")?.running, undefined)
      const second = fleet.snapshot("ses_x")
      await flush()
      assert.equal(calls, 2)
      await second
    } finally {
      fleet.close()
    }
  })

  test("an abandoned refresh publishes nothing when its hung readHistory later resolves", async (t) => {
    mockTimers.timers.enable({ apis: ["setTimeout"] })
    t.after(() => mockTimers.timers.reset())
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "horde-abandon-"))
    const store = new Store(tmp)
    store.put({
      id: "ses_x",
      server: "local",
      directory: tmp,
      policy: "ask",
      questions: "ask",
      limits: {},
      createdAt: 0,
      reportedSeq: 0,
      owner: SELF,
      ownerSeen: Date.now(),
    })
    const fleet = new Fleet(
      backendFor({
        session: {
          get: async () => ({ id: "ses_x", location: { directory: tmp }, title: "" }),
          active: async () => ({}),
          list: async () => ({ data: [] }),
          form: { list: async () => [] },
        },
        permission: { list: async () => [] },
      }),
      configFor(tmp),
      store,
      hooksFor(),
    )
    try {
      let calls = 0
      let resolveFirst!: (track: Track) => void
      const first = new Promise<Track>((resolve) => {
        resolveFirst = resolve
      })
      const fleetAny = fleet as unknown as {
        readHistory: (id: string, track: Track, dir: string) => Promise<Track>
        live: Map<string, { track: Track; state?: string; lastRefresh: number }>
      }
      fleetAny.readHistory = (_id, _track) => {
        calls++
        return calls === 1 ? first : Promise.resolve(emptyTrack())
      }

      const firstSnap = fleet.snapshot("ses_x")
      await flush()
      assert.equal(calls, 1)
      mockTimers.timers.tick(120_000)
      await assert.rejects(firstSnap, { message: "refreshing the agent did not finish within 120s" })

      // A later refresh completes and becomes the current run.
      const secondSnap = fleet.snapshot("ses_x")
      await secondSnap
      assert.equal(calls, 2)
      const live = fleetAny.live.get("ses_x")!
      const trackAfter = live.track
      const stateAfter = live.state
      const lastRefreshAfter = live.lastRefresh
      assert.equal(stateAfter, "idle")
      assert.ok(lastRefreshAfter > 0)

      // The abandoned run's hung readHistory finally resolves: it must not publish over the later refresh.
      resolveFirst(emptyTrack())
      await flush()

      assert.equal(live.track, trackAfter)
      assert.equal(live.state, stateAfter)
      assert.equal(live.lastRefresh, lastRefreshAfter)
    } finally {
      fleet.close()
    }
  })
})

describe("fleet fixes: a backend that dies mid-task", { timeout: 600_000 }, () => {
  let mock: Mock
  let hb: Harness
  let tmp: string
  let repo: string

  before(async () => {
    mock = await startMockLlm()
    ;({ tmp, repo } = makeRepo(mock.url, { permission: { bash: "allow" } }))
    hb = await connect({
      ...isolatedEnv(tmp, repo),
      HORDE_OPENCODE_MAX_RUNNING: "2",
      HORDE_BOARD_STATE_DIR: path.join(tmp, "board-state"),
    })
  })

  after(async () => {
    await hb?.call("opencode_server", { action: "stop" }).catch(() => undefined)
    await hb?.close()
    mock?.close()
  })

  test("a killed backend ends the in-flight wait at once and settles its agent as gone", async () => {
    fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify({ verify: { checks: { ok: "true" } }, tiers: ["mock/mock"] }))
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "checks")
    const started = await hb.call("horde_do", {
      directory: repo,
      goal: "Wait a while.\nRUN: sleep 120",
      done: ["it waited"],
      scope: ["w.txt"],
    })
    const id = started.match(/\bt-[0-9a-f]+\b/)![0]
    await until(async () => /— RUNNING/.test(await hb.call("opencode_status", { ids: [id] })), 90_000, 250)
    const server = JSON.parse(fs.readFileSync(path.join(tmp, "state", "server.json"), "utf8")) as { pid: number }
    process.kill(server.pid, "SIGKILL")
    const waitStart = Date.now()
    const waited = await hb.call("horde_wait", { ids: [id], timeout_seconds: 20 })
    const waitedMs = Date.now() - waitStart
    assert.match(waited, /the OpenCode server went away; calling again reconnects/, waited)
    assert.doesNotMatch(waited, /Nothing finished within 20s/, "the wait answered instead of timing out")
    assert.ok(waitedMs < 15_000, `the wait answered in ${waitedMs}ms, not at its deadline`)
    const statusStart = Date.now()
    const status = await hb.call("opencode_status", { ids: [id] })
    assert.doesNotMatch(status, /— RUNNING/, status)
    assert.match(status, /its OpenCode session is gone: the backend restarted at /, status)
    assert.match(status, /horde_tell restarts the work from its worktree, horde_drop gives it up/, status)
    assert.ok(Date.now() - statusStart < 30_000, "the next call reconnected without a long wait")
    const outcome = await hb.call("horde_wait", { ids: [id], timeout_seconds: 20 })
    assert.match(outcome, /FAILED/, outcome)
    assert.match(outcome, /horde_tell restarts the work from its worktree, horde_drop gives it up/, outcome)
    await hb.call("horde_drop", { id })
  })
})
