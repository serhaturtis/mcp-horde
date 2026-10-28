import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { Board, renderSummary } from "@mcp-horde/board"
import type { AgentRecord } from "../src/state.js"
import { createFleetEnv, type FleetEnv, NEWS_SESSION } from "./fleet-support.js"
import { connect, git, type Harness, isolatedEnv, type Mock, makeRepo, until } from "./harness.js"

describe("fleet fixes: gates, tasks and worktrees (real opencode, mock LLM)", { timeout: 600_000 }, () => {
  let env: FleetEnv
  let h: Harness
  let mock: Mock
  let tmp: string
  let boardState: string
  let idOf: (text: string) => string
  let agentRecord: (taskId: string) => AgentRecord | undefined
  let alive: (pid: number) => boolean
  let settle: (id: string) => Promise<string>

  before(async () => {
    env = await createFleetEnv()
    ;({ h, mock, tmp, boardState, idOf, agentRecord, alive, settle } = env)
  })

  after(async () => {
    await env.close()
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

  test("workers do not inherit the server's secrets: the canary, Claude and horde vars are dropped while PATH, HOME and opts survive", async () => {
    const { tmp: et, repo: er } = makeRepo(mock.url)
    const eh = await connect({
      ...isolatedEnv(et, er),
      OPENCODE_SERVER_PASSWORD: "parent-password-canary",
      AUDIT_CANARY_SECRET: "canary-value",
      CLAUDE_CODE_MESSAGING_TOKEN: "cc-token",
      HORDE_OPENCODE_EXTRA: "horde-extra",
      HORDE_OPENCODE_PASS_ENV: "DEEPSEEK_API_KEY",
      DEEPSEEK_API_KEY: "deepseek-key",
    })
    try {
      await eh.call("opencode_spawn", {
        prompt: `TOOL: env | sort > env.txt`,
        name: "envsec",
        permissions: "allow",
        wait: true,
        timeout_seconds: 60,
      })
      const raw = fs.readFileSync(path.join(er, "env.txt"), "utf8")
      const names = raw
        .split("\n")
        .map((l) => l.split("=")[0]!)
        .filter(Boolean)
      assert.ok(names.includes("PATH"), "PATH survives")
      assert.ok(names.includes("HOME"), "HOME survives")
      assert.ok(names.includes("DEEPSEEK_API_KEY"), "the opted-in provider key survives")
      assert.ok(!names.includes("AUDIT_CANARY_SECRET"), "the canary is dropped")
      assert.ok(!names.some((n) => n.startsWith("CLAUDE_")), "Claude Code's environment is dropped")
      assert.ok(!names.some((n) => n.startsWith("HORDE_")), "the horde's own environment is dropped")
      assert.ok(!names.includes("OPENCODE_SERVER_PASSWORD"), "the server password is not in the worker's environment")
      assert.ok(!names.includes("OPENCODE_SERVER_USERNAME"), "the server's auth user is not in the worker's environment")
      assert.ok(!raw.includes("parent-password-canary"), "the parent's OPENCODE_SERVER_PASSWORD is not reused")
      assert.ok(!raw.includes("canary-value"), "the canary value never reaches the worker")
    } finally {
      await eh.call("opencode_server", { action: "stop" }).catch(() => undefined)
      await eh.close()
    }
  })

  test("a live shared server whose record has a wrong password is stopped before a new one is spawned", async () => {
    const { tmp: bt, repo: br } = makeRepo(mock.url)
    const env = isolatedEnv(bt, br)
    const first = await connect(env)
    const pidA = Number((await first.call("opencode_server", { action: "info" })).match(/pid (\d+)/)![1])
    // Corrupt the record while the server keeps running.
    const serverFile = path.join(env.HORDE_OPENCODE_STATE_DIR!, "server.json")
    const rec = JSON.parse(fs.readFileSync(serverFile, "utf8"))
    rec.password = "wrong-password"
    fs.writeFileSync(serverFile, JSON.stringify(rec))
    await first.close()
    // A fresh MCP process reads the corrupted record and must stop the old server, not orphan it.
    const second = await connect(env)
    try {
      await second.call("opencode_models")
      await until(async () => !alive(pidA), 10_000)
      const info = await second.call("opencode_server", { action: "info" })
      const pidB = Number(info.match(/pid (\d+)/)![1])
      assert.notEqual(pidB, pidA, "a new server was spawned")
      assert.ok(alive(pidB), "the new server is running")
      const recordAfter = JSON.parse(fs.readFileSync(serverFile, "utf8"))
      assert.equal(recordAfter.pid, pidB, "the record points at the one live server, not an orphan")
    } finally {
      await second.call("opencode_server", { action: "stop" }).catch(() => undefined)
      await second.close()
    }
  })

  test("a version mismatch on reconnect warns once per process, and server.json records the version at spawn", async () => {
    const { tmp: vt, repo: vr } = makeRepo(mock.url)
    const env = isolatedEnv(vt, vr)
    const first = await connect(env)
    await first.call("opencode_server", { action: "info" })
    const serverFile = path.join(env.HORDE_OPENCODE_STATE_DIR!, "server.json")
    const rec = JSON.parse(fs.readFileSync(serverFile, "utf8"))
    assert.match(rec.version, /^\d+\.\d+/, "server.json records the OpenCode version at spawn")
    // Pretend the running server was started by an older binary than the one configured now.
    rec.version = "9.9.9"
    fs.writeFileSync(serverFile, JSON.stringify(rec))
    await first.close()
    const second = await connect(env)
    try {
      const firstStatus = await second.call("opencode_status")
      assert.match(
        firstStatus,
        /the shared OpenCode server runs 9\.9\.9, the configured binary is \d+\.\d+\.\d+; opencode_server stop then any call restarts it/,
        firstStatus,
      )
      const secondStatus = await second.call("opencode_status")
      assert.doesNotMatch(secondStatus, /the shared OpenCode server runs 9\.9\.9/, "the warning is shown once per process")
    } finally {
      await second.call("opencode_server", { action: "stop" }).catch(() => undefined)
      await second.close()
    }
  })

  test("a gate verdict updates the news file at once and board_summary shows the task failed with its attempt open", async () => {
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
    assert.match(summary, new RegExp(`failed  ${id} "`), summary)
    assert.doesNotMatch(summary, new RegExp(`review  ${id}`), "no verdict is pending: it is not in review")
    const board = await Board.open(r, boardState)
    const failed = board.task(id)
    assert.equal(failed.status, "failed")
    assert.equal(failed.attempts[0]?.endedAt, undefined, "the attempt stays open for horde_tell")
    assert.match(failed.attempts[0]?.failure ?? "", /gate failed after 2 rounds; open for horde_tell/)
    assert.match(failed.attempts[0]?.note ?? "", /gate failed after 2 rounds/)
    await h.call("horde_drop", { id })
  })
})
