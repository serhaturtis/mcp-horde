import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { Board } from "@mcp-horde/board"
import type { Backend } from "../src/backend.js"
import type { Config } from "../src/config.js"
import { Fleet, type Hooks, type Snapshot } from "../src/fleet.js"
import { outcome } from "../src/horde.js"
import { News } from "../src/news.js"
import type { Runtime } from "../src/runtime.js"
import { type AgentRecord, SELF, Store } from "../src/state.js"
import type { emptyTrack, Turn } from "../src/tracker.js"
import { followRebase, workStart } from "../src/worktree.js"
import { createFleetEnv, type FleetEnv } from "./fleet-support.js"
import { connect, git, type Harness, isolatedEnv, type Mock, makeRepo, until } from "./harness.js"

const CONFIG = (tmp: string): Config => ({
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
  passEnv: [],
})

const HOOKS: Hooks = {
  canElicit: () => false,
  askPermission: async () => undefined,
  askQuestion: async () => undefined,
  settled: () => {},
}

const BACKEND = {
  client: {},
  info: { key: "local" },
  events: new EventEmitter(),
  streaming: false,
  dead: true,
} as unknown as Backend

const turnAt = (startSeq: number): Turn => ({
  startSeq,
  startedAt: 1,
  admittedAt: 1,
  admittedSeq: startSeq,
  prompt: "",
  finalText: "",
  steps: 0,
  cost: 0,
  endedAt: 2,
  messageIDs: [],
})

