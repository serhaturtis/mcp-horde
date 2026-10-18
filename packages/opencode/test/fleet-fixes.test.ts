import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { Board } from "@mcp-horde/board"
import { scopeGlobs } from "../src/fleet.js"
import { type AgentRecord, OWNER_STALE_MS, ownerAlive, SELF, Store } from "../src/state.js"
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
})

let h: Harness
let mock: Mock
let repo: string
let tmp: string
let boardState: string

describe("fleet fixes: gates, tasks and worktrees (real opencode, mock LLM)", { timeout: 600_000 }, () => {
  before(async () => {
    mock = await startMockLlm()
    ;({ tmp, repo } = makeRepo(mock.url))
    boardState = path.join(tmp, "board-state")
    h = await connect({ ...isolatedEnv(tmp, repo), HORDE_OPENCODE_MAX_RUNNING: "2", HORDE_BOARD_STATE_DIR: boardState })
  })

  after(async () => {
    await h?.call("opencode_server", { action: "stop" }).catch(() => undefined)
    await h?.close()
    mock?.close()
  })

  test("a text attachment over the inline limit is refused before anything starts", async () => {
    fs.writeFileSync(path.join(repo, "big.txt"), "x".repeat(300 * 1024))
    await assert.rejects(
      h.call("opencode_spawn", { prompt: "read it", name: "big", files: ["big.txt"] }),
      /big\.txt is a 300 KB text file[\s\S]*limited to 256 KB/,
    )
    assert.doesNotMatch(await h.call("opencode_status"), /big \(ses_/)
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
})
