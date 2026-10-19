import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Board, isTrustedCommand, renderBrief } from "@mcp-horde/board"
import { git, loadTiers, oneLine, tierLabel, tierModel } from "@mcp-horde/core"
import { gate as runGate, defaultStateDir as verifyStateDir } from "@mcp-horde/verify"
import type {
  AgentV2Info,
  ModelRef,
  ModelV2Info,
  PermissionSavedInfo,
  PermissionV2Request,
  QuestionV2Request,
  SessionMessage,
  SessionV2Info,
  V2Event,
} from "@opencode-ai/sdk/v2"
import {
  ASK_AGENT,
  ASK_GUARDED_AGENT,
  ASK_GUARDED_PROFILE,
  ASK_PREAMBLE,
  ASK_PROFILE,
  extractJson,
  type JsonSchema,
  retryPrompt,
  schemaPrompt,
  validate,
} from "./ask.js"
import type { Backend } from "./backend.js"
import { deleteSession, releaseDirectory, renameSession } from "./compat.js"
import { type Config, inProject, type PermissionPolicy } from "./config.js"
import { type Detail, inputSummary, renderTranscript } from "./render.js"
import { type AgentRecord, type GateConfig, type Limits, ownerAlive, SELF, type Store } from "./state.js"
import { apply, type CostEstimator, costSince, currentTurn, type DurableEvent, emptyTrack, latestTool, type Track, type Turn, turnsSince } from "./tracker.js"
import { commitAll, createWorktree, excludeFromGit, mergeWorktree, removeWorktree, syncWorktree, type Worktree, workStart, worktreeDiff } from "./worktree.js"

/**
 * running      – the agent loop is executing (or about to start on a fresh prompt)
 * needs_input  – blocked on a permission request or question for the caller (opencode_respond)
 * idle         – finished its last turn and waits for a new message
 * interrupted  – stopped by opencode_interrupt or by a limit; resume with opencode_message
 * error        – the last turn failed (or never started)
 */
export type AgentState = "running" | "needs_input" | "idle" | "interrupted" | "error"
export const SETTLED: ReadonlySet<AgentState> = new Set(["needs_input", "idle", "interrupted", "error"])
export type QuestionPolicy = AgentRecord["questions"]

/** A quiet open turn gets this long before we call it stuck. */
const GRACE_MS = 10_000
/** An admitted prompt gets this long to start (a fresh directory needs time to load). */
const START_GRACE_MS = 30_000
const FIRST_START_GRACE_MS = 60_000
const POLL_MS = 1_000
/** Settled agents are mostly kept current by events; poll them slowly as a safety net. */
const SETTLED_REFRESH_MS = 60_000
const DORMANT_REFRESH_MS = 10 * 60_000
const CHILD_SCAN_MS = 30_000
/** A child session with no activity for this long is no longer polled. */
const CHILD_COOL_MS = 60_000
/** Any single OpenCode request a refresh, a tick or a wait makes gets this long. */
const REQUEST_MS = 30_000
/** A whole background tick (all due refreshes) gets this long before the next may start. */
const TICK_MS = 120_000
/** How often the owner's heartbeat is written into its records. */
const HEARTBEAT_MS = 30_000

export interface Pending {
  permissions: PermissionV2Request[]
  questions: QuestionV2Request[]
}

export interface Snapshot {
  id: string
  name?: string
  title: string
  state: AgentState
  directory: string
  agent?: string
  model?: ModelRef
  worktree?: Worktree
  policy: PermissionPolicy
  questionPolicy: QuestionPolicy
  limits: Limits
  activity?: string
  error?: string
  retry?: string
  pending: Pending
  /** Turns that finished since the caller last saw a result. */
  unreported: Turn[]
  lastTurn?: Turn
  steps: number
  cost: number
  tokens: Track["tokens"]
  /** Context window use after the latest step, and the model's window when the catalog knows it. */
  context?: { used: number; limit?: number; compactions: number }
  children: string[]
  /** Present when the agent has a gate. */
  gate?: GateView
  /** The board task this agent works, when spawned with one. */
  task?: { id: string; title: string; attempt: number }
}

export interface GateView {
  /**
   * pending: the turn finished and its gate is about to run; running: checks are
   * running; retrying: the gate failed and the agent is fixing it; pass / fail:
   * decided (fail = no rounds left).
   */
  state: "pending" | "running" | "retrying" | "pass" | "fail"
  round: number
  maxRounds: number
  /** The latest verdict, compact. */
  text?: string
  /** retrying: the gate failed and its fix waits for a running slot (the running limit is reached). */
  queued?: boolean
}

/** A gate that has not decided yet: the agent is not done, whatever its session says. */
export function gateUndecided(s: Snapshot): boolean {
  return !!s.gate && s.gate.state !== "pass" && s.gate.state !== "fail"
}

export interface Profile {
  /** Tool switches, e.g. { bash: false, webfetch: false }. */
  tools?: Record<string, boolean>
  /** Hard cap on agent-loop steps per turn, enforced by OpenCode. */
  steps?: number
  description?: string
  /** OpenCode permission rules, e.g. { edit: { "src/**": "allow", "*": "deny" } }. */
  permission?: Record<string, string | Record<string, string>>
}

/** Paths an agent may edit; everything else is refused ("deny") or asked about ("ask"). */
export interface Scope {
  paths: string[]
  outside?: "deny" | "ask"
}

export interface SpawnInput {
  /** The task; with `task`, extra instructions appended to the board's brief. */
  prompt: string
  /** A board task to work: the prompt is its brief, and the attempt is recorded on the board. */
  task?: string
  name?: string
  model?: string
  variant?: string
  agent?: string
  instructions?: string
  profile?: Profile
  directory?: string
  isolation?: "none" | "worktree"
  worktree?: { includeUncommitted?: boolean; link?: string[]; setup?: string; submodules?: boolean }
  permissions?: PermissionPolicy
  questions?: QuestionPolicy
  limits?: Limits
  files?: string[]
  gate?: GateInput
  /** Edits outside these paths are refused by OpenCode (needs isolation "worktree"). */
  scope?: Scope
  signal?: AbortSignal
  onProgress?: (message: string) => void
}

/** How a caller asks for a gate: true for the defaults, or settings. */
export type GateInput = boolean | { checks?: string[]; audit?: boolean; allowed?: string[]; maxRounds?: number; related?: boolean }

export interface Hooks {
  /** True when the client can show form dialogs to the human. */
  canElicit(): boolean
  askPermission(snap: Snapshot, req: PermissionV2Request, signal: AbortSignal): Promise<{ reply: "once" | "always" | "reject"; message?: string } | undefined>
  askQuestion(snap: Snapshot, req: QuestionV2Request, signal: AbortSignal): Promise<string[][] | "dismiss" | undefined>
  /** Called when an agent settles or newly needs input (channel push). */
  settled(snap: Snapshot): void
}

interface Live {
  record: AgentRecord
  track: Track
  loaded: boolean
  session?: SessionV2Info
  state?: AgentState
  error?: string
  pending: Pending
  children: Set<string>
  childTracks: Map<string, Track>
  /** Children with recent activity: only these are polled. */
  hotChildren: Map<string, number>
  liveText: string
  retry?: { attempt: number; message: string }
  lastRefresh: number
  lastChildScan: number
  /** Request ids answered automatically or currently shown to the human. */
  handled: Set<string>
  /** Open dialogs, so a caller's answer can close them. */
  dialogs: Map<string, AbortController>
  /** Request ids already shown to the caller by opencode_wait. */
  reportedRequests: Set<string>
  /** Requests the human dismissed (or a dialog failed): they go to the calling model. */
  handedToCaller: Set<string>
  /** When the agent last went from running to settled. */
  settledAt: number
  /** Bumped on every prompt we send; refreshes started before it do not publish state. */
  gen: number
  /**
   * A prompt we sent that history does not show yet. OpenCode can answer the
   * prompt call before the admission is readable, and until then the previous
   * (settled) turn would look current.
   */
  sent?: { at: number; seq: number }
  /** Start seq of the turn a limit already stopped: never stop the same turn twice. */
  limitedTurn?: number
  /** Local time a turn was first seen live, for time limits that do not depend on server clocks. */
  turnSeen: Map<number, number>
  lastPushKey?: string
  running?: Promise<void>
  queued?: Promise<void>
  /** A gate run in flight, for the turn that started at `turn`. */
  gating?: { turn: number; abort: AbortController }
  /** Prompts being sent right now: a gate must not start on the turn they are about to supersede. */
  sending: number
  /** Operations on the worktree or session (merge, sync, revert, compact) that a gate must not overlap. */
  holdGate: number
  /** A gate failure whose fix prompt waits for a running slot (sent from the monitor tick). */
  fix?: { turn: number; round: number; text: string }
  /**
   * We interrupted while a prompt we sent was not in history yet (so its turn could not be
   * stopped): the turn it starts is interrupted as soon as it shows up.
   */
  stopSent?: { gen: number; at: number }
  /** Local time each admitted prompt was first seen, for grace windows independent of the server's clock. */
  admittedSeen: Map<string, number>
  /** Local time history last grew. */
  lastNewEventAt: number
  /** The board of the agent's repository: the only one its trusted commands may name. */
  boardDir?: string
  /** The last activity written to the board (task-bound agents). */
  activity?: { key: string; write: Promise<void> }
}

type Res<T> = { data?: T; error?: unknown; response?: Response }

/** OpenCode answered a request with success but without the body the caller needs. */
export class EmptyResponseError extends Error {
  override name = "EmptyResponseError"
}

/** Throw on an error response; for calls whose answer is not used. */
function check(res: Res<unknown>, what: string) {
  if (res.error === undefined && (res.response?.ok ?? true)) return
  const e = res.error as { message?: string } | undefined
  const detail = e?.message ?? (e ? JSON.stringify(e) : `HTTP ${res.response?.status}`)
  throw new Error(`${what} failed: ${detail}`)
}

/** The answer of a successful request; throws on an error response and on a missing body. */
function unwrap<T>(res: Res<T>, what: string): T {
  check(res, what)
  if (res.data === undefined || res.data === null)
    throw new EmptyResponseError(`${what} failed: OpenCode answered HTTP ${res.response?.status ?? "?"} without a body`)
  return res.data
}

/** Request options that give up after `ms` (the SDK passes them to fetch). */
function timed(ms = REQUEST_MS): { signal: AbortSignal } {
  return { signal: AbortSignal.timeout(ms) }
}