describe("fleet landing: moved tips and lifecycle fixes (real opencode, mock LLM)", { timeout: 600_000 }, () => {
  let env: FleetEnv
  let h: Harness
  let mock: Mock
  let idOf: (text: string) => string
  let agentRecord: (taskId: string) => AgentRecord | undefined
  let settle: (id: string) => Promise<string>

  before(async () => {
    env = await createFleetEnv()
    ;({ h, mock, idOf, agentRecord, settle } = env)
  })

  after(async () => {
    await env.close()
  })

  test("a worker rewinding the target branch is refused once, then the next horde_land accepts it", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } }, tiers: ["mock/mock", "mock/pricey"] }))
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    const c0 = git(r, "rev-parse", "HEAD")
    fs.writeFileSync(path.join(r, "master.txt"), "m\n")
    git(r, "add", "master.txt")
    git(r, "commit", "-qm", "master moves")
    const id = idOf(
      await h.call("horde_do", {
        directory: r,
        goal: `Write the file.\nRUN: echo ok > w.txt && git add w.txt && git commit -qm w\nRUN: git update-ref refs/heads/master ${c0}`,
        done: ["w.txt says ok"],
        scope: ["w.txt"],
      }),
    )
    const ready = await settle(id)
    assert.match(ready, /READY/, ready)
    const record = agentRecord(id)!
    assert.match(record.gateState?.verdict?.text ?? "", /the target branch moved backwards or was rewritten/, "the gate notes the move")

    const refused = await h.call("horde_land", { id })
    assert.match(refused, /^not landed: the target branch moved backwards or was rewritten/, refused)
    assert.match(refused, /call again to go on from/, refused)
    assert.equal(agentRecord(id)?.pendingTip, c0, "the shown tip is pending confirmation")

    const landed = await h.call("horde_land", { id })
    assert.match(landed, new RegExp(`^landed ${id} on master:`), landed)
    assert.equal(git(r, "show", "--name-only", "--format=", "HEAD"), "w.txt", "only the worker's file landed")
    assert.ok(fs.existsSync(path.join(r, "w.txt")), "the worker's file landed")
    assert.doesNotMatch(git(r, "log", "--format=%s"), /^master moves$/m, "the rewound commit stayed off the branch")
    assert.equal(git(r, "log", "-1", "--format=%s"), "w")
  })

  test("a worker that rebases onto the user's new commits is not failed by the gate; horde_land asks once, then lands", async () => {
    const { repo: r } = makeRepo(mock.url, { permission: { bash: "allow" } })
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } }, tiers: ["mock/mock", "mock/pricey"] }))
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    const started = await h.call("horde_do", {
      directory: r,
      goal: ["Write the file.", "RUN: echo ok > w.txt && git add w.txt && git commit -qm w", "RUN: sleep 8", "RUN: git rebase master"].join("\n"),
      done: ["w.txt says ok"],
      scope: ["w.txt"],
    })
    const id = idOf(started)
    const branch = started.match(/worktree (horde\/[\w-]+)/)![1]!
    await until(async () => git(r, "log", "--format=%s", branch).split("\n").includes("w"), 60_000, 200)
    fs.writeFileSync(path.join(r, "master.txt"), "m\n")
    git(r, "add", "master.txt")
    git(r, "commit", "-qm", "master moves")
    const ready = await settle(id)
    assert.match(ready, /^t-\w+ READY/, ready)
    const record = agentRecord(id)!
    assert.equal(record.gateState?.verdict?.pass, true, "the move did not fail the gate")
    assert.equal(record.gateState?.round, 1, "no failing round was consumed")
    assert.match(record.gateState?.verdict?.text ?? "", /the worker's branch contains the target's new tip: the worker may have moved the branch itself/)

    const refused = await h.call("horde_land", { id })
    assert.match(refused, /^not landed: the target branch's tip is on the worker's branch; the worker moved it/, refused)
    assert.match(refused, /the worker's branch contains the target's new tip: the worker may have moved the branch itself/, refused)
    assert.match(refused, /call again to go on from/, refused)
    assert.equal(agentRecord(id)?.pendingTip, git(r, "rev-parse", "HEAD"))

    const landed = await h.call("horde_land", { id })
    assert.match(landed, new RegExp(`^landed ${id} on master: 1 commit\\(s\\)`), landed)
    assert.ok(fs.existsSync(path.join(r, "w.txt")))
    assert.ok(fs.existsSync(path.join(r, "master.txt")), "the user's commit is still on the branch")
  })

  test("horde_tell during a land, and a second horde_land during or after it, are refused cleanly", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(
      path.join(r, "horde.json"),
      JSON.stringify({
        verify: { checks: { test: "true", slow: { command: `node -e "setTimeout(() => process.exit(0), 4000)"`, when: "land" } } },
        tiers: ["mock/mock", "mock/pricey"],
      }),
    )
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    const id = idOf(
      await h.call("horde_do", {
        directory: r,
        goal: "Write the file.\nRUN: echo ok > f.txt && git add f.txt && git commit -qm f",
        done: ["f.txt says ok"],
        scope: ["f.txt"],
      }),
    )
    assert.match(await settle(id), /READY/)
    const landing = h.call("horde_land", { id })
    await until(
      async () => {
        try {
          await h.call("horde_tell", { id, message: "TOOL: echo late > late.txt" })
          return false
        } catch (err) {
          return /the task is landing; wait for horde_land's answer/.test((err as Error).message)
        }
      },
      30_000,
      100,
    )
    await assert.rejects(h.call("horde_tell", { id, message: "TOOL: echo late > late.txt" }), /the task is landing; wait for horde_land's answer/)
    await assert.rejects(h.call("horde_tell", { id, scope: ["f.txt"] }), /the task is landing; wait for horde_land's answer/)
    await assert.rejects(h.call("horde_tell", { id, done: ["still the file"] }), /the task is landing; wait for horde_land's answer/)
    await assert.rejects(h.call("horde_land", { id }), /the task is landing; wait for horde_land's answer/)
    assert.match(await landing, new RegExp(`^landed ${id} on master`))
    await assert.rejects(h.call("horde_land", { id }), (err: Error) => {
      assert.match(err.message, /already landed/)
      assert.doesNotMatch(err.message, /ENOENT/)
      return true
    })
  })

  test("a fast-forward failure names git's own error, not the user's uncommitted changes", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } }, tiers: ["mock/mock", "mock/pricey"] }))
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    const id = idOf(
      await h.call("horde_do", {
        directory: r,
        goal: "Write the file.\nRUN: echo ok > ff.txt && git add ff.txt && git commit -qm ff",
        done: ["ff.txt says ok"],
        scope: ["ff.txt"],
      }),
    )
    assert.match(await settle(id), /READY/)
    // Every ref update is refused, so the fast-forward itself fails with git's message.
    const hooks = path.join(r, "hooks")
    fs.mkdirSync(hooks)
    fs.writeFileSync(path.join(hooks, "reference-transaction"), "#!/bin/sh\nexit 1\n")
    if (process.platform !== "win32") fs.chmodSync(path.join(hooks, "reference-transaction"), 0o755)
    git(r, "config", "core.hooksPath", hooks)
    try {
      const refused = await h.call("horde_land", { id })
      assert.match(refused, /not landed:/, refused)
      assert.match(refused, /update aborted by the reference-transaction hook/, refused)
      assert.doesNotMatch(refused, /collide with your uncommitted changes/, refused)
    } finally {
      git(r, "config", "--unset", "core.hooksPath")
    }
    await h.call("horde_drop", { id })
  })

  test("the workers.land commit is judged by a git-ignored hooksPath commit-msg hook", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(
      path.join(r, "horde.json"),
      JSON.stringify({
        verify: { checks: { test: "true" } },
        workers: { land: `node -e "require('fs').writeFileSync('generated.txt','x')"` },
        tiers: ["mock/mock", "mock/pricey"],
      }),
    )
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    // husky v9: core.hooksPath points at a directory git ignores, so the worktree has no hook and
    // the land step's plain commit would never run it without judging the commits here.
    const husky = path.join(r, ".husky", "_")
    fs.mkdirSync(husky, { recursive: true })
    fs.writeFileSync(path.join(husky, "commit-msg"), '#!/bin/sh\ngrep -q "^feat:" "$1" || { echo "message must start with feat:" >&2; exit 1; }\n')
    if (process.platform !== "win32") fs.chmodSync(path.join(husky, "commit-msg"), 0o755)
    fs.appendFileSync(path.join(r, ".gitignore"), ".husky/_\n")
    git(r, "add", ".gitignore")
    git(r, "commit", "-qm", "ignore husky internals")
    git(r, "config", "core.hooksPath", ".husky/_")
    const id = idOf(
      await h.call("horde_do", {
        directory: r,
        goal: "Write the file.\nRUN: echo ok > landed.txt && git add landed.txt && git commit -qm 'feat: landed'",
        done: ["landed.txt says ok"],
        scope: ["landed.txt"],
      }),
    )
    assert.match(await settle(id), /READY/)
    const before = git(r, "rev-parse", "HEAD")
    const refused = await h.call("horde_land", { id })
    assert.match(refused, /did not pass the repository's commit-msg hook/, refused)
    assert.match(refused, /message must start with feat:/, refused)
    assert.match(refused, /Update files that depend on master/, refused)
    assert.equal(git(r, "rev-parse", "HEAD"), before, "master did not move")
    await h.call("horde_drop", { id })
  })

  test("a reconnect after a failed first load keeps the news file", async () => {
    const { tmp: at, repo: r } = makeRepo(mock.url)
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } }, tiers: ["mock/mock"] }))
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    // The server cannot load this directory at startup; fixing it makes the next call work.
    const bad = path.join(at, "bad-config")
    fs.mkdirSync(bad)
    fs.writeFileSync(path.join(bad, "horde.json"), "{ not json")
    const session = "test-landing-reconnect"
    const eh = await connect({ ...isolatedEnv(at, r), HORDE_OPENCODE_DIRECTORY: bad, CLAUDE_CODE_SESSION_ID: session })
    const newsFile = path.join(at, "state", "news", `${session}.json`)
    const read = () => {
      try {
        return JSON.parse(fs.readFileSync(newsFile, "utf8")) as { waiting: { id: string }[] }
      } catch {
        return undefined
      }
    }
    try {
      fs.writeFileSync(path.join(bad, "horde.json"), "{}")
      const id = idOf(
        await eh.call("horde_do", {
          directory: r,
          goal: "Write the file.\nRUN: echo ok > news.txt && git add news.txt && git commit -qm news",
          done: ["news.txt says ok"],
          scope: ["news.txt"],
        }),
      )
      await until(async () => read()?.waiting.some((w) => w.id === id), 120_000, 300)
      const pid = Number((await eh.call("opencode_server", { action: "info" })).match(/pid (\d+)/)![1])
      process.kill(pid, "SIGKILL")
      // The dead backend makes the next call reconnect; the waiting outcome must survive.
      await until(
        async () => {
          try {
            await eh.call("opencode_models")
            return true
          } catch {
            return false
          }
        },
        60_000,
        500,
      )
      assert.ok(
        read()?.waiting.some((w) => w.id === id),
        "the waiting outcome survived the reconnect",
      )
    } finally {
      await eh.call("opencode_server", { action: "stop" }).catch(() => undefined)
      await eh.close()
    }
  })
})

