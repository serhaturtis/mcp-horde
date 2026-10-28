import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { Board } from "@mcp-horde/board"
import { lockDirFor } from "@mcp-horde/verify"
import { GATE_REVIEW_TIMEOUT_MS } from "../src/fleet.js"
import type { AgentRecord } from "../src/state.js"
import { createFleetEnv, type FleetEnv } from "./fleet-support.js"
import { git, type Harness, type Mock, makeRepo, until } from "./harness.js"

describe("fleet fixes: gates, tasks and worktrees (real opencode, mock LLM)", { timeout: 600_000 }, () => {
  let env: FleetEnv
  let h: Harness
  let mock: Mock
  let repo: string
  let tmp: string
  let boardState: string
  let idOf: (text: string) => string
  let agentRecord: (taskId: string) => AgentRecord | undefined

  before(async () => {
    env = await createFleetEnv()
    ;({ h, mock, repo, tmp, boardState, idOf, agentRecord } = env)
  })

  after(async () => {
    await env.close()
  })

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