/** Settle with `p`, or reject after `ms` (the work itself is not cancelled). */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${Math.round(ms / 1000)}s`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

export function parseModel(spec: string, variant?: string): ModelRef {
  const slash = spec.indexOf("/")
  if (slash <= 0 || slash === spec.length - 1) {
    throw new Error(`model must look like "provider/model" (e.g. "deepseek/deepseek-chat"), got "${spec}"`)
  }
  return { providerID: spec.slice(0, slash), id: spec.slice(slash + 1), ...(variant ? { variant } : {}) }
}

export function formatModel(m?: ModelRef): string {
  if (!m) return "default model"
  return `${m.providerID}/${m.id}${m.variant && m.variant !== "default" ? ` [${m.variant}]` : ""}`
}

/** Why the OpenCode v2 session runner cannot use a model, if it cannot. */
export function unsupportedReason(m: ModelV2Info): string | undefined {
  // Observed with opencode 1.19: "Unsupported API for <model>: native". These are
  // OpenCode-hosted models served through its own gateway protocol.
  if (m.api.type === "native") return "served through OpenCode's native gateway API, which the v2 session runner does not support yet"
  if (!m.capabilities.tools) return "does not support tool calls"
  return undefined
}

export function defaultQuestionPolicy(p: PermissionPolicy): QuestionPolicy {
  return p === "user" ? "user" : p === "ask" ? "ask" : "dismiss"
}

/**
 * A profile whose edits are confined to the scope: OpenCode's `edit` permission (its edit,
 * write and patch tools) as a glob map, the scope's paths allowed and everything else
 * `outside`. OpenCode applies the last matching rule, so the catch-all comes first.
 */
export function withScope(profile: Profile, scope: Scope): Profile {
  if (!scope.paths.length) throw new Error("scope.paths needs at least one path or glob")
  const rules: Record<string, string> = { "*": scope.outside ?? "deny" }
  for (const glob of scopeGlobs(scope.paths)) rules[glob] = "allow"
  return { ...profile, permission: { ...profile.permission, edit: rules } }
}

/** Scope paths as repo-relative globs ("src/" covers everything under src). */
export function scopeGlobs(paths: string[]): string[] {
  return paths.map((p) => {
    const glob = p.replace(/\\/g, "/").replace(/^\.\//, "")
    return glob.endsWith("/") ? `${glob}**` : glob
  })
}

/** Turn a caller's gate request into stored settings (audit defaults to on only in a worktree). */
export async function gateConfig(input: GateInput | undefined, directory: string, worktree: boolean, current?: GateConfig): Promise<GateConfig | undefined> {
  if (input === undefined) return current
  if (input === false) return undefined
  const o = input === true ? {} : input
  if (o.maxRounds !== undefined && (!Number.isInteger(o.maxRounds) || o.maxRounds < 1 || o.maxRounds > 10)) throw new Error("gate.max_rounds must be 1–10")
  // Outside a worktree the audit compares against HEAD at spawn; the human may be editing the same files.
  const base = worktree ? undefined : (current?.base ?? (await git(directory, "rev-parse", "HEAD").catch(() => undefined)))
  return defined({
    checks: o.checks ?? current?.checks,
    audit: o.audit ?? current?.audit ?? worktree,
    allowed: o.allowed ?? current?.allowed,
    maxRounds: o.maxRounds ?? current?.maxRounds ?? 2,
    related: o.related ?? current?.related ?? true,
    base,
  }) as GateConfig
}

/** What the agent is told when its gate fails. The verdict comes last, verbatim. */
export function gateFeedback(round: number, maxRounds: number, verdict: string): string {
  return [
    `The checks for this task failed (gate round ${round} of ${maxRounds}). Fix the problems below, then stop.`,
    "Do not skip, delete or weaken tests, do not silence errors or type checks, and stay within the files the task is about.",
    "",
    verdict,
  ].join("\n")
}

/** Drop undefined values, so a partial update never erases other fields. */
export function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

/** Orchestrates OpenCode sessions ("agents") through the OpenCode v2 API. */
export class Fleet {
  private readonly live = new Map<string, Live>()
  private readonly childToRoot = new Map<string, string>()
  /** Sessions disposed or found missing in this process: never re-adopt them implicitly. */
  private readonly gone = new Set<string>()
  private readonly modelCache = new Map<string, { at: number; models: ModelV2Info[] }>()
  private readonly wakeups = new Set<() => void>()
  /** Spawns in progress, counted against the running limit. */
  private reserved = 0
  /** Names of spawns in progress, taken until their record is stored. */
  private readonly reservedNames = new Set<string>()
  private lastHeartbeat = 0
  private monitor?: NodeJS.Timeout
  private monitoring = false
  private closed = false

  constructor(
    private readonly backend: Backend,
    private readonly config: Config,
    private readonly store: Store,
    private readonly hooks: Hooks,
  ) {
    this.syncStore()
    backend.events.on("event", (e: V2Event) => {
      try {
        this.onEvent(e)
      } catch {
        // Never let a bug here break the event stream.
      }
    })
    this.monitor = setInterval(() => {
      this.heartbeat()
      void this.tick()
    }, POLL_MS)
    this.monitor.unref()
  }

  /** Stop monitoring and hand our agents over: another MCP process may claim them at once. */
  close() {
    this.closed = true
    if (this.monitor) clearInterval(this.monitor)
    for (const l of this.live.values()) {
      l.gating?.abort.abort()
      l.gating = undefined
      l.fix = undefined
      for (const d of l.dialogs.values()) d.abort()
      try {
        this.store.update(l.record.id, { owner: undefined, ownerSeen: undefined })
      } catch {
        // best effort
      }
    }
    this.live.clear()
    this.childToRoot.clear()
    this.wake()
  }

  /**
   * Tell other MCP processes we still drive our agents (a stale heartbeat reads as a dead
   * owner), and let go of any agent another process claimed meanwhile.
   */
  private heartbeat(now = Date.now()) {
    if (this.closed || now - this.lastHeartbeat < HEARTBEAT_MS) return
    this.lastHeartbeat = now
    try {
      // Under the claim lock, so a claim and our heartbeat never interleave on one record.
      this.store.lockSync(
        "claim",
        () => {
          for (const l of [...this.live.values()]) {
            try {
              const r = this.store.get(l.record.id)
              if (r?.owner && r.owner.token !== SELF.token) this.dropLive(l.record.id)
              else if (r) this.store.put({ ...r, ownerSeen: now })
            } catch {
              // Persistence is best effort.
            }
          }
        },
        200, // never hold up the event loop for long: a missed beat is retried on the next tick
      )
    } catch {
      this.lastHeartbeat = 0 // lock busy: try again on the next tick
    }
  }

  private rootCache?: string

  /** The repository (or directory) this server works in: orphaned agents in it are claimed on sight. */
  private get projectRoot(): string {
    if (this.rootCache) return this.rootCache
    let dir = path.resolve(this.config.directory)
    for (;;) {
      if (existsSync(path.join(dir, ".git"))) break
      const up = path.dirname(dir)
      if (up === dir) {
        dir = path.resolve(this.config.directory)
        break
      }
      dir = up
    }
    this.rootCache = dir
    return dir
  }

  private get serverKey() {
    return this.backend.info.key
  }

  private get api() {
    return this.backend.client.v2
  }

  // ---------------------------------------------------------------- catalog

  async models(directory?: string): Promise<ModelV2Info[]> {
    const dir = this.resolveDir(directory)
    const cached = this.modelCache.get(dir)
    if (cached && Date.now() - cached.at < 60_000) return cached.models
    let models: ModelV2Info[] = []
    // A directory OpenCode has not opened yet answers with an empty catalog at first.
    for (let i = 0; i < 20; i++) {
      models = unwrap(await this.api.model.list({ location: { directory: dir } }, timed()), "listing models").data
      if (models.length) break
      await sleep(250)
    }
    if (models.length) this.modelCache.set(dir, { at: Date.now(), models })
    return models
  }

  /**
   * OpenCode 1.19's v2 runner reports every step as free, so price steps from
   * the catalog (USD per million tokens; reasoning is billed as output).
   */
  private estimator(directory: string): CostEstimator {
    return (model, tok) => {
      const info = this.modelCache.get(directory)?.models.find((m) => m.providerID === model.providerID && m.id === model.id)
      if (!info?.cost?.length) return undefined
      const context = tok.input + tok.cacheRead + tok.cacheWrite
      const tiers = info.cost.filter((c) => !c.tier || c.tier.size <= context).sort((a, b) => (a.tier?.size ?? 0) - (b.tier?.size ?? 0))
      const p = tiers[tiers.length - 1] ?? info.cost[0]!
      return (tok.input * p.input + (tok.output + tok.reasoning) * p.output + tok.cacheRead * p.cache.read + tok.cacheWrite * p.cache.write) / 1_000_000
    }
  }

  /** Rules saved by "always" answers for the project containing `directory`. */
  async savedPermissions(directory?: string): Promise<{ project: string; rules: PermissionSavedInfo[] }> {
    const dir = this.resolveDir(directory)
    const loc = unwrap(await this.api.location.get({ location: { directory: dir } }), "locating the project")
    const rules = unwrap(await this.api.permission.saved.list({ projectID: loc.project.id }), "listing saved permissions").data
    return { project: loc.project.directory, rules }
  }

  async removeSavedPermission(id: string, directory?: string): Promise<PermissionSavedInfo> {
    const { rules } = await this.savedPermissions(directory)
    const rule = rules.find((r) => r.id === id)
    if (!rule) throw new Error(`no saved permission ${id} for this project${rules.length ? `; saved: ${rules.map((r) => r.id).join(", ")}` : ""}`)
    check(await this.api.permission.saved.remove({ id }), "removing the saved permission")
    return rule
  }

  async agents(directory?: string): Promise<AgentV2Info[]> {
    const dir = this.resolveDir(directory)
    let agents: AgentV2Info[] = []
    for (let i = 0; i < 20; i++) {
      agents = unwrap(await this.api.agent.list({ location: { directory: dir } }), "listing agents").data
      if (agents.length) break
      await sleep(250)
    }
    return agents
  }

  private async validateModel(ref: ModelRef, directory: string) {
    const models = await this.models(directory)
    if (!models.length) throw new Error("OpenCode reports no models at all. Configure a provider (opencode auth login, or opencode.json) and retry.")
    const found = models.find((m) => m.providerID === ref.providerID && m.id === ref.id)
    if (!found) {
      const needle = ref.id.toLowerCase()
      const close = models
        .filter((m) => !unsupportedReason(m) && (m.providerID === ref.providerID || m.id.toLowerCase().includes(needle) || needle.includes(m.id.toLowerCase())))
        .slice(0, 10)
        .map((m) => `${m.providerID}/${m.id}`)
      throw new Error(
        `Unknown model "${ref.providerID}/${ref.id}".${close.length ? ` Did you mean: ${close.join(", ")}?` : ""} Use opencode_models to list available models.`,
      )
    }
    if (!found.enabled) throw new Error(`Model ${ref.providerID}/${ref.id} is disabled in the OpenCode config.`)
    const reason = unsupportedReason(found)
    if (reason) throw new Error(`Model ${ref.providerID}/${ref.id} cannot run agents: it is ${reason}. Pick another one from opencode_models.`)
    if (ref.variant && ref.variant !== "default" && !found.variants.some((v) => v.id === ref.variant)) {
      const names = found.variants.map((v) => v.id)
      throw new Error(
        `Model ${ref.providerID}/${ref.id} has no variant "${ref.variant}". ${names.length ? `Available: ${names.join(", ")}` : "It has no effort variants; omit variant."}`,
      )
    }
  }

  private async validateAgent(agent: string, directory: string) {
    const agents = await this.agents(directory)
    const found = agents.find((a) => a.id === agent)
    if (!found) {
      const names = agents.filter((a) => !a.hidden && a.mode !== "subagent").map((a) => a.id)
      throw new Error(`Unknown agent profile "${agent}". Available: ${names.join(", ")}`)
    }
    if (found.mode === "subagent") throw new Error(`Agent profile "${agent}" is subagent-only; pick a primary profile.`)
  }

  // ------------------------------------------------------------ lifecycle

  private working(l: Live) {
    return l.state === undefined || l.state === "running" || l.state === "needs_input"
  }

  /** Reserve a running slot synchronously, so concurrent calls cannot exceed the limit. */
  private reserve(): () => void {
    if (this.config.maxRunning > 0) {
      const busy = [...this.live.values()].filter((l) => this.working(l)).map((l) => l.record.name ?? l.record.id)
      if (busy.length + this.reserved >= this.config.maxRunning) {
        throw new Error(
          `${busy.length + this.reserved} agents are already working or starting (limit ${this.config.maxRunning}, from ${this.config.maxRunningFrom})${busy.length ? `: ${busy.join(", ")}` : ""}. Wait for one with opencode_wait, or stop one.`,
        )
      }
    }
    this.reserved++
    let released = false
    return () => {
      if (!released) this.reserved--
      released = true
    }
  }

  private resolveDir(dir?: string): string {
    return path.resolve(this.config.directory, dir ?? ".")
  }

  /** Agents not refreshed yet (e.g. after a restart) count as working; find out first. */
  private async refreshUnknown() {
    const unknown = [...this.live.values()].filter((l) => l.state === undefined)
    if (!unknown.length) return
    const active = await this.activeSet().catch(() => undefined)
    await Promise.allSettled(unknown.map((l) => this.refresh(l, active)))
  }

  async spawn(input: SpawnInput): Promise<{ snapshot: Snapshot; notes: string[] }> {
    if (this.config.maxRunning > 0) await this.refreshUnknown()
    const release = this.reserve()
    try {
      if (input.task) return await this.spawnTask(input, input.task)
      const checked = await this.checkSpawn(input)
      try {
        return await this.startSpawn(input, checked)
      } finally {
        checked.release()
      }
    } finally {
      release()
    }
  }

  /**
   * A one-shot answer: a session with no tools in the project's `.opencode/horde-ask/`
   * directory (fresh, so OpenCode loads the tool-less profile, and inside the project, so
   * its providers apply), one prompt, the answer, and the session is deleted. With a
   * schema the reply must be JSON that conforms; one retry is given with the problems.
   */
  async ask(input: {
    prompt: string
    model?: string
    variant?: string
    files?: string[]
    schema?: JsonSchema
    directory?: string
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<{ text: string; json?: unknown; cost: number; model?: ModelRef; retried: boolean; guarded: boolean }> {
    const project = this.resolveDir(input.directory)
    // Versioned, so a directory OpenCode opened with older profiles is never reused.
    const dir = path.join(project, ".opencode", "horde-ask-3")
    for (const [agent, profile] of [
      [ASK_AGENT, ASK_PROFILE],
      [ASK_GUARDED_AGENT, ASK_GUARDED_PROFILE],
    ] as const) {
      const file = path.join(dir, ".opencode", "agent", `${agent}.md`)
      if ((await fs.readFile(file, "utf8").catch(() => "")) !== profile) {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, profile)
      }
    }
    await excludeFromGit(project, ".opencode/horde-ask-3/").catch(() => undefined)
    const timeout = input.timeoutMs ?? 300_000
    const once = async (agent: string) => {
      const name = `ask-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      const { snapshot } = await this.spawn({
        prompt: ASK_PREAMBLE + (input.schema ? schemaPrompt(input.prompt, input.schema) : input.prompt),
        name,
        model: input.model,
        variant: input.variant,
        agent,
        directory: dir,
        files: input.files?.map((f) => path.resolve(project, f)),
        permissions: "deny",
        questions: "dismiss",
        limits: { maxSteps: 3 },
        signal: input.signal,
      })
      const answer = async (): Promise<Snapshot> => {
        const { snapshots, timedOut } = await this.waitFor([snapshot.id], "all", timeout, { signal: input.signal })
        const snap = snapshots[0]
        if (input.signal?.aborted) throw new Error("cancelled")
        if (timedOut || !snap) throw new Error(`no answer within ${Math.round(timeout / 1000)}s`)
        if (snap.state !== "idle") throw new Error(`the ask failed: ${snap.error ?? snap.state}`)
        return snap
      }
      try {
        let snap = await answer()
        let text = snap.lastTurn?.finalText.trim() ?? ""
        let retried = false
        let json: unknown
        if (input.schema) {
          const judge = (t: string) => {
            const parsed = extractJson(t)
            return parsed.error ? { errors: [parsed.error] } : { value: parsed.value, errors: validate(parsed.value, input.schema!) }
          }
          let result = judge(text)
          if (result.errors.length) {
            retried = true
            // Straight to the session: this ask already holds its running slot's worth of work.
            const live = await this.get(snapshot.id)
            await this.untilInactive(live)
            await this.sendPrompt(live, retryPrompt(result.errors), { files: [], inlined: [] })
            snap = await answer()
            text = snap.lastTurn?.finalText.trim() ?? ""
            result = judge(text)
            if (result.errors.length)
              throw new Error(`the answer did not match the schema after one retry:\n${result.errors.join("\n")}\nLast answer: ${text.slice(0, 500)}`)
          }
          json = result.value
        }
        return { text, json, cost: snap.cost, model: snap.model, retried }
      } finally {
        await this.dispose(snapshot.id, { deleteSession: true }).catch(() => undefined)
      }
    }
    try {
      return { ...(await once(ASK_AGENT)), guarded: false }
    } catch (err) {
      // OpenCode's free tier refuses tool-less agents; ask again with tools present but denied.
      if (!/FreeTierError/.test((err as Error).message)) throw err
      return { ...(await once(ASK_GUARDED_AGENT)), guarded: true }
    }
  }

  /**
   * Work a board task: start an attempt, brief the agent from the board (goal, done criteria,
   * scope, code context, reporting commands), and by default isolate it in a worktree with a
   * gate on the task's scope. The board records where the attempt works, so its report can
   * be checked against the diff.
   */
  private async spawnTask(input: SpawnInput, taskId: string): Promise<{ snapshot: Snapshot; notes: string[] }> {
    const directory = this.resolveDir(input.directory)
    const board = await Board.open(directory)
    const name = input.name ?? taskId
    const current = board.task(taskId)
    // A task whose attempt an agent of ours is still working on is that agent's, until it stops.
    const open = current.attempts[current.attempts.length - 1]
    if (open && !open.endedAt) {
      const holder =
        [...this.live.values()].find((l) => l.record.task?.id === taskId && l.record.task.attempt === open.n) ??
        (open.workspace?.session ? this.live.get(open.workspace.session) : undefined)
      if (holder) {
        await this.refresh(holder).catch(() => undefined)
        if (this.live.get(holder.record.id) === holder && this.working(holder))
          throw new Error(`${taskId} is being worked by ${holder.record.name ?? holder.record.id}; wait, interrupt or dispose it first`)
      }
    }
    // Without an explicit model, the task's tier picks one from horde.json "tiers".
    const tier = input.model ? undefined : tierModel(current.tier, loadTiers(directory), taskId)
    const effective: SpawnInput = {
      ...input,
      name,
      model: input.model ?? tier?.model,
      variant: input.model ? input.variant : (input.variant ?? tier?.variant),
      isolation: input.isolation ?? "worktree",
      gate: input.gate ?? (current.scope.length ? { allowed: current.scope } : true),
    }
    // Everything that can be checked is checked before the board records an attempt.
    const checked = await this.checkSpawn(effective)
    try {
      const { task, attempt } = await board.assign(taskId, name)
      const extra = input.prompt.trim()
      const prompt = `${renderBrief(board, task, attempt, 6000, directory)}${extra ? `\n\n## Additional instructions\n${extra}` : ""}`
      let result: { snapshot: Snapshot; notes: string[] }
      try {
        result = await this.startSpawn({ ...effective, prompt }, checked)
      } catch (err) {
        await board.fail(taskId, { reason: `the agent could not start: ${(err as Error).message}` }).catch(() => undefined)
        throw err
      }
      const snap = result.snapshot
      const wt = snap.worktree
      const base = wt ? workStart(wt) : await git(snap.directory, "rev-parse", "HEAD").catch(() => "HEAD")
      await board.bindWorkspace(taskId, attempt.token, { path: snap.directory, base, session: snap.id }).catch(() => undefined)
      this.updateRecord(snap.id, { task: { id: task.id, title: task.title, attempt: attempt.n } })
      return {
        snapshot: await this.snapshot(snap.id),
        notes: [
          `working ${task.id} "${task.title}" (attempt ${attempt.n}${tier ? `, ${tierLabel(task.tier, loadTiers(directory))}` : ""}); its report lands on the board`,
          ...result.notes,
        ],
      }
    } finally {
      checked.release()
    }
  }

  /**
   * Check a spawn before anything is created: directory, name (taken here until the record is
   * stored, so concurrent spawns cannot both get it), option conflicts, model, variant and
   * profile, attachments.
   *
   * Models and profiles are checked against the directory the caller named, also for a worktree
   * (which does not exist yet): the worktree is a checkout of the same repository, carrying its
   * uncommitted changes by default, so OpenCode reads the same project and global config there.
   */
  private async checkSpawn(input: SpawnInput): Promise<{ directory: string; model?: ModelRef; prepared: Prepared; release: () => void }> {
    const directory = this.resolveDir(input.directory)
    const stat = await fs.stat(directory).catch(() => undefined)
    if (!stat?.isDirectory()) throw new Error(`directory does not exist: ${directory}`)
    if (input.name) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(input.name)) throw new Error("name may only contain letters, digits, '.', '_' and '-' (max 64)")
      this.syncStore()
      const taken = this.reservedNames.has(input.name) || this.findByName(input.name) || this.store.agents(this.serverKey).some((r) => r.name === input.name)
      if (taken) throw new Error(`an agent named "${input.name}" already exists; pick another name or dispose it`)
    }
    const name = input.name
    if (name) this.reservedNames.add(name)
    let held = !!name
    const release = () => {
      if (held && name) this.reservedNames.delete(name)
      held = false
    }
    try {
      if (input.profile && input.agent) throw new Error("pass either agent (an existing profile) or profile (a custom one), not both")
      if (input.scope && input.agent) throw new Error("scope builds a custom profile; it cannot be combined with agent (use profile for tool switches)")
      if (input.scope && input.isolation !== "worktree")
        throw new Error('scope needs isolation "worktree" (a per-agent profile only loads in a fresh directory)')
      if (input.scope && !input.scope.paths.length) throw new Error("scope.paths needs at least one path or glob")
      const model = input.model ? parseModel(input.model, input.variant) : undefined
      if (!model && input.variant) throw new Error("variant requires model (pick one with opencode_models)")
      if (model) await this.validateModel(model, directory)
      if (input.agent) await this.validateAgent(input.agent, directory)
      // Read attachments before anything is created, so a typo fails cleanly.
      const prepared = await prepareFiles(input.files ?? [], directory)
      return { directory, model, prepared, release }
    } catch (err) {
      release()
      throw err
    }
  }

  private async startSpawn(
    input: SpawnInput,
    checked: { directory: string; model?: ModelRef; prepared: Prepared },
  ): Promise<{ snapshot: Snapshot; notes: string[] }> {
    let directory = checked.directory
    const { model, prepared } = checked
    const notes: string[] = []
    const name = input.name ?? `agent-${Date.now().toString(36)}${randomBytes(2).toString("hex")}`
    let worktree: Worktree | undefined
    let agentFile: string | undefined
    let sessionId: string | undefined
    let prompted = false
    try {
      if (input.isolation === "worktree") {
        const made = await createWorktree(directory, name, {
          rootDir: this.config.worktreeDir,
          includeUncommitted: input.worktree?.includeUncommitted ?? true,
          link: input.worktree?.link ?? [],
          setup: input.worktree?.setup,
          submodules: input.worktree?.submodules,
          signal: input.signal,
          onProgress: input.onProgress,
        })
        worktree = made.worktree
        notes.push(...made.notes)
        directory = worktree.path
      }
      if (input.signal?.aborted) throw new Error("cancelled")
      let agent = input.agent
      const profile = input.scope ? withScope(input.profile ?? {}, input.scope) : input.profile
      if (profile) {
        const made = await this.writeProfile(directory, name, profile)
        agent = made.agent
        agentFile = made.file
      }
      const session = unwrap(
        await this.api.session.create({ location: { directory }, ...(model ? { model } : {}), ...(agent ? { agent } : {}) }),
        "creating session",
      ).data
      sessionId = session.id
      await renameSession(this.backend.client, session.id, directory, `horde: ${name}`)
      const policy = input.permissions ?? this.config.defaultPermissions
      // A gate on a scoped agent audits against the scope unless told otherwise.
      let gate = input.gate
      if (input.scope && gate !== undefined && gate !== false) {
        const o = gate === true ? {} : gate
        if (!o.allowed) gate = { ...o, allowed: scopeGlobs(input.scope.paths) }
      }
      const record: AgentRecord = {
        id: session.id,
        name: input.name ?? name,
        server: this.serverKey,
        directory,
        policy,
        questions: input.questions ?? defaultQuestionPolicy(policy),
        worktree,
        limits: defined(input.limits ?? {}),
        agentFile,
        scope: input.scope,
        createdAt: Date.now(),
        owner: SELF,
        ownerSeen: Date.now(),
        reportedSeq: 0,
        gate: await gateConfig(gate, directory, !!worktree),
      }
      this.store.put(record)
      const live = this.adoptRecord(record)
      live.loaded = true // a brand-new session has no history to replay
      const preamble: string[] = []
      if (input.instructions) preamble.push(`<instructions>\n${input.instructions}\n</instructions>`)
      if (worktree) {
        preamble.push(
          `<workspace>You are working in an isolated git worktree on branch ${worktree.branch}. Commit your changes to this branch with clear messages when the task is done. Do not push, and do not switch branches.</workspace>`,
        )
      }
      const text = preamble.length ? `${preamble.join("\n\n")}\n\n${input.prompt}` : input.prompt
      await this.sendPrompt(live, text, prepared)
      prompted = true
    } catch (err) {
      // Nothing is running yet: undo everything.
      if (!prompted) {
        if (sessionId) {
          this.forget(sessionId)
          await deleteSession(this.backend.client, sessionId, directory)
        }
        if (agentFile) await fs.rm(agentFile, { force: true })
        if (worktree) await removeWorktree(worktree, name, true).catch(() => undefined)
      }
      throw err
    }
    // The agent is running now; a failing status read must not undo or duplicate it.
    const live = this.live.get(sessionId!)!
    try {
      return { snapshot: await this.snapshot(sessionId!), notes }
    } catch (err) {
      notes.push(`(status unavailable right now: ${(err as Error).message})`)
      return { snapshot: this.build(live), notes }
    }
  }

  /**
   * Custom profiles are OpenCode agent files. OpenCode reads them when it first
   * opens a directory, so this works for fresh worktrees and for directories the
   * server has not used yet.
   */
  private async writeProfile(directory: string, name: string, profile: Profile): Promise<{ agent: string; file: string }> {
    const agent = `horde-${name.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}-${Date.now().toString(36)}`
    const dir = path.join(directory, ".opencode", "agent")
    const file = path.join(dir, `${agent}.md`)
    const front = [
      "---",
      `description: ${JSON.stringify(profile.description ?? `mcp-horde profile for ${name}`)}`,
      "mode: primary",
      ...(profile.steps ? [`steps: ${profile.steps}`] : []),
      ...(profile.tools && Object.keys(profile.tools).length
        ? ["tools:", ...Object.entries(profile.tools).map(([k, v]) => `  ${JSON.stringify(k)}: ${v}`)]
        : []),
      ...(profile.permission && Object.keys(profile.permission).length
        ? [
            "permission:",
            ...Object.entries(profile.permission).flatMap(([action, rule]) =>
              typeof rule === "string"
                ? [`  ${JSON.stringify(action)}: ${rule}`]
                : [`  ${JSON.stringify(action)}:`, ...Object.entries(rule).map(([glob, v]) => `    ${JSON.stringify(glob)}: ${v}`)],
            ),
          ]
        : []),
      "---",
      "",
    ]
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(file, front.join("\n"))
    await excludeFromGit(directory, ".opencode/agent/horde-*.md").catch(() => undefined)
    for (let i = 0; i < 40; i++) {
      const agents = unwrap(await this.api.agent.list({ location: { directory } }), "listing agents").data
      if (agents.some((a) => a.id === agent)) return { agent, file }
      await sleep(250)
    }
    await fs.rm(file, { force: true })
    throw new Error(
      `OpenCode did not pick up the custom profile because it already has ${directory} open. Use isolation "worktree" for agents with a custom profile, or pass instructions instead (prepended to the prompt).`,
    )
  }

  async message(
    ref: string,
    text: string,
    opts: {
      delivery?: "steer" | "queue"
      model?: string
      variant?: string
      agent?: string
      files?: string[]
      permissions?: PermissionPolicy
      questions?: QuestionPolicy
      limits?: Limits
      gate?: GateInput
    } = {},
  ): Promise<Snapshot> {
    const live = await this.get(ref)
    const id = live.record.id
    await this.refresh(live)
    if (this.config.maxRunning > 0) await this.refreshUnknown()
    // Waking a settled agent takes a running slot.
    const waking = !!live.state && SETTLED.has(live.state) && live.state !== "needs_input"
    const release = waking ? this.reserve() : () => undefined
    let delivery = opts.delivery
    try {
      // After an interrupt OpenCode may still be winding the old loop down; a
      // steer sent now would be parked in that loop instead of starting a turn.
      // If it does not wind down in time, queue the message: it runs after that loop.
      if (waking && !(await this.untilInactive(live))) delivery = "queue"
      const session = await this.session(id)
      const directory = session.location.directory
      const prepared = await prepareFiles(opts.files ?? [], directory)
      if (opts.model || opts.variant) {
        const current = session.model ?? live.track.model
        const model = opts.model
          ? parseModel(opts.model, opts.variant)
          : current
            ? { providerID: current.providerID, id: current.id, variant: opts.variant }
            : undefined
        if (!model) throw new Error("variant requires model: the agent's model is not known yet; pass model too")
        await this.validateModel(model, directory)
        check(await this.api.session.switchModel({ sessionID: id, model }), "switching model")
      }
      if (opts.agent) {
        await this.validateAgent(opts.agent, directory)
        check(await this.api.session.switchAgent({ sessionID: id, agent: opts.agent }), "switching agent")
      }
      const patch: Partial<AgentRecord> = {}
      if (opts.permissions) {
        patch.policy = opts.permissions
        if (!opts.questions) patch.questions = defaultQuestionPolicy(opts.permissions)
      }
      if (opts.questions) patch.questions = opts.questions
      if (opts.limits) patch.limits = { ...live.record.limits, ...defined(opts.limits) }
      if (opts.gate !== undefined) patch.gate = await gateConfig(opts.gate, directory, !!live.record.worktree, live.record.gate)
      if (live.record.gate || patch.gate) patch.gateState = { round: 0 }
      // A new instruction is a new task for the gate: cancel a run in flight (only now that the
      // message is going out) and start counting rounds again.
      live.gating?.abort.abort()
      live.gating = undefined
      live.fix = undefined
      if (Object.keys(patch).length) this.updateRecord(id, patch)
      await this.sendPrompt(live, text, prepared, delivery)
    } finally {
      release()
    }
    return this.snapshot(id)
  }

  private async sendPrompt(live: Live, text: string, prepared: Prepared, delivery?: "steer" | "queue") {
    const body = prepared.inlined.length ? `${text}\n\n${prepared.inlined.join("\n\n")}` : text
    // History up to here predates the prompt; a refresh during the call may read further.
    const seq = live.track.seq
    live.sending++
    try {
      check(
        await this.api.session.prompt({
          sessionID: live.record.id,
          prompt: { text: body, ...(prepared.files.length ? { files: prepared.files } : {}) },
          delivery: delivery ?? "steer",
        }),
        "sending prompt",
      )
    } finally {
      live.sending--
    }
    // Any refresh that started before this point must not publish its (now stale) state.
    live.gen++
    live.state = "running"
    live.liveText = ""
    live.sent = { at: Date.now(), seq }
    live.stopSent = undefined
    this.updateRecord(live.record.id, { interruptedSeq: undefined, stopReason: undefined, pauseAfterStep: undefined })
  }

  async interrupt(ref: string, when: "now" | "after_step" = "now", reason?: string): Promise<Snapshot> {
    const live = await this.get(ref)
    const id = live.record.id
    // Stopping an agent stops its checks too; the gate is decided (cancelled) so it does not start again.
    if (live.gating || live.fix) {
      const turn = live.gating?.turn ?? live.fix!.turn
      live.gating?.abort.abort()
      live.gating = undefined
      live.fix = undefined
      const round = live.record.gateState?.round ?? 0
      this.updateRecord(id, {
        gateState: {
          round,
          verdict: { turn, pass: false, final: true, text: `gate cancelled: ${reason ?? "interrupted by the orchestrator"}`, at: Date.now() },
        },
      })
    }
    await this.refresh(live)
    if (live.state !== "running" && live.state !== "needs_input") return this.snapshot(id)
    if (when === "after_step" && (live.track.stepOpen || live.track.openTools.size)) {
      this.updateRecord(id, { pauseAfterStep: true, stopReason: reason ?? "paused after step" })
      return this.snapshot(id)
    }
    await this.interruptNow(live, reason ?? "interrupted by the orchestrator")
    await this.waitFor([id], "all", 5_000, { markReported: false })
    return this.snapshot(id)
  }

  private async interruptNow(live: Live, reason: string) {
    const tree = [live.record.id, ...live.children]
    await Promise.all(tree.map((sid) => this.api.session.interrupt({ sessionID: sid }, timed()).catch(() => undefined)))
    this.updateRecord(live.record.id, { interruptedSeq: live.track.seq, pauseAfterStep: undefined, stopReason: reason })
    // A prompt we sent that history does not show yet escaped this interrupt: stop its turn when it shows up.
    if (live.sent) live.stopSent = { gen: live.gen, at: Date.now() }
    live.sent = undefined
    live.fix = undefined
    // Settled by us, not by a refresh: record it as news for the next wait.
    if (!live.state || !SETTLED.has(live.state)) {
      live.liveText = ""
      live.settledAt = Date.now()
    }
    live.state = "interrupted"
    live.error = reason
  }

  async respond(ref: string, requestID: string, reply: { decision?: "once" | "always" | "reject"; message?: string; answers?: string[][] }): Promise<Snapshot> {
    const live = await this.get(ref)
    const id = live.record.id
    await this.refresh(live)
    const perm = live.pending.permissions.find((p) => p.id === requestID)
    const question = live.pending.questions.find((q) => q.id === requestID)
    if (!perm && !question) {
      const known = [...live.pending.permissions, ...live.pending.questions].map((r) => r.id)
      throw new Error(`no pending request ${requestID} on ${live.record.name ?? id}.${known.length ? ` Pending: ${known.join(", ")}` : " Nothing is pending."}`)
    }
    // The caller's answer wins over a dialog that is still open (removed first,
    // so its abort is not mistaken for a dismissal).
    const dialog = live.dialogs.get(requestID)
    live.dialogs.delete(requestID)
    dialog?.abort()
    live.handled.add(requestID)
    try {
      if (perm) await this.replyPermission(perm, reply.decision ?? "once", reply.message)
      else if (question) {
        if (reply.decision === "reject") await this.rejectQuestion(question)
        else if (reply.answers) await this.answerQuestion(question, reply.answers)
        else await this.dismissQuestion(question)
      }
    } catch (err) {
      live.handled.delete(requestID)
      throw err
    }
    return this.snapshot(id)
  }

  private async replyPermission(p: PermissionV2Request, reply: "once" | "always" | "reject", message?: string) {
    check(
      await this.api.session.permission.reply({ sessionID: p.sessionID, requestID: p.id, reply, ...(message ? { message } : {}) }),
      "replying to permission",
    )
  }

  private async answerQuestion(q: QuestionV2Request, answers: string[][]) {
    check(await this.api.session.question.reply({ sessionID: q.sessionID, requestID: q.id, questionV2Reply: { answers } }), "answering question")
  }

  /** Rejecting a question halts the agent in OpenCode, so "dismiss" answers it instead. */
  private async dismissQuestion(q: QuestionV2Request) {
    await this.answerQuestion(
      q,
      q.questions.map(() => ["No preference: use your best judgment and continue."]),
    )
  }

  private async rejectQuestion(q: QuestionV2Request) {
    check(await this.api.session.question.reject({ sessionID: q.sessionID, requestID: q.id }), "rejecting question")
  }

  async dispose(ref: string, opts: { worktree?: "keep" | "remove" | "discard"; deleteSession?: boolean }): Promise<string> {
    const live = await this.get(ref)
    const notes: string[] = []
    // No gate from here on: the agent is going away.
    live.holdGate++
    live.gating?.abort.abort()
    live.gating = undefined
    live.fix = undefined
    try {
      return await this.disposeHeld(live, opts, notes)
    } catch (err) {
      // Still tracked (e.g. leftovers could not be committed safely): gates may run again.
      live.holdGate--
      throw err
    }
  }

  private async disposeHeld(live: Live, opts: { worktree?: "keep" | "remove" | "discard"; deleteSession?: boolean }, notes: string[]): Promise<string> {
    const id = live.record.id
    const name = live.record.name ?? id
    await this.refresh(live).catch(() => undefined)
    if (live.state === "running" || live.state === "needs_input") {
      await this.interruptNow(live, "disposed")
      notes.push("interrupted the running turn")
    }
    await this.recordTaskActivity(live)
    // Commit a worktree's leftovers before anything is deleted (throws if that is not safe).
    if (live.record.worktree && opts.worktree === "remove") {
      const committed = await commitAll(live.record.worktree, `horde: uncommitted work from ${name}`)
      if (committed) notes.push(committed)
    }
    if (opts.deleteSession) {
      // First, while its directory still exists: OpenCode opens the session's
      // directory to serve the request. Deleting removes the session and its children.
      const res = await deleteSession(this.backend.client, id, live.session?.location.directory ?? live.record.directory)
      notes.push(res.ok ? `deleted session ${id}` : `could not delete session ${id}${res.status ? ` (HTTP ${res.status})` : ""}; it stays in OpenCode history`)
    }
    const wt = live.record.worktree
    if (wt) {
      const mode = opts.worktree ?? "keep"
      if (mode === "keep") {
        const committed = await commitAll(wt, `horde: uncommitted work from ${name}`).catch((e: Error) => `could not commit leftovers: ${e.message}`)
        if (committed) notes.push(committed)
        notes.push(`kept worktree ${wt.root} (branch ${wt.branch})`)
      } else {
        // Stop tracking first: our own refreshes would make OpenCode reopen the directory.
        this.forget(id)
        // Let OpenCode release the directory (again before each retry) before it disappears.
        const release = () => releaseDirectory(this.backend.client, wt.path)
        notes.push(await removeWorktree(wt, name, mode === "discard", release))
      }
    }
    if (live.record.agentFile) await fs.rm(live.record.agentFile, { force: true })
    if (!opts.deleteSession) notes.push(`the session ${id} stays in OpenCode history`)
    this.forget(id)
    notes.push(`stopped tracking ${name}`)
    return notes.join("\n")
  }

  async worktree(
    ref: string,
    action: "diff" | "commit" | "merge" | "sync",
    opts: { strategy?: "merge" | "squash"; maxChars?: number; check?: boolean; signal?: AbortSignal },
  ): Promise<string> {
    const live = await this.get(ref)
    const wt = live.record.worktree
    const name = live.record.name ?? live.record.id
    if (!wt) throw new Error(`${name} does not run in a worktree (spawn with isolation "worktree")`)
    if (action === "diff") return worktreeDiff(wt, opts.maxChars ?? 20_000)
    await this.refresh(live)
    // Only a diff while it works: its tree is changing, and a request it waits on may be answered any moment.
    if (this.working(live))
      throw new Error(
        `${name} is ${live.state === "needs_input" ? "waiting for an answer (opencode_respond)" : "still running"}; wait for it or interrupt it first (only diff works meanwhile)`,
      )
    if (action === "commit") return (await this.withoutGate(live, () => commitAll(wt, `horde: work from ${name}`))) ?? "nothing to commit"
    if (action === "sync") {
      const synced = await this.withoutGate(live, async () => {
        const out = await syncWorktree(wt, name)
        // The gate's base moved with the branch: the finished turn was judged on the old tree, and
        // is not judged again (that is the next turn's job, once the agent was told to re-check).
        if (out.worktree) this.updateRecord(live.record.id, { worktree: out.worktree, gateState: this.supersededGate(live) })
        return out
      })
      if (synced.worktree) {
        const task = live.record.task
        if (task) {
          const board = await Board.open(wt.repo).catch(() => undefined)
          const t = board?.task(task.id)
          const a = t?.attempts.find((x) => x.n === task.attempt)
          if (board && a?.workspace && !a.endedAt)
            await board.bindWorkspace(task.id, a.token, { ...a.workspace, base: workStart(synced.worktree) }).catch(() => undefined)
        }
      }
      const next = live.record.gate ? " The gate does not re-run by itself; it judges the turn that message starts." : ""
      return `${synced.text}${synced.worktree ? `\nMessage the agent to re-run its checks on the updated code.${next}` : ""}`
    }
    const result = await this.withoutGate(live, () => mergeWorktree(wt, name, opts.strategy ?? "merge"))
    if (!result.merged || result.merged === wt.merged) return result.text
    this.updateRecord(live.record.id, { worktree: { ...wt, merged: result.merged } })
    if (opts.check === false) return result.text
    // The worker's gate judged its branch alone; this judges your checkout with everything merged so far.
    try {
      const v = await runGate(wt.repo, { audit: false, signal: opts.signal, stateDir: verifyStateDir() })
      if (!v.checks.length) return result.text
      return `${result.text}\nyour checkout after the merge: ${v.text}${v.pass ? "" : "\nThe merge stays; fix it here, or message the agent (sync first) to fix it."}`
    } catch (err) {
      return `${result.text}\nthe checks after the merge could not run: ${(err as Error).message}`
    }
  }

  /**
   * Run an operation on the agent's tree or session with no gate overlapping it: a gate in
   * flight is cancelled (it runs again afterwards for a turn that still has no verdict) and none
   * starts until the operation is done.
   */
  private async withoutGate<T>(live: Live, fn: () => Promise<T>): Promise<T> {
    live.holdGate++
    live.gating?.abort.abort()
    live.gating = undefined
    try {
      return await fn()
    } finally {
      live.holdGate--
      if (this.live.get(live.record.id) === live) void this.refresh(live).catch(() => undefined)
    }
  }

  /** Gate state after the tree changed under a judged turn: that turn counts as judged; the next one is gated. */
  private supersededGate(live: Live): AgentRecord["gateState"] {
    const turn = currentTurn(live.track)
    return turn ? { round: 0, superseded: turn.startSeq } : undefined
  }

  // --------------------------------------------------------------- reading

  async session(id: string): Promise<SessionV2Info> {
    return unwrap(await this.api.session.get({ sessionID: id }), `loading session ${id}`).data
  }

  /** Wait for the agent's loop to wind down. False when it is still active at the deadline. */
  private async untilInactive(live: Live, timeoutMs = 10_000): Promise<boolean> {
    const tree = [live.record.id, ...live.hotChildren.keys()]
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const active = await this.activeSet().catch(() => undefined)
      if (!active || !tree.some((sid) => active.has(sid))) return true
      await sleep(100)
    }
    return false
  }

  private async activeSet(): Promise<Set<string>> {
    const res = unwrap(await this.api.session.active(timed()), "listing active sessions")
    return new Set(Object.keys(res.data))
  }

  /**
   * Refresh one agent. Concurrent requests are coalesced: at most one refresh
   * runs and one more is queued, and every caller sees a refresh that started
   * after its call.
   */
  private refresh(live: Live, active?: Set<string>): Promise<void> {
    if (live.queued) return live.queued
    if (live.running) {
      live.queued = live.running
        .catch(() => undefined)
        .then(() => {
          live.queued = undefined
          return this.runRefresh(live)
        })
      return live.queued
    }
    return this.runRefresh(live, active)
  }

  private runRefresh(live: Live, active?: Set<string>): Promise<void> {
    const run = this.doRefresh(live, active).finally(() => {
      if (live.running === run) live.running = undefined
    })
    live.running = run
    return run
  }

  private async doRefresh(live: Live, activeIn?: Set<string>) {
    const id = live.record.id
    const gen = live.gen
    const before = live.state
    const sessionRes = await this.api.session.get({ sessionID: id }, timed())
    if (sessionRes.response?.status === 404) {
      this.forget(id)
      const wt = live.record.worktree
      throw new Error(
        `session ${id} no longer exists on the OpenCode server (deleted?); stopped tracking it${wt ? `. Its worktree is left as it was: ${wt.path} (branch ${wt.branch} in ${wt.repo}); merge or remove it with git` : ""}`,
      )
    }
    live.session = unwrap(sessionRes, `loading session ${id}`).data

    // Durable history since the last seq we applied.
    const replaying = !live.loaded
    const turnsBefore = live.track.turns.length ? currentTurn(live.track)!.startSeq : -1
    const seqBefore = live.track.seq
    await this.readHistory(id, live.track, live.session.location.directory)
    // Grace windows run on local receive times, so a skewed server clock cannot shorten or stretch them.
    const seenAt = Date.now()
    if (live.track.seq !== seqBefore || replaying) live.lastNewEventAt = seenAt
    for (const mid of live.track.admitted.keys()) if (!live.admittedSeen.has(mid)) live.admittedSeen.set(mid, seenAt)
    for (const mid of live.admittedSeen.keys()) if (!live.track.admitted.has(mid)) live.admittedSeen.delete(mid)
    const sent = live.sent
    if (sent && (live.track.lastPromptedSeq > sent.seq || [...live.track.admitted.values()].some((a) => a.seq > sent.seq))) live.sent = undefined
    const turn = currentTurn(live.track)
    if (!replaying && turn && turn.startSeq !== turnsBefore) live.turnSeen.set(turn.startSeq, Date.now())
    live.loaded = true
    if (live.record.adoptPending) this.finishAdoption(live)
    if (live.record.directory !== live.session.location.directory) this.updateRecord(id, { directory: live.session.location.directory })

    const active = activeIn ?? (await this.activeSet())
    const now = Date.now()
    for (const c of live.children) if (active.has(c)) live.hotChildren.set(c, now)
    if (now - live.lastChildScan > CHILD_SCAN_MS && this.working(live)) await this.scanChildren(live).catch(() => undefined)
    for (const [c, at] of live.hotChildren) if (now - at > CHILD_COOL_MS && !active.has(c)) live.hotChildren.delete(c)
    // Child histories (for cost limits) and requests, only for children with recent activity.
    const hot = [...live.hotChildren.keys()]
    for (const c of hot) {
      let t = live.childTracks.get(c)
      if (!t) {
        t = emptyTrack()
        live.childTracks.set(c, t)
      }
      await this.readHistory(c, t, live.session.location.directory).catch(() => undefined)
    }
    const tree = [id, ...hot]
    const [perms, questions] = await Promise.all([
      Promise.all(tree.map(async (sid) => unwrap(await this.api.session.permission.list({ sessionID: sid }, timed()), "listing permissions").data)),
      Promise.all(tree.map(async (sid) => unwrap(await this.api.session.question.list({ sessionID: sid }, timed()), "listing questions").data)),
    ])
    if (this.closed) return
    live.pending = { permissions: perms.flat(), questions: questions.flat() }
    this.pruneRequestSets(live)
    await this.approveTrusted(live)

    // A prompt that escaped an interrupt (sent, not yet in history) has shown up: its turn is stopped too.
    const stop = live.stopSent
    const marker0 = live.record.interruptedSeq
    if (stop && (stop.gen !== live.gen || marker0 === undefined || Date.now() - stop.at > START_GRACE_MS)) live.stopSent = undefined
    else if (stop && marker0 !== undefined) {
      const cur0 = currentTurn(live.track)
      const escaped = Math.max(
        ...[...live.track.admitted.values()].map((a) => a.seq).filter((q) => q > marker0),
        cur0 && cur0.startSeq > marker0 ? cur0.admittedSeq : 0,
      )
      if (escaped > marker0) {
        live.stopSent = undefined
        this.updateRecord(id, { interruptedSeq: escaped })
      }
    }

    if (live.record.pauseAfterStep && !live.track.inLoop) this.updateRecord(id, { pauseAfterStep: undefined })
    else if (live.record.pauseAfterStep && !live.track.stepOpen && !live.track.openTools.size && live.gen === gen) {
      // Between steps (seen by polling, without the event stream): this is the pause point.
      await this.interruptNow(live, live.record.stopReason ?? "paused after step")
    }
    // Interrupting before the loop picked up the prompt is a no-op in OpenCode, so
    // the turn may start afterwards: stop it again once it does.
    const marker = live.record.interruptedSeq
    const cur = currentTurn(live.track)
    if (marker !== undefined && cur && live.track.inLoop && cur.startSeq > marker && cur.admittedSeq <= marker && live.gen === gen) {
      await Promise.all([id, ...live.hotChildren.keys()].map((sid) => this.api.session.interrupt({ sessionID: sid }, timed()).catch(() => undefined)))
    }
    live.lastRefresh = Date.now()
    // A prompt was sent while we were reading: our view predates it.
    if (live.gen !== gen || this.closed) return

    const { state, error } = this.derive(live, active)
    live.state = state
    live.error = error
    await this.applyPolicies(live)
    if (live.state === "running" && live.gen === gen) await this.enforceLimits(live)

    if (SETTLED.has(live.state) && before !== undefined && !SETTLED.has(before)) {
      live.liveText = ""
      live.settledAt = Date.now()
    }
    this.maybeGate(live)
    this.maybePush(live)
  }

  private async readHistory(sessionID: string, track: Track, directory: string) {
    // Pricing comes from the catalog; load it once per directory.
    if (!this.modelCache.has(directory)) await this.models(directory).catch(() => undefined)
    const estimate = this.estimator(directory)
    for (let page = 0; page < 1000; page++) {
      const res = unwrap(await this.api.session.history({ sessionID, after: track.seq, limit: 100 }, timed()), "reading session history")
      for (const e of res.data as DurableEvent[]) apply(track, e, estimate)
      if (res.data.length < 100) break
    }
  }

  /** What the caller sees of the gate. Undefined when the agent has none, or none applies to its state. */
  private gateView(live: Live): GateView | undefined {
    const cfg = live.record.gate
    if (!cfg) return undefined
    const gs = live.record.gateState ?? { round: 0 }
    const v = gs.verdict
    const turn = currentTurn(live.track)
    const view = { round: gs.round, maxRounds: cfg.maxRounds, text: v?.text }
    if (live.gating) return { ...view, state: "running", round: gs.round + 1 }
    // A fix waiting for a running slot is still a fix round.
    if (live.fix && v && !v.final) return { ...view, state: "retrying", queued: true }
    // The tree changed under this turn (sync, revert): it is not judged again.
    if (turn && gs.superseded === turn.startSeq) return undefined
    if (v && turn && v.turn === turn.startSeq && v.final) return { ...view, state: v.pass ? "pass" : "fail" }
    if (this.gateTurn(live)) return { ...view, state: "pending" }
    if (v && !v.final) {
      // Retrying only while the agent works on the fix; a fix round that stopped (interrupted,
      // failed, or a turn with nothing to judge) leaves the last failing verdict as the result.
      if (this.working(live)) return { ...view, state: "retrying" }
      return { ...view, state: "fail", text: `${v.text}\n(the fix round stopped: the agent is ${live.state}${live.error ? `: ${live.error}` : ""})` }
    }
    return undefined
  }

  /** The turn a gate would judge now: the current one, if it finished cleanly. */
  private gateTurn(live: Live): Turn | undefined {
    const turn = currentTurn(live.track)
    if (!live.record.gate || live.state !== "idle" || !turn?.endedAt || turn.interrupted || turn.failure) return undefined
    return turn
  }

  /** Start the gate for a finished turn that has no verdict yet. Runs in the background. */
  private maybeGate(live: Live) {
    const turn = this.gateTurn(live)
    // Never while a prompt is on its way: the finished turn is about to be superseded.
    if (!turn || live.gating || live.sent || live.sending || live.holdGate || live.fix || this.closed) return
    const gs = live.record.gateState ?? { round: 0 }
    if (gs.superseded === turn.startSeq) return
    if (gs.verdict?.turn === turn.startSeq) {
      // A failure whose fix never went out (it was queued when this process stopped): send it now.
      if (!gs.verdict.final) {
        live.fix = { turn: turn.startSeq, round: gs.round, text: gs.verdict.text }
        void this.deliverFix(live)
      }
      return
    }
    const abort = new AbortController()
    live.gating = { turn: turn.startSeq, abort }
    void this.runGateFor(live, turn.startSeq, abort).finally(() => {
      if (live.gating?.abort === abort) live.gating = undefined
      this.wake()
      if (!this.closed && this.live.get(live.record.id) === live) void this.refresh(live).catch(() => undefined)
    })
  }

  private async runGateFor(live: Live, turn: number, abort: AbortController) {
    const id = live.record.id
    const cfg = live.record.gate!
    const round = (live.record.gateState?.round ?? 0) + 1
    const wt = live.record.worktree
    let pass = false
    let text: string
    try {
      const v = await runGate(live.session?.location.directory ?? live.record.directory, {
        base: wt ? workStart(wt) : cfg.base,
        audit: cfg.audit,
        checks: cfg.checks,
        allowed: cfg.allowed,
        related: cfg.related !== false,
        signal: abort.signal,
        stateDir: verifyStateDir(),
      })
      pass = v.pass
      text = v.text
    } catch (err) {
      text = `the gate could not run: ${(err as Error).message}`
    }
    // A new instruction (or dispose, or shutdown) superseded this run: its verdict is about an old task.
    if (this.closed || abort.signal.aborted || this.live.get(id) !== live) return
    if (live.sent || live.sending || live.track.lastPromptedSeq > turn || currentTurn(live.track)?.startSeq !== turn) return
    const final = pass || round >= cfg.maxRounds || text.startsWith("the gate could not run")
    this.updateRecord(id, { gateState: { round, verdict: { turn, pass, final, text, at: Date.now() } } })
    if (!final) {
      // The fix round wakes the agent: it waits for a running slot like any other wake-up.
      live.fix = { turn, round, text }
      await this.deliverFix(live)
    }
  }

  /** Send a queued gate failure back to its agent once a running slot is free (else it stays queued for the next tick). */
  private async deliverFix(live: Live) {
    const fix = live.fix
    if (!fix) return
    const id = live.record.id
    const v = live.record.gateState?.verdict
    // Superseded meanwhile (a new message, an interrupt, a dispose): drop it.
    if (
      this.closed ||
      this.live.get(id) !== live ||
      live.sent ||
      live.sending ||
      v?.turn !== fix.turn ||
      v.final ||
      currentTurn(live.track)?.startSeq !== fix.turn
    ) {
      live.fix = undefined
      return
    }
    let release: () => void
    try {
      release = this.reserve()
    } catch {
      return
    }
    live.fix = undefined
    try {
      await this.sendPrompt(live, gateFeedback(fix.round, live.record.gate?.maxRounds ?? fix.round, fix.text), { files: [], inlined: [] })
    } catch (err) {
      // The agent could not be told: report the failure instead of waiting forever.
      this.updateRecord(id, {
        gateState: {
          round: fix.round,
          verdict: {
            turn: fix.turn,
            pass: false,
            final: true,
            text: `${fix.text}\n(could not send the failure back to the agent: ${(err as Error).message})`,
            at: Date.now(),
          },
        },
      })
    } finally {
      release()
      this.wake()
    }
  }

  /** Push once per distinct settled outcome (and per new request). */
  private maybePush(live: Live) {
    void this.recordTaskActivity(live)
    // An idle agent whose gate has not decided is not finished yet.
    const gate = this.gateView(live)
    const holding = live.state === "idle" && !!gate && gate.state !== "pass" && gate.state !== "fail"
    if (!live.state || !SETTLED.has(live.state) || holding) {
      if (!holding) live.lastPushKey = undefined
      return
    }
    const ids = [...live.pending.permissions, ...live.pending.questions]
      .filter((r) => !live.handled.has(r.id))
      .map((r) => r.id)
      .sort()
    const key = `${live.state}:${currentTurn(live.track)?.startSeq ?? 0}:${ids.join(",")}:${gate?.state ?? ""}`
    if (key === live.lastPushKey) return
    const first = live.lastPushKey === undefined && live.settledAt === 0
    live.lastPushKey = key
    // Agents found already settled at startup are not news.
    if (!first) this.hooks.settled(this.build(live))
  }

  /**
   * Put a task-bound agent's spend so far, state and gate on its board attempt (tracking
   * only, no limits), once per change. Resolves when the board has the latest.
   */
  private recordTaskActivity(live: Live): Promise<void> {
    const task = live.record.task
    if (!task || !live.state) return Promise.resolve()
    const s = this.build(live)
    const gate = s.gate && `${s.gate.state} ${Math.max(1, s.gate.round)}/${s.gate.maxRounds}`
    // The model that worked the attempt: what the ledger learns tiers from.
    const model = s.model ? `${s.model.providerID}/${s.model.id}` : undefined
    const variant = s.model?.variant && s.model.variant !== "default" ? s.model.variant : undefined
    const key = JSON.stringify([s.cost.toFixed(6), s.state, gate, model, variant])
    if (live.activity?.key === key) return live.activity.write
    const write = (async () => {
      const board = await Board.open(live.record.worktree?.repo ?? live.record.directory).catch(() => undefined)
      await board?.recordActivity(task.id, task.attempt, { cost: s.cost || undefined, state: s.state, gate, model, variant }).catch(() => undefined)
    })()
    live.activity = { key, write }
    return write
  }

  private derive(live: Live, active: Set<string>): { state: AgentState; error?: string } {
    const { record, track: t } = live
    const unhandled = [...live.pending.permissions, ...live.pending.questions].filter((r) => !live.handled.has(r.id))
    if (unhandled.length) return { state: "needs_input" }
    // We interrupted it, and nothing new was prompted since (a turn that started
    // from input admitted before the interrupt is being interrupted again).
    if (record.interruptedSeq !== undefined && (t.lastPromptedSeq <= record.interruptedSeq || (currentTurn(t)?.admittedSeq ?? 0) <= record.interruptedSeq)) {
      return { state: "interrupted", error: record.stopReason }
    }
    const tree = [record.id, ...live.hotChildren.keys()]
    if (tree.some((sid) => active.has(sid))) return { state: "running" }
    const now = Date.now()
    if (live.sent) {
      if (now - live.sent.at < START_GRACE_MS) return { state: "running" }
      return { state: "error", error: "the prompt was sent but OpenCode never recorded it; check the OpenCode server log" }
    }
    if (t.admitted.size) {
      const newest = Math.max(...[...t.admitted.keys()].map((mid) => live.admittedSeen.get(mid) ?? now))
      if (now - newest < (t.totalSteps ? START_GRACE_MS : FIRST_START_GRACE_MS)) return { state: "running" }
      return { state: "error", error: "the prompt was accepted but the agent never started on it; check the OpenCode server log" }
    }
    const turn = currentTurn(t)
    // e.g. a rejected question: OpenCode interrupts the tool and halts the loop.
    if (turn?.interrupted) return { state: "interrupted", error: turn.failure }
    if (t.inLoop) {
      if (now - live.lastNewEventAt < GRACE_MS) return { state: "running" }
      return {
        state: "error",
        error:
          "the turn stopped without finishing; OpenCode could not run it (unsupported model API, provider failure or crash). Check the OpenCode server log, then retry with opencode_message.",
      }
    }
    if (turn?.failure) return { state: "error", error: turn.failure }
    return { state: "idle" }
  }

  /**
   * Board commands from a brief (`horde … report t-x <token> …`) are horde
   * plumbing: approve exactly those, for this agent's own repository's board
   * only, whatever the agent's policy, so reporting never waits on a human.
   * Anything else, including a board command with a chained shell command, goes
   * through the normal policy. Never for adopted sessions: nothing is answered
   * on a human's behalf.
   */
  private async approveTrusted(live: Live) {
    if (live.record.adopted) return
    const asks = live.pending.permissions.filter((p) => !live.handled.has(p.id) && p.action === "bash" && p.resources.length)
    if (!asks.length) return
    live.boardDir ??= await Board.open(live.record.worktree?.repo ?? live.record.directory)
      .then((b) => b.dir)
      .catch(() => undefined)
    const state = live.boardDir
    if (!state) return
    for (const p of asks) {
      if (!p.resources.every((r) => isTrustedCommand(r, { state }))) continue
      live.handled.add(p.id)
      await this.replyPermission(p, "once").catch(() => live.handled.delete(p.id))
    }
  }

  private async applyPolicies(live: Live) {
    const { record } = live
    const timeout = this.config.elicitTimeoutMs
    const ask = <T>(id: string, show: (signal: AbortSignal) => Promise<T>, onAnswer: (answer: T) => Promise<void>) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      live.handled.add(id)
      live.dialogs.set(id, controller)
      void show(controller.signal)
        .then(async (answer) => {
          if (controller.signal.aborted && live.handled.has(id)) return // the caller answered meanwhile
          await onAnswer(answer)
        })
        .catch(() => {
          // Timed out, failed, or the client cannot show it: the calling model decides.
          if (live.dialogs.get(id) === controller) this.handToCaller(live, id)
        })
        .finally(() => {
          clearTimeout(timer)
          if (live.dialogs.get(id) === controller) live.dialogs.delete(id)
          this.wake()
        })
    }
    for (const p of live.pending.permissions) {
      if (live.handled.has(p.id) || live.handedToCaller.has(p.id)) continue
      // An edit outside a scope with outside "ask" is the orchestrator's call, whatever the policy.
      if (record.scope?.outside === "ask" && p.action === "edit") {
        this.handToCaller(live, p.id)
        continue
      }
      if (record.policy === "allow" || record.policy === "deny") {
        live.handled.add(p.id)
        await this.replyPermission(
          p,
          record.policy === "allow" ? "once" : "reject",
          record.policy === "deny" ? "Denied by the orchestrator's permission policy. Find another way, or explain what you need and stop." : undefined,
        ).catch(() => live.handled.delete(p.id))
      } else if (record.policy === "user" && this.hooks.canElicit()) {
        ask(
          p.id,
          (signal) => this.hooks.askPermission(this.build(live), p, signal),
          async (answer) => {
            if (answer) await this.replyPermission(p, answer.reply, answer.message)
            else this.handToCaller(live, p.id)
          },
        )
      }
    }
    for (const q of live.pending.questions) {
      if (live.handled.has(q.id) || live.handedToCaller.has(q.id)) continue
      if (record.questions === "dismiss") {
        live.handled.add(q.id)
        await this.dismissQuestion(q).catch(() => live.handled.delete(q.id))
      } else if (record.questions === "user" && this.hooks.canElicit()) {
        ask(
          q.id,
          (signal) => this.hooks.askQuestion(this.build(live), q, signal),
          async (answer) => {
            if (answer === "dismiss") await this.dismissQuestion(q)
            else if (answer) await this.answerQuestion(q, answer)
            else this.handToCaller(live, q.id)
          },
        )
      }
    }
    // Requests handled automatically or shown to the human do not block on the caller.
    const pending = [...live.pending.permissions, ...live.pending.questions]
    if (live.state === "needs_input" && pending.every((r) => live.handled.has(r.id))) live.state = "running"
  }

  /** The human dismissed the dialog (or it failed): let the calling model decide. */
  private handToCaller(live: Live, requestId: string) {
    live.handled.delete(requestId)
    live.handedToCaller.add(requestId)
  }

  /** Forget request ids that are no longer pending (except open dialogs). */
  private pruneRequestSets(live: Live) {
    const pending = new Set([...live.pending.permissions, ...live.pending.questions].map((r) => r.id))
    for (const set of [live.handled, live.reportedRequests, live.handedToCaller]) {
      for (const id of set) if (!pending.has(id) && !live.dialogs.has(id)) set.delete(id)
    }
  }

  private async enforceLimits(live: Live) {
    const { record, track } = live
    const turn = currentTurn(track)
    // Only the turn that is running now: an ended turn's totals must not stop a new prompt.
    if (!turn || turn.endedAt !== undefined || !track.inLoop) return
    // Already stopping it, or a prompt we sent is not in history yet (the open turn is the old one).
    if (record.interruptedSeq !== undefined || live.sent || live.limitedTurn === turn.startSeq) return
    const { maxSteps, maxCostUsd, timeoutMinutes } = record.limits
    const started = live.turnSeen.get(turn.startSeq) ?? turn.startedAt
    let childCost = 0
    for (const t of live.childTracks.values()) childCost += costSince(t, turn.startedAt)
    const cost = turn.cost + childCost
    let reason: string | undefined
    if (maxSteps && (turn.steps > maxSteps || (turn.steps >= maxSteps && !track.stepOpen))) reason = `step limit reached (${maxSteps} steps this turn)`
    else if (maxCostUsd && cost >= maxCostUsd) reason = `cost limit reached ($${cost.toFixed(4)} ≥ $${maxCostUsd} this turn)`
    else if (timeoutMinutes && Date.now() - started > timeoutMinutes * 60_000) reason = `time limit reached (${timeoutMinutes} min this turn)`
    if (reason) {
      live.limitedTurn = turn.startSeq
      await this.interruptNow(live, reason)
    }
  }

  private async scanChildren(live: Live) {
    live.lastChildScan = Date.now()
    const directory = live.session?.location.directory ?? live.record.directory
    const res = unwrap(await this.api.session.list({ directory, limit: 100, order: "desc" }, timed()), "listing sessions")
    const tree = new Set([live.record.id, ...live.children])
    // Parents are listed after children in desc order; loop until no new descendants appear.
    let grew = true
    while (grew) {
      grew = false
      for (const s of res.data) {
        if (s.parentID && tree.has(s.parentID) && !tree.has(s.id)) {
          tree.add(s.id)
          this.addChild(live, s.id)
          grew = true
        }
      }
    }
  }

  private addChild(live: Live, child: string) {
    live.children.add(child)
    live.hotChildren.set(child, Date.now())
    this.childToRoot.set(child, live.record.id)
  }

  private build(live: Live): Snapshot {
    const { record, track } = live
    const session = live.session
    const state = live.state ?? "running"
    const turn = currentTurn(track)
    let activity: string | undefined
    if (state === "running") {
      const asking = [...live.pending.permissions, ...live.pending.questions].filter((r) => live.dialogs.has(r.id))
      const tool = latestTool(track)
      if (asking.length) {
        activity = `waiting for the user to answer: ${asking
          .map((r) => ("action" in r ? `${r.action} ${JSON.stringify(r.resources)}` : (r.questions[0]?.question ?? "a question")))
          .join("; ")}`
      } else if (record.pauseAfterStep) activity = "pausing after the current step"
      else if (tool) activity = `${tool.tool}: ${inputSummary(tool.input)}${track.openTools.size > 1 ? ` (+${track.openTools.size - 1} more)` : ""}`
      else if (live.liveText) activity = `writing: …${oneLine(live.liveText).slice(-160)}`
      else if (track.stepOpen) activity = "thinking"
      else activity = "starting"
    }
    let cost = track.cost
    let steps = track.totalSteps
    const tokens = { ...track.tokens }
    for (const t of live.childTracks.values()) {
      cost += t.cost
      steps += t.totalSteps
      for (const k of Object.keys(tokens) as (keyof typeof tokens)[]) tokens[k] += t.tokens[k]
    }
    return {
      id: record.id,
      name: record.name,
      title: session?.title ?? "",
      state,
      directory: session?.location.directory ?? record.directory,
      agent: session?.agent ?? track.agent,
      model: session?.model ?? track.model,
      worktree: record.worktree,
      policy: record.policy,
      questionPolicy: record.questions,
      limits: record.limits,
      activity,
      error: state === "error" || state === "interrupted" ? live.error : undefined,
      retry: live.retry && state === "running" ? `retrying (attempt ${live.retry.attempt}): ${live.retry.message}` : undefined,
      pending: {
        permissions: live.pending.permissions.filter((p) => !live.handled.has(p.id)),
        questions: live.pending.questions.filter((q) => !live.handled.has(q.id)),
      },
      unreported: record.adoptPending ? [] : turnsSince(track, record.reportedSeq).filter((x) => x.endedAt !== undefined),
      lastTurn: turn,
      steps,
      cost,
      tokens,
      context: this.contextOf(live),
      children: [...live.children],
      gate: this.gateView(live),
      task: record.task,
    }
  }

  private contextOf(live: Live): Snapshot["context"] {
    const { track } = live
    if (track.context === undefined) return track.compactions ? { used: 0, compactions: track.compactions } : undefined
    const model = live.session?.model ?? track.model
    const dir = live.session?.location.directory ?? live.record.directory
    const info = model && this.modelCache.get(dir)?.models.find((m) => m.providerID === model.providerID && m.id === model.id)
    return { used: track.context, limit: info?.limit.context || undefined, compactions: track.compactions }
  }

  /**
   * Compact an idle agent's conversation: OpenCode summarizes it and continues from the
   * summary, so a long task can go on in a small context window. The files are untouched.
   */
  async compact(ref: string): Promise<Snapshot> {
    const live = await this.get(ref)
    await this.refresh(live)
    if (live.state === "running" || live.state === "needs_input")
      throw new Error(`${live.record.name ?? live.record.id} is ${live.state}; compact it once it is idle (opencode_wait, or opencode_interrupt first)`)
    return this.withoutGate(live, async () => {
      const before = live.track.compactions
      const res = await this.api.session.compact({ sessionID: live.record.id })
      if (res.error !== undefined || !res.response?.ok) {
        const e = res.error as { message?: string } | undefined
        const message = e?.message ?? (e ? JSON.stringify(e) : `HTTP ${res.response?.status}`)
        // OpenCode 1.19 answers 503 "Session compact is not available yet" (the legacy summarize does not touch v2 sessions).
        if (/not available/i.test(message))
          throw new Error(
            `this OpenCode server cannot compact v2 sessions yet (${message}). To continue with a fresh context, dispose the agent keeping its worktree and spawn a new one there with a summary of the task so far.`,
          )
        throw new Error(`compacting the session failed: ${message}`)
      }
      // The summary is written by the model; wait for it to land.
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        await this.refresh(live)
        if (live.track.compactions > before && !live.track.inLoop) break
        await sleep(250)
      }
      if (live.track.compactions <= before) throw new Error("OpenCode accepted the compaction but did not finish it within 2 minutes")
      return this.build(live)
    })
  }

  /**
   * Undo an idle agent's last turns: OpenCode restores the files those turns changed and
   * removes their messages, so the agent's context matches its files again. `to` reverts
   * to just after a given message instead.
   */
  async revert(
    ref: string,
    opts: { turns?: number; to?: string } = {},
  ): Promise<{ snapshot: Snapshot; files: { path: string; status: string }[]; turns: number }> {
    const live = await this.get(ref)
    await this.refresh(live)
    const name = live.record.name ?? live.record.id
    if (live.state === "running" || live.state === "needs_input")
      throw new Error(`${name} is ${live.state}; revert it once it is idle (opencode_wait, or opencode_interrupt first)`)
    return this.withoutGate(live, () => this.revertIdle(live, name, opts))
  }

  private async revertIdle(
    live: Live,
    name: string,
    opts: { turns?: number; to?: string },
  ): Promise<{ snapshot: Snapshot; files: { path: string; status: string }[]; turns: number }> {
    const sessionID = live.record.id
    // The conversation in order, oldest first.
    const conversation = async () => {
      const out: { id: string; type?: string; snapshot?: { start?: string; end?: string } }[] = []
      let cursor: string | undefined
      for (let page = 0; page < 50; page++) {
        const res = unwrap(
          await this.api.session.messages(cursor ? { sessionID, limit: 200, cursor } : { sessionID, order: "asc", limit: 200 }),
          "reading the conversation",
        ) as { data: typeof out; cursor?: { next?: string } }
        out.push(...res.data)
        cursor = res.cursor?.next
        if (!cursor || !res.data.length) break
      }
      return out
    }
    let messages = await conversation()
    const ids = messages.map((m) => m.id)
    let boundary = opts.to
    let undone = 0
    if (boundary) {
      if (!ids.includes(boundary)) throw new Error(`no message ${boundary} in ${name}'s conversation`)
      undone = live.track.turns.filter((t) => (t.messageIDs?.[0] ? ids.indexOf(t.messageIDs[0]) > ids.indexOf(boundary!) : false)).length
    } else {
      const n = opts.turns ?? 1
      const turns = live.track.turns
      if (n < 1 || n > turns.length) throw new Error(`${name} has ${turns.length} turn(s) on record; cannot revert ${n}`)
      const prompt = turns[turns.length - n]!.messageIDs?.[0]
      const at = prompt ? ids.indexOf(prompt) : -1
      if (at < 0) throw new Error("cannot find where that turn starts in the conversation (an older OpenCode history); pass to: <message id>")
      if (at === 0) throw new Error(`that would undo ${name}'s first turn, leaving nothing; dispose the agent (and its worktree) instead`)
      boundary = ids[at - 1]!
      undone = n
    }
    // OpenCode records a step's file snapshot shortly after the step ends (the fields can be
    // missing altogether until then); revert only once the turns being undone have theirs, or
    // it would find no changes to restore. A session that records no snapshots (outside git)
    // is not waited for.
    const after = (ms: typeof messages) => ms.slice(ms.findIndex((m) => m.id === boundary) + 1)
    const recording = (ms: typeof messages) => ms.some((m) => m.snapshot?.start || m.snapshot?.end)
    const pending = (ms: typeof messages) => recording(ms) && after(ms).some((m) => m.type === "assistant" && !m.snapshot?.end)
    for (let i = 0; i < 40 && pending(messages); i++) {
      await sleep(250)
      messages = await conversation()
    }
    // Staging may answer without a body (204); then the restored files are not known.
    const stageRes = await this.api.session.revert.stage({ sessionID, messageID: boundary, files: true })
    check(stageRes, "staging the revert")
    const staged = (stageRes.data as { data?: { files?: { path: string; status?: string }[] } } | undefined)?.data ?? {}
    check(await this.api.session.revert.commit({ sessionID }), "committing the revert")
    await this.refresh(live)
    // The gate judged work that no longer exists, and what is left was judged before: the
    // current turn is not gated again; the agent's next turn is.
    this.updateRecord(sessionID, { gateState: this.supersededGate(live), reportedSeq: live.track.seq })
    return { snapshot: this.build(live), files: (staged.files ?? []).map((f) => ({ path: f.path, status: f.status ?? "modified" })), turns: undone }
  }

  async snapshot(ref: string, active?: Set<string>): Promise<Snapshot> {
    const live = await this.get(ref)
    await this.refresh(live, active)
    return this.build(live)
  }

  /** Tracked agents (with per-agent errors), plus untracked root sessions in a directory if asked. */
  async list(opts: { includeUntracked?: boolean; directory?: string; limit?: number }): Promise<{
    snapshots: Snapshot[]
    errors: string[]
    untracked: SessionV2Info[]
  }> {
    this.syncStore()
    const active = await this.activeSet()
    const ids = [...this.live.keys()]
    const results = await Promise.allSettled(ids.map((id) => this.snapshot(id, active)))
    const snapshots: Snapshot[] = []
    const errors: string[] = []
    results.forEach((r, i) => {
      if (r.status === "fulfilled") snapshots.push(r.value)
      else errors.push(`${ids[i]}: ${(r.reason as Error).message}`)
    })
    let untracked: SessionV2Info[] = []
    if (opts.includeUntracked) {
      // OpenCode may record the real path (macOS /private/var, Windows long names): ask for both.
      const dir = this.resolveDir(opts.directory)
      const real = await fs.realpath(dir).catch(() => dir)
      const lists = await Promise.all(
        [...new Set([dir, real])].map(async (directory) =>
          unwrap(await this.api.session.list({ directory, limit: opts.limit ?? 20, order: "desc" }), "listing sessions"),
        ),
      )
      const owned = new Set(this.store.agents(this.serverKey).map((r) => r.id))
      const seen = new Set<string>()
      untracked = lists
        .flatMap((l) => l.data)
        .filter((s) => !seen.has(s.id) && seen.add(s.id))
        .filter((s) => !s.parentID && !this.live.has(s.id) && !owned.has(s.id) && !this.childToRoot.has(s.id))
        .sort((a, b) => b.time.updated - a.time.updated)
        .slice(0, opts.limit ?? 20)
    }
    return { snapshots, errors, untracked }
  }

  async transcript(ref: string, opts: { scope: "turn" | "all"; detail: Detail }): Promise<string> {
    const live = await this.get(ref)
    await this.refresh(live)
    const since = opts.scope === "turn" ? currentTurn(live.track)?.admittedAt : undefined
    const messages = await this.messages(live.record.id, since)
    return renderTranscript(messages, opts.detail)
  }

  /** Messages in chronological order, optionally only those created at or after `since`. */
  private async messages(id: string, since?: number): Promise<SessionMessage[]> {
    const out: SessionMessage[] = []
    let cursor: string | undefined
    for (let page = 0; page < 200; page++) {
      // The cursor already encodes the order; the API rejects both together.
      const res = unwrap(await this.api.session.messages({ sessionID: id, limit: 100, ...(cursor ? { cursor } : { order: "desc" }) }), "loading messages")
      let done = false
      for (const m of res.data) {
        if (since !== undefined && m.time.created < since) {
          done = true
          break
        }
        out.push(m)
      }
      if (done || !res.cursor.next || res.data.length < 100) break
      cursor = res.cursor.next
    }
    return out.reverse()
  }

  // --------------------------------------------------------------- waiting

  /** Whether a settled agent has something the caller has not seen yet. */
  hasNews(s: Snapshot, live = this.live.get(s.id)): boolean {
    if (!live || !SETTLED.has(s.state)) return false
    if (s.state === "idle" && gateUndecided(s)) return false
    if (s.state === "needs_input") return [...s.pending.permissions, ...s.pending.questions].some((r) => !live.reportedRequests.has(r.id))
    if (s.unreported.length > 0) return true
    // Interrupted or stuck before any turn could finish.
    return s.state !== "idle" && live.settledAt > (live.record.reportedAt ?? 0)
  }

  /** Remember what the caller was shown: exactly the requests and turns in this snapshot. */
  private markReported(s: Snapshot) {
    const live = this.live.get(s.id)
    if (!live) return
    for (const r of [...s.pending.permissions, ...s.pending.questions]) live.reportedRequests.add(r.id)
    if (s.state === "needs_input") return
    const seq = Math.max(live.record.reportedSeq, ...s.unreported.map((t) => t.startSeq))
    this.updateRecord(s.id, { reportedSeq: seq, reportedAt: Date.now() })
  }

  /**
   * Block until agents have news. mode "any": until one of them settled with
   * something not yet reported; "all": until every one is settled. What is
   * returned is marked as reported, so the next "any" wait returns the next agent.
   */
  async waitFor(
    refs: string[],
    mode: "any" | "all",
    timeoutMs: number,
    opts: { signal?: AbortSignal; onTick?: (snaps: Snapshot[], elapsedMs: number) => void; markReported?: boolean } = {},
  ): Promise<{ snapshots: Snapshot[]; news: Set<string>; errors: string[]; timedOut: boolean; nothingToWaitFor: boolean }> {
    const lives = await Promise.all(refs.map((r) => this.get(r)))
    const ids = [...new Set(lives.map((l) => l.record.id))]
    const start = Date.now()
    const deadline = start + timeoutMs
    let last: Snapshot[] = []
    for (;;) {
      // One round of reads, given up at the deadline or on abort even if a request hangs.
      const round = await this.untilDeadline(
        (async () => {
          const active = await this.activeSet()
          return Promise.allSettled(ids.map((id) => this.snapshot(id, active)))
        })(),
        deadline,
        opts.signal,
      )
      if (!round.done) {
        // What we knew last, as of the previous round; nothing new is marked as reported.
        return {
          snapshots: last.length ? last : ids.flatMap((id) => (this.live.get(id) ? [this.build(this.live.get(id)!)] : [])),
          news: new Set(),
          errors: ["the agents' status could not be read before the wait ended (the OpenCode server is not answering)"],
          timedOut: true,
          nothingToWaitFor: false,
        }
      }
      const results = round.value
      const snaps = results.filter((r): r is PromiseFulfilledResult<Snapshot> => r.status === "fulfilled").map((r) => r.value)
      const errors = results.flatMap((r, i) => (r.status === "rejected" ? [`${ids[i]}: ${(r.reason as Error).message}`] : []))
      // An idle agent is not done while its gate is undecided; anything needing attention still surfaces.
      const settled = snaps.filter((s) => SETTLED.has(s.state) && !(s.state === "idle" && gateUndecided(s)))
      const news = settled.filter((s) => this.hasNews(s))
      const allSettled = settled.length === snaps.length
      const done = mode === "any" ? news.length > 0 || allSettled : allSettled
      const timedOut = !done && (Date.now() >= deadline || !!opts.signal?.aborted)
      if (done || timedOut) {
        // Mark what the caller is about to see (news only: a timeout shows no other results).
        if (opts.markReported !== false) for (const s of done ? settled : news) this.markReported(s)
        // The board has a settled task's spend before the caller accepts or fails it.
        await Promise.all(lives.filter((l) => settled.some((s) => s.id === l.record.id)).map((l) => this.recordTaskActivity(l)))
        return { snapshots: snaps, news: new Set(news.map((s) => s.id)), errors, timedOut, nothingToWaitFor: done && news.length === 0 && mode === "any" }
      }
      last = snaps
      opts.onTick?.(snaps, Date.now() - start)
      await this.sleepUntilWoken(Math.min(this.backend.streaming ? 2_000 : 1_000, deadline - Date.now()), opts.signal)
    }
  }

  /** `p`'s value, unless the deadline passes or the signal aborts first. */
  private untilDeadline<T>(p: Promise<T>, deadline: number, signal?: AbortSignal): Promise<{ done: true; value: T } | { done: false }> {
    return new Promise((resolve, reject) => {
      const stop = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", stop)
        resolve({ done: false })
      }
      // A round that is already late still gets a moment, so a responsive server is always read once.
      const timer = setTimeout(stop, Math.max(1_000, deadline - Date.now()))
      if (signal?.aborted) return stop()
      signal?.addEventListener("abort", stop)
      p.then(
        (value) => {
          clearTimeout(timer)
          signal?.removeEventListener("abort", stop)
          resolve({ done: true, value })
        },
        (err) => {
          clearTimeout(timer)
          signal?.removeEventListener("abort", stop)
          reject(err)
        },
      )
    })
  }

  private sleepUntilWoken(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.wakeups.delete(done)
        signal?.removeEventListener("abort", done)
        resolve()
      }
      const timer = setTimeout(done, Math.max(0, ms))
      this.wakeups.add(done)
      signal?.addEventListener("abort", done)
    })
  }

  private wake() {
    for (const w of [...this.wakeups]) w()
  }

  // ---------------------------------------------------------------- events

  private onEvent(e: V2Event) {
    if (this.closed) return
    const raw = e as { type: string; data?: Record<string, unknown>; properties?: Record<string, unknown> }
    const d = raw.data ?? raw.properties ?? {}
    if (raw.type === "session.created") {
      const info = d.info as { id?: string; parentID?: string } | undefined
      const rootId = info?.parentID ? (this.live.has(info.parentID) ? info.parentID : this.childToRoot.get(info.parentID)) : undefined
      const root = rootId ? this.live.get(rootId) : undefined
      if (root && info?.id) this.addChild(root, info.id)
      return
    }
    const sid = typeof d.sessionID === "string" ? d.sessionID : undefined
    if (!sid) return
    const rootId = this.live.has(sid) ? sid : this.childToRoot.get(sid)
    const live = rootId ? this.live.get(rootId) : undefined
    if (!live) return
    if (sid !== rootId) live.hotChildren.set(sid, Date.now())
    switch (raw.type) {
      case "session.next.text.delta":
        if (sid === rootId) live.liveText = `${live.liveText}${String(d.delta ?? "")}`.slice(-400)
        return
      case "session.next.text.started":
      case "session.next.step.started":
        if (sid === rootId) {
          live.liveText = ""
          live.retry = undefined
        }
        break
      case "session.next.retried": {
        const err = d.error as { message?: string } | undefined
        live.retry = { attempt: Number(d.attempt) || 1, message: err?.message ?? "provider error" }
        break
      }
      case "session.next.step.ended":
        if (sid !== rootId) break
        live.retry = undefined
        // Pause requested: stop now, between steps of the root, so no tool gets killed mid-run.
        // A final step ends the turn by itself; then there is nothing to pause.
        if (live.record.pauseAfterStep) {
          if (d.finish === "tool-calls") {
            void this.interruptNow(live, live.record.stopReason ?? "paused after step")
              .catch(() => undefined)
              .then(() => this.wake())
          } else this.updateRecord(live.record.id, { pauseAfterStep: undefined })
        }
        break
    }
    if (/session\.next\.(prompted|step\.|tool\.(success|failed))|asked|replied|rejected|session\.idle|session\.status/.test(raw.type)) {
      void this.refresh(live)
        .catch(() => undefined)
        .then(() => this.wake())
    }
  }

  /** Background refresh so policies, limits and channel pushes work without a caller waiting. */
  private async tick() {
    if (this.monitoring || this.closed) return
    this.monitoring = true
    try {
      if (this.backend.dead) return
      // Gate fixes that wait for a running slot.
      for (const l of [...this.live.values()]) if (l.fix) await this.deliverFix(l).catch(() => undefined)
      const now = Date.now()
      const due = [...this.live.values()].filter((l) => {
        if (!l.loaded || this.working(l)) return true
        const recent = now - l.lastNewEventAt < 60 * 60_000
        return now - l.lastRefresh > (recent ? SETTLED_REFRESH_MS : DORMANT_REFRESH_MS)
      })
      if (!due.length) return
      // Every request has its own timeout; this bounds the whole round too, so one stuck agent cannot stop monitoring.
      await within(
        (async () => {
          const active = await this.activeSet()
          await Promise.all(due.map((l) => this.refresh(l, active).catch(() => undefined)))
        })(),
        TICK_MS,
        "a background refresh",
      )
      this.wake()
    } catch {
      // Server unreachable; try again next tick.
    } finally {
      this.monitoring = false
    }
  }

  // --------------------------------------------------------------- helpers

  private adoptRecord(record: AgentRecord): Live {
    const live: Live = {
      record,
      track: emptyTrack(),
      loaded: false,
      pending: { permissions: [], questions: [] },
      children: new Set(),
      childTracks: new Map(),
      hotChildren: new Map(),
      liveText: "",
      lastRefresh: 0,
      lastChildScan: 0,
      handled: new Set(),
      dialogs: new Map(),
      reportedRequests: new Set(),
      handedToCaller: new Set(),
      settledAt: 0,
      gen: 0,
      turnSeen: new Map(),
      sending: 0,
      holdGate: 0,
      admittedSeen: new Map(),
      lastNewEventAt: Date.now(),
    }
    this.live.set(record.id, live)
    return live
  }

  /**
   * Track a session this server did not spawn (e.g. one started in the TUI).
   * Adopted agents get the "ask" policy: nothing is answered on a human's behalf.
   */
  private adopt(session: SessionV2Info): Live {
    const record: AgentRecord = {
      id: session.id,
      server: this.serverKey,
      directory: session.location.directory,
      policy: "ask",
      questions: "ask",
      limits: {},
      createdAt: Date.now(),
      owner: SELF,
      ownerSeen: Date.now(),
      reportedSeq: 0,
      adoptPending: true,
      adopted: true,
    }
    this.store.put(record)
    return this.adoptRecord(record)
  }

  /** History before adoption is not news, except a turn that is still running. */
  private finishAdoption(live: Live) {
    const t = live.track
    const open = t.inLoop ? currentTurn(t) : undefined
    const ended = t.turns.filter((x) => x.endedAt !== undefined && x !== open)
    const reportedSeq = open ? open.startSeq - 1 : (ended[ended.length - 1]?.startSeq ?? 0)
    this.updateRecord(live.record.id, { reportedSeq, reportedAt: Date.now(), adoptPending: undefined })
  }

  /**
   * Load records for this server: ours, plus orphaned ones whose owner process
   * is gone (claimed). Drop agents whose record disappeared (disposed elsewhere).
   */
  private syncStore(ref?: string) {
    if (this.closed) return
    const records = this.store.agents(this.serverKey)
    const byId = new Map(records.map((r) => [r.id, r]))
    for (const id of [...this.live.keys()]) {
      const r = byId.get(id)
      // Disposed elsewhere, or claimed by another process (ours looked dead to it).
      if (!r || (r.owner && r.owner.token !== SELF.token)) this.dropLive(id)
    }
    // Ours, or orphaned: its owner process is gone, or its heartbeat stopped.
    const claimable = (r: AgentRecord) => r.owner?.token === SELF.token || !ownerAlive(r.owner, r.ownerSeen)
    for (const r of records) {
      if (this.live.has(r.id) || this.gone.has(r.id) || !claimable(r)) continue
      // Orphans of other projects are left alone unless asked for by id or name.
      if (r.owner?.token !== SELF.token && !inProject(r, this.projectRoot) && ref !== r.id && ref !== r.name) continue
      let claimed: AgentRecord | undefined
      try {
        // Re-read under the claim lock: another process may have claimed it since we listed it.
        claimed = this.store.claim(r.id, SELF, claimable)
      } catch {
        continue // the lock is busy; try again on the next sync
      }
      if (claimed) this.adoptRecord(claimed)
    }
  }

  private dropLive(id: string) {
    const live = this.live.get(id)
    if (!live) return
    for (const d of live.dialogs.values()) d.abort()
    for (const c of live.children) this.childToRoot.delete(c)
    this.live.delete(id)
  }

  /** Stop tracking an agent for good (disposed, failed spawn, or deleted). */
  private forget(id: string) {
    this.dropLive(id)
    this.gone.add(id)
    this.store.remove(id)
  }

  private updateRecord(id: string, patch: Partial<AgentRecord>) {
    const live = this.live.get(id)
    if (live) {
      Object.assign(live.record, patch)
      for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (live.record as unknown as Record<string, unknown>)[k]
    }
    try {
      this.store.update(id, patch)
    } catch {
      // Persistence is best effort; in-memory state stays authoritative.
    }
  }

  private findByName(name: string): Live | undefined {
    for (const l of this.live.values()) if (l.record.name === name) return l
    return undefined
  }

  /** Resolve a session id or agent name. Unknown root sessions are adopted; child ids resolve to their root. */
  async get(ref: string): Promise<Live> {
    let live = this.findByName(ref) ?? this.live.get(ref)
    if (live) return live
    this.syncStore(ref)
    live = this.findByName(ref) ?? this.live.get(ref)
    if (live) return live
    const foreign = this.store.agents(this.serverKey).find((r) => r.id === ref || r.name === ref)
    if (foreign) throw new Error(`agent "${ref}" is driven by another MCP session (pid ${foreign.owner?.pid}); use that session, or close it first`)
    if (!ref.startsWith("ses_")) throw new Error(`unknown agent "${ref}". Pass a session id (ses_…) or the name given at spawn; opencode_status lists them.`)
    const root = this.childToRoot.get(ref)
    if (root && this.live.has(root)) return this.live.get(root)!
    if (this.gone.has(ref)) throw new Error(`session ${ref} was disposed or deleted; it is no longer tracked`)
    const res = await this.api.session.get({ sessionID: ref })
    if (res.response?.status === 404) throw new Error(`session ${ref} does not exist on this OpenCode server`)
    const session = unwrap(res, `loading session ${ref}`).data
    // A subagent's session belongs to its root agent.
    if (session.parentID) {
      const rootLive = await this.get(session.parentID)
      this.addChild(rootLive, ref)
      return rootLive
    }
    return this.adopt(session)
  }

  ids(): string[] {
    return [...this.live.keys()]
  }
}