describe("fleet landing: pure helpers and stranded workers", () => {
  test("followRebase clears a merged marker the new base has passed", async () => {
    const { tmp: at, repo } = makeRepo("http://127.0.0.1:1")
    const base = git(repo, "rev-parse", "HEAD")
    const root = path.join(at, "wt")
    git(repo, "worktree", "add", "-q", "-b", "worker", root, base)
    fs.writeFileSync(path.join(root, "w.txt"), "w\n")
    git(root, "add", "w.txt")
    git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "w")
    fs.writeFileSync(path.join(repo, "master.txt"), "m\n")
    git(repo, "add", "master.txt")
    git(repo, "commit", "-qm", "master moves")
    git(root, "rebase", "-q", "master")
    const newBase = git(repo, "rev-parse", "HEAD")
    const followed = await followRebase({ path: root, root, branch: "worker", base, merged: base, repo })
    assert.equal(followed.base, newBase, "the base followed the rebase")
    assert.equal(followed.merged, undefined, "the passed merged marker is cleared")
    assert.equal(workStart(followed), newBase)
    git(repo, "worktree", "remove", "--force", root)
    git(repo, "branch", "-D", "worker")
  })

  test("close marks a needs_input worker stranded and stops a child-process runtime with a restart reason", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "horde-landing-close-"))
    const store = new Store(path.join(tmp, "state"))
    const fleet = new Fleet(BACKEND, CONFIG(tmp), store, HOOKS)
    const removed: string[] = []
    const codex = {
      kind: "codex",
      events: new EventEmitter(),
      remove: async (id: string) => {
        removed.push(id)
      },
    } as unknown as Runtime
    ;(fleet as unknown as { runtimes: Map<string, Runtime> }).runtimes.set("codex", codex)
    const record = (id: string, runtime?: AgentRecord["runtime"]): AgentRecord => ({
      id,
      server: "local",
      ...(runtime ? { runtime } : {}),
      directory: tmp,
      policy: "ask",
      questions: "ask",
      limits: {},
      createdAt: 1,
      reportedSeq: 0,
      owner: SELF,
      ownerSeen: Date.now(),
    })
    const needsInput = "ses_needs_input"
    const codexId = "ses_codex"
    store.put(record(needsInput))
    store.put(record(codexId, "codex"))
    const adopt = fleet as unknown as { adoptRecord: (r: AgentRecord) => { state?: string } }
    adopt.adoptRecord(store.get(needsInput)!).state = "needs_input"
    adopt.adoptRecord(store.get(codexId)!).state = "needs_input"
    try {
      await fleet.close({ keepNews: true, goneAt: Date.now() })
      assert.match(store.get(needsInput)?.stopReason ?? "", /its OpenCode session is gone/, "needs_input is stranded too")
      assert.deepEqual(removed, [codexId], "the child process was stopped")
      const reason = store.get(codexId)?.stopReason ?? ""
      assert.match(reason, /the horde restarted while this worker ran/)
      assert.match(reason, /its process was stopped/)
      assert.match(reason, /horde_drop the task and horde_do it again/)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("a restarted child-runtime record is reported FAILED with its reason and disposed cleanly", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "horde-landing-restart-"))
    const store = new Store(path.join(tmp, "state"))
    const id = "ses_restart"
    store.put({
      id,
      server: "local",
      runtime: "codex",
      directory: tmp,
      policy: "ask",
      questions: "ask",
      limits: {},
      createdAt: 1,
      reportedSeq: 0,
      stopReason:
        "the horde restarted while this worker ran; its process was stopped, and its conversation cannot be resumed here: horde_drop the task and horde_do it again",
    })
    const fleet = new Fleet(BACKEND, { ...CONFIG(tmp), codexBin: "codex" }, store, HOOKS)
    const removed: string[] = []
    ;(fleet as unknown as { runtimes: Map<string, Runtime> }).runtimes.set("codex", {
      kind: "codex",
      events: new EventEmitter(),
      remove: async (x: string) => {
        removed.push(x)
      },
    } as unknown as Runtime)
    try {
      const text = await outcome(fleet, id)
      assert.match(text, /FAILED/, text)
      assert.match(text, /the horde restarted while this worker ran/, text)
      assert.doesNotMatch(text, /unknown codex session|does not exist on the cursor runtime/, text)
      assert.match(await fleet.dispose(id, { worktree: "remove" }), /stopped tracking/)
      assert.equal(store.get(id), undefined, "the record is gone")
    } finally {
      await fleet.close({ keepNews: true })
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("a gate fix that cannot be sent fails the board attempt and publishes the news", async () => {
    const { tmp: at, repo } = makeRepo("http://127.0.0.1:1")
    const boardState = path.join(at, "board-state")
    const saved = process.env.HORDE_BOARD_STATE_DIR
    process.env.HORDE_BOARD_STATE_DIR = boardState
    const tmp = at
    const store = new Store(path.join(tmp, "state"))
    const news = new News(path.join(tmp, "state"), "test-landing-fix")
    const fleet = new Fleet(BACKEND, CONFIG(tmp), store, HOOKS, news)
    try {
      const board = await Board.open(repo, boardState)
      const task = (await board.plan([{ title: "Fix me", goal: "g", scope: [] }])).tasks[0]!
      const { attempt } = await board.assign(task.id)
      const id = "ses_fix"
      store.put({
        id,
        server: "local",
        directory: repo,
        policy: "ask",
        questions: "ask",
        limits: {},
        createdAt: 1,
        reportedSeq: 0,
        owner: SELF,
        ownerSeen: Date.now(),
        gate: { audit: false, maxRounds: 2 },
        gateState: { round: 1, verdict: { turn: 1, pass: false, final: false, text: "checks failed", at: 1 } },
        task: { id: task.id, title: task.title, attempt: attempt.n },
      })
      const fleetAny = fleet as unknown as {
        adoptRecord: (r: AgentRecord) => { state?: string; track: ReturnType<typeof emptyTrack>; fix?: unknown; record: AgentRecord }
        deliverFix: (l: unknown) => Promise<void>
        sendPrompt: () => Promise<never>
      }
      const live = fleetAny.adoptRecord(store.get(id)!)
      live.state = "idle"
      live.track.turns.push(turnAt(1))
      live.fix = { turn: 1, round: 1, text: "checks failed" }
      fleetAny.sendPrompt = async () => {
        throw new Error("the backend went away")
      }
      await fleetAny.deliverFix(live)
      const failed = board.task(task.id)
      assert.equal(failed.status, "failed", "the board attempt is failed")
      assert.match(failed.attempts[0]?.note ?? "", /could not send the failure back to the agent/)
      await until(
        async () => {
          try {
            const n = JSON.parse(fs.readFileSync(path.join(tmp, "state", "news", "test-landing-fix.json"), "utf8")) as { waiting: { id: string }[] }
            return n.waiting.some((w) => w.id === task.id)
          } catch {
            return false
          }
        },
        10_000,
        100,
      )
    } finally {
      await fleet.close({ keepNews: true })
      if (saved === undefined) delete process.env.HORDE_BOARD_STATE_DIR
      else process.env.HORDE_BOARD_STATE_DIR = saved
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("message, respond, setScope and setDone refuse while the task is landing", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "horde-landing-guards-"))
    const store = new Store(path.join(tmp, "state"))
    const fleet = new Fleet(BACKEND, CONFIG(tmp), store, HOOKS)
    const id = "ses_landing"
    store.put({
      id,
      server: "local",
      directory: tmp,
      policy: "ask",
      questions: "ask",
      limits: {},
      createdAt: 1,
      reportedSeq: 0,
      owner: SELF,
      ownerSeen: Date.now(),
    })
    const fleetAny = fleet as unknown as { adoptRecord: (r: AgentRecord) => unknown; landingTasks: Set<string> }
    fleetAny.adoptRecord(store.get(id)!)
    fleetAny.landingTasks.add(id)
    const landing = /the task is landing; wait for horde_land's answer/
    try {
      await assert.rejects(fleet.message(id, "hi"), landing)
      await assert.rejects(fleet.respond(id, "req", {}), landing)
      await assert.rejects(fleet.setScope(id, ["a.txt"]), landing)
      await assert.rejects(fleet.setDone(id, ["a.txt exists"]), landing)
    } finally {
      await fleet.close({ keepNews: true })
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("outcome ignores a pass verdict from an earlier turn", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "horde-landing-outcome-"))
    const snapshot: Snapshot = {
      id: "ses_old_pass",
      title: "",
      state: "idle",
      directory: tmp,
      policy: "ask",
      questionPolicy: "ask",
      limits: {},
      pending: { permissions: [], questions: [] },
      unreported: [],
      lastTurn: turnAt(2),
      steps: 0,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      children: [],
    }
    const record: AgentRecord = {
      id: "ses_old_pass",
      server: "local",
      directory: tmp,
      policy: "ask",
      questions: "ask",
      limits: {},
      createdAt: 1,
      reportedSeq: 0,
      gateState: { round: 1, verdict: { turn: 1, pass: true, final: true, text: "checks ✓", at: 1 } },
    }
    const fake = { inspect: async () => ({ snapshot, record, refused: [] }) } as unknown as Fleet
    const text = await outcome(fake, "ses_old_pass")
    assert.doesNotMatch(text, /READY/, text)
    assert.match(text, /FAILED/, text)
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})
