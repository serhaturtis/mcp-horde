import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, mock as mockTimers, test } from "node:test"
import { Board } from "@mcp-horde/board"
import { Backend } from "../src/backend.js"
import type { Config } from "../src/config.js"
import { Fleet, type Hooks, type Snapshot, scopeGlobs } from "../src/fleet.js"
import { outcome } from "../src/horde.js"
import { type AgentRecord, OWNER_STALE_MS, ownerAlive, SELF, Store } from "../src/state.js"
import { emptyTrack, type Track } from "../src/tracker.js"
import { connect, git, type Harness, isolatedEnv, type Mock, makeRepo, opencodeBin, until } from "./harness.js"
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

  test("the fleet's board activity drops a task's locks outside its scope", async () => {
    const { tmp, repo } = makeRepo("http://127.0.0.1:1")
    const board = await Board.open(repo, path.join(tmp, "board-state"))
    const task = (await board.plan([{ title: "Scoped", goal: "g", scope: ["src/a.ts"] }])).tasks[0]!
    const { attempt } = await board.assign(task.id)
    await board.lock(task.id, attempt.token, ["src/a.ts"])
    // A lock on a file the task may not change is taken (the worker's own command) but not kept.
    await board.lock(task.id, attempt.token, ["package.json"])
    assert.deepEqual(
      board
        .locks()
        .map((l) => l.path)
        .sort(),
      ["package.json", "src/a.ts"],
    )
    await board.recordActivity(task.id, attempt.n, { state: "idle", gate: "fail 2/2" })
    assert.deepEqual(
      board.locks().map((l) => l.path),
      ["src/a.ts"],
    )
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
      passEnv: [],
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
      passEnv: [],
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
    passEnv: [],
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

describe("fleet fixes: a long open turn is read incrementally (real opencode, mock LLM)", { timeout: 600_000 }, () => {
  test("150 shell steps decode message JSON about once, not the whole transcript on every refresh", async () => {
    const mock = await startMockLlm()
    const { tmp, repo } = makeRepo(mock.url, { permission: { bash: "allow" } })
    // The private server takes its environment from this process.
    const saved = new Map<string, string | undefined>()
    for (const [key, value] of Object.entries(isolatedEnv(tmp, repo))) {
      saved.set(key, process.env[key])
      process.env[key] = value
    }
    const config: Config = {
      username: "opencode",
      allowInsecure: false,
      serverMode: "private",
      passEnv: [],
      bin: opencodeBin,
      directory: repo,
      defaultPermissions: "allow",
      maxRunning: 0,
      maxRunningFrom: "test",
      stateDir: path.join(tmp, "state"),
      worktreeDir: path.join(tmp, "worktrees"),
      channel: false,
      elicitTimeoutMs: 600_000,
    }
    let backend: Backend | undefined
    let fleet: Fleet | undefined
    try {
      const store = new Store(config.stateDir)
      // OpenCode starts its server (and any workers) with this process's execArgv; the test
      // runner's --import of scripts/test-env.mjs is relative to packages/opencode and would
      // make the server fail to resolve it from its own directory.
      const argv = process.execArgv
      process.execArgv = []
      try {
        backend = await Backend.start(config, store)
      } finally {
        process.execArgv = argv
      }
      // The read counter: every message the fleet decodes (list pages and single re-reads) is
      // added as its JSON size, so this measures what the old whole-turn re-reads decoded.
      let decoded = 0
      let lists = 0
      let gets = 0
      const client = backend.client
      const counting = {
        ...client,
        message: {
          ...client.message,
          list: async (input: Parameters<typeof client.message.list>[0], opts?: Parameters<typeof client.message.list>[1]) => {
            lists++
            const res = await client.message.list(input, opts)
            decoded += Buffer.byteLength(JSON.stringify(res.data))
            return res
          },
        },
        session: {
          ...client.session,
          message: {
            ...client.session.message,
            get: async (input: Parameters<typeof client.session.message.get>[0], opts?: Parameters<typeof client.session.message.get>[1]) => {
              gets++
              const message = await client.session.message.get(input, opts)
              decoded += Buffer.byteLength(JSON.stringify(message))
              return message
            },
          },
        },
      }
      // The real event stream, with the counting client in front of it.
      const readBackend = {
        get client() {
          return counting
        },
        get info() {
          return backend!.info
        },
        events: backend.events,
        get streaming() {
          return backend!.streaming
        },
        get dead() {
          return backend!.dead
        },
      } as unknown as Backend
      fleet = new Fleet(readBackend, config, store, {
        canElicit: () => false,
        askPermission: async () => undefined,
        askQuestion: async () => undefined,
        settled: () => {},
      })
      const { snapshot } = await fleet.spawn({ prompt: "STEPS: 150", name: "long", directory: repo, isolation: "none", permissions: "allow" })
      const waited = await fleet.waitFor([snapshot.id], "all", 600_000, { markReported: false })
      assert.deepEqual(waited.errors, [])
      assert.equal(waited.snapshots[0]?.state, "idle")
      assert.ok((waited.snapshots[0]?.steps ?? 0) >= 150, `only ${waited.snapshots[0]?.steps} steps ran`)
      const live = await fleet.get(snapshot.id)
      const transcript = Buffer.byteLength(JSON.stringify(live.track.messages))
      assert.ok(transcript > 0)
      const ratio = decoded / transcript
      assert.ok(
        decoded < transcript * 3,
        `decoded ${decoded} bytes over ${lists} list and ${gets} get reads: ${ratio.toFixed(1)}x the ${transcript}-byte transcript (the old whole-turn read was quadratic)`,
      )
    } finally {
      fleet?.close()
      backend?.close()
      mock.close()
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