interface Prepared {
  files: { uri: string; name: string }[]
  inlined: string[]
}

/** Text attachments are inlined up to this size. */
const INLINE_LIMIT = 256 * 1024

/**
 * Text files are inlined (many providers reject text/plain file parts), so a text file over
 * the inline limit is refused; binary files (images, PDFs) are attached for models that accept them.
 */
async function prepareFiles(paths: string[], directory: string): Promise<Prepared> {
  const out: Prepared = { files: [], inlined: [] }
  for (const f of paths) {
    const abs = path.resolve(directory, f)
    const buf = await fs.readFile(abs).catch(() => {
      throw new Error(`attachment not found: ${abs}`)
    })
    const isText = !buf.subarray(0, 8192).includes(0)
    const rel = path.relative(directory, abs) || abs
    if (isText && buf.length > INLINE_LIMIT)
      throw new Error(
        `attachment ${rel} is a ${Math.ceil(buf.length / 1024)} KB text file; text attachments are inlined into the prompt and limited to ${INLINE_LIMIT / 1024} KB. Attach an excerpt, or tell the agent the path so it reads the file itself.`,
      )
    if (isText) out.inlined.push(`<file path="${rel}">\n${buf.toString("utf8")}\n</file>`)
    else out.files.push({ uri: pathToFileURL(abs).href, name: path.basename(abs) })
  }
  return out
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
