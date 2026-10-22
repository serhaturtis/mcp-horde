import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Board, current, isTrustedCommand, renderBrief } from "@mcp-horde/board"
import { formatUsd, git, loadTiers, loadWorkers, oneLine, tierLabel, tierModel, withLock } from "@mcp-horde/core"
import {
  checkVerdicts,
  collectReview,
  disagreements,
  type GateCheck,
  REVIEW_SCHEMA,
  type ReviewInput,
  renderVerdicts,
  reviewPrompt,
  type Verdict,
} from "@mcp-horde/review"
import { type CheckResult, lockDirFor, logDirFor, gate as runGate, defaultStateDir as verifyStateDir } from "@mcp-horde/verify"
import type {
  AgentInfo,
  FormInfo,
  ModelInfo,
  ModelRef,
  OpenCodeEvent,
  PermissionRequest,
  PermissionSavedInfo,
  SessionInfo,
  SessionMessageInfo,
} from "@opencode/client"
import { ASK_GUARDED_PROFILE, ASK_PREAMBLE, ASK_PROFILE, extractJson, type JsonSchema, retryPrompt, schemaPrompt, validate } from "./ask.js"
import type { Backend } from "./backend.js"
import { type Config, inProject, type PermissionPolicy } from "./config.js"
import { type Detail, inputSummary, renderTranscript } from "./render.js"
import { type AgentRecord, type GateConfig, type Limits, ownerAlive, type ReviewSummary, SELF, type Store } from "./state.js"
import { buildTrack, type CostEstimator, costSince, currentTurn, emptyTrack, latestTool, stablePrefix, type Track, type Turn, turnsSince } from "./tracker.js"
import {
  commitAll,
  commitMsgHook,
  createWorktree,
  followRebase,
  hasUncommitted,
  judgeCommits,
  landSync,
  mergeWorktree,
  removeWorktree,
  restoreWorktree,
  runLandStep,
  squashWorktree,
  syncWorktree,
  type Worktree,
  workStart,
  worktreeDiff,
} from "./worktree.js"

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
  permissions: PermissionRequest[]
  /** OpenCode's forms: the question tool's questions, and any other input it asks for. */
  questions: FormInfo[]
}

/** A form reply: per field key, the chosen value(s) or text. */
export type FormAnswer = Record<string, string | string[] | number | boolean>

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

/** How long a wait keeps retrying an agent it cannot read (a blip of the OpenCode server is retried). */
const UNREADABLE_MS = 60_000

/** Whether a wait is over for every id: settled, or unreadable since `unreadableSince` for UNREADABLE_MS. */
export function waitedOut(ids: string[], settled: Set<string>, unreadableSince: Map<string, number>, now: number): boolean {
  return ids.every((id) => settled.has(id) || now - (unreadableSince.get(id) ?? now) >= UNREADABLE_MS)
}

/** A gate that has not decided yet: the agent is not done, whatever its session says. */
export function gateUndecided(s: Snapshot): boolean {
  return !!s.gate && s.gate.state !== "pass" && s.gate.state !== "fail"
}

export interface Profile {
  /** Tool switches, e.g. { shell: false, webfetch: false }. */
  tools?: Record<string, boolean>
  /** Cap on agent-loop steps per turn (a step limit). */
  steps?: number
  description?: string
  /** OpenCode permission rules, e.g. { edit: { "*": "deny", "src/**": "allow" } }; the last match wins. */
  permission?: Record<string, string | Record<string, string>>
}

export type PermissionRule = { action: string; resource: string; effect: "allow" | "deny" | "ask" }

/** OpenCode 1 action names that OpenCode 2 renamed. */
const RENAMED_ACTIONS: Record<string, string> = { bash: "shell", write: "edit", patch: "edit", task: "subagent" }

/** A profile as OpenCode 2 session permissions: tool switches first, then the rules in order (the last match wins). */
export function profileRules(profile: Profile): PermissionRule[] {
  const action = (a: string) => RENAMED_ACTIONS[a] ?? a
  const effect = (v: string): PermissionRule["effect"] => {
    if (v === "allow" || v === "deny" || v === "ask") return v
    throw new Error(`permission effects are allow, deny or ask; got "${v}"`)
  }
  const rules: PermissionRule[] = Object.entries(profile.tools ?? {}).map(([t, on]) => ({ action: action(t), resource: "*", effect: on ? "allow" : "deny" }))
  for (const [a, rule] of Object.entries(profile.permission ?? {})) {
    if (typeof rule === "string") rules.push({ action: action(a), resource: "*", effect: effect(rule) })
    else for (const [glob, v] of Object.entries(rule)) rules.push({ action: action(a), resource: glob, effect: effect(v) })
  }
  return rules
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
  /** False to run outside the running limit (a short one-shot ask, not a worker). */
  reserve?: boolean
  /** A read-only investigation: no gate, and the prompt is the whole brief (no board reporting). */
  investigate?: boolean
}

/** How a caller asks for a gate: true for the defaults, or settings. */
export type GateInput = boolean | { checks?: string[]; audit?: boolean; allowed?: string[]; maxRounds?: number; related?: boolean; review?: boolean }

export interface Hooks {
  /** True when the client can show form dialogs to the human. */
  canElicit(): boolean
  askPermission(snap: Snapshot, req: PermissionRequest, signal: AbortSignal): Promise<{ reply: "once" | "always" | "reject"; message?: string } | undefined>
  askQuestion(snap: Snapshot, req: FormInfo, signal: AbortSignal): Promise<FormAnswer | "dismiss" | undefined>
  /** Called when an agent settles or newly needs input (channel push). */
  settled(snap: Snapshot): void
}

interface Live {
  record: AgentRecord
  track: Track
  loaded: boolean
  session?: SessionInfo
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
   * A prompt we sent (its message id) that the conversation does not show yet. Until it
   * does, the previous (settled) turn would look current.
   */
  sent?: { at: number; id: string }
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

/** The answer of a request, or an error that names what failed. */
async function req<T>(what: string, p: Promise<T>): Promise<T> {
  try {
    return await p
  } catch (err) {
    throw new Error(`${what} failed: ${(err as Error).message || String(err)}`, { cause: err })
  }
}

/** The client throws the server's tagged errors (e.g. SessionNotFoundError for a missing session). */
function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; cause?: { status?: number } } | undefined
  return /NotFoundError$/.test(e?.name ?? "") || e?.cause?.status === 404
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
    throw new Error(`model must look like "provider/model" (e.g. "deepseek/deepseek-flash"), got "${spec}"`)
  }
  return { providerID: spec.slice(0, slash), id: spec.slice(slash + 1), ...(variant ? { variant } : {}) }
}

export function formatModel(m?: ModelRef): string {
  if (!m) return "default model"
  return `${m.providerID}/${m.id}${m.variant && m.variant !== "default" ? ` [${m.variant}]` : ""}`
}

/** Why an agent cannot run on a model, if it cannot. */
export function unsupportedReason(m: ModelInfo): string | undefined {
  if (!m.capabilities.tools) return "does not support tool calls"
  // The provider retired it: requests fail (HTTP 410).
  if (m.status === "deprecated") return "deprecated by its provider"
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
    review: o.review ?? current?.review,
  }) as GateConfig
}

/** What the agent is told when its gate fails. The verdict comes last, verbatim. */
export function gateFeedback(round: number, maxRounds: number, verdict: string): string {
  return [
    `This task is not done yet (gate round ${round} of ${maxRounds}). Fix the problems below, then stop.`,
    "Do not skip, delete or weaken tests, do not silence errors or type checks, and stay within the files the task is about.",
    "",
    verdict,
  ].join("\n")
}

/** A check's result in a few words, e.g. "219 passed" or "1 failed of 212". */
export function checkSummary(c: Pick<CheckResult, "pass" | "extracted" | "stopped">): string {
  const n = c.extracted.counts
  if (c.stopped) return c.stopped === "timeout" ? "timed out" : "cancelled"
  if (c.pass) return n?.passed !== undefined ? `${n.passed} passed` : "ok"
  return n ? `${n.failed} failed${n.passed !== undefined ? ` of ${n.failed + n.passed}` : ""}` : "failed"
}

/** A check's line in a stored verdict, with how it compared with the baseline when it was given one. */
export type GateCheckSummary = Omit<GateCheck, "summary"> & { summary: string; baseline?: NonNullable<CheckResult["baseline"]> }

function gateCheck(c: CheckResult): GateCheckSummary {
  return { name: c.name, pass: c.pass, summary: checkSummary(c), ...(c.baseline ? { baseline: c.baseline } : {}) }
}

/** What the agent is told when the review finds criteria not met (the gate's lead line comes first). */
export function reviewFeedback(r: ReviewSummary): string {
  return [
    "The checks pass, but a reviewer comparing your change with the task's acceptance criteria found these not met:",
    ...r.notMet.map((c) => `- ${c.n}. ${c.text}${c.note ? ` (${c.note})` : ""}`),
  ].join("\n")
}

/** What a form asks, in one line: its first field's question. */
export function formText(f: FormInfo): string {
  const field = f.fields[0]
  return field.description ?? field.title ?? f.title
}

/**
 * A form reply from the caller's answers (per field, the chosen option labels or free text):
 * labels become option values, a multi-select keeps them all, other fields take the first.
 */
export function formAnswer(f: FormInfo, answers: string[][]): FormAnswer {
  const out: FormAnswer = {}
  f.fields.forEach((field, i) => {
    const given = answers[i] ?? []
    if (field.type === "external" || !given.length) return
    const options = "options" in field ? (field.options ?? []) : []
    const values = given.map((g) => options.find((o) => o.label === g || o.value === g)?.value ?? g)
    if (field.type === "multiselect") out[field.key] = values
    else if (field.type === "boolean") out[field.key] = /^(true|yes)$/i.test(values[0]!)
    else if (field.type === "number" || field.type === "integer") out[field.key] = Number(values[0])
    else out[field.key] = values[0]!
  })
  return out
}

/** "No preference" for every field: free text where allowed, else the first option or the default. */
export function dismissAnswer(f: FormInfo): FormAnswer {
  const text = "No preference: use your best judgment and continue."
  const out: FormAnswer = {}
  for (const field of f.fields) {
    if (field.type === "string" || field.type === "multiselect") {
      const first = field.options?.[0]?.value
      const value = field.custom !== false || first === undefined ? text : first
      out[field.key] = field.type === "multiselect" ? [value] : value
    } else if (field.type === "boolean") out[field.key] = field.default ?? false
    else if (field.type === "number" || field.type === "integer") out[field.key] = typeof field.default === "number" ? field.default : 0
  }
  return out
}

/** Drop undefined values, so a partial update never erases other fields. */
export function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

/** Orchestrates OpenCode sessions ("agents") through the OpenCode 2 API. */
export class Fleet {
  private readonly live = new Map<string, Live>()
  private readonly childToRoot = new Map<string, string>()
  /** Sessions disposed or found missing in this process: never re-adopt them implicitly. */
  private readonly gone = new Set<string>()
  private readonly modelCache = new Map<string, { at: number; models: ModelInfo[] }>()
  private readonly wakeups = new Set<() => void>()
  /** Spawns in progress, counted against the running limit. */
  private reserved = 0
  /** Names of spawns in progress, taken until their record is stored. */
  private readonly reservedNames = new Set<string>()
  private lastHeartbeat = 0
  private monitor?: NodeJS.Timeout
  private monitoring = false
  private closed = false
  /** A landing waits for the previous landing of its repository; a failure does not block the next. */
  private readonly landing = new Map<string, Promise<unknown>>()

  constructor(
    private readonly backend: Backend,
    private readonly config: Config,
    private readonly store: Store,
    private readonly hooks: Hooks,
  ) {
    this.syncStore()
    backend.events.on("event", (e: OpenCodeEvent) => {
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
    return this.backend.client
  }

  // ---------------------------------------------------------------- catalog

  async models(directory?: string): Promise<ModelInfo[]> {
    const dir = this.resolveDir(directory)
    const cached = this.modelCache.get(dir)
    if (cached && Date.now() - cached.at < 60_000) return cached.models
    let models: ModelInfo[] = []
    // A directory OpenCode has not opened yet answers with an empty catalog at first.
    for (let i = 0; i < 20; i++) {
      models = (await req("listing models", this.api.model.list({ location: { directory: dir } }, timed()))).data
      if (models.length) break
      await sleep(250)
    }
    if (models.length) this.modelCache.set(dir, { at: Date.now(), models })
    return models
  }

  /**
   * Steps OpenCode reports as free are priced from the catalog (USD per million tokens;
   * reasoning is billed as output), so a model without OpenCode's own pricing still counts.
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
    const loc = await req("locating the project", this.api.location.get({ location: { directory: dir } }))
    const rules = await req("listing saved permissions", this.api.permission.saved.list({ projectID: loc.project.id }))
    return { project: loc.project.directory, rules }
  }

  async removeSavedPermission(id: string, directory?: string): Promise<PermissionSavedInfo> {
    const { rules } = await this.savedPermissions(directory)
    const rule = rules.find((r) => r.id === id)
    if (!rule) throw new Error(`no saved permission ${id} for this project${rules.length ? `; saved: ${rules.map((r) => r.id).join(", ")}` : ""}`)
    await req("removing the saved permission", this.api.permission.saved.remove({ id }))
    return rule
  }

  async agents(directory?: string): Promise<AgentInfo[]> {
    const dir = this.resolveDir(directory)
    let agents: AgentInfo[] = []
    for (let i = 0; i < 20; i++) {
      agents = (await req("listing agents", this.api.agent.list({ location: { directory: dir } }))).data
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

  resolveDir(dir?: string): string {
    return path.resolve(this.config.directory, dir ?? ".")
  }

  /** The horde's state directory (agent records, reports). */
  get stateDir() {
    return this.config.stateDir
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
    const release = input.reserve === false ? () => {} : this.reserve()
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
   * An acceptance review of a task's latest attempt: a model judges each criterion from the
   * attempt's worktree diff and must cite its lines; citations are checked against the diff
   * (an unfounded "met" becomes "unclear"). With several models, where they disagree is
   * listed. The first model's outcome is kept on the attempt. By default the reviewer is the
   * cheapest tier model other than the one that did the work.
   */
  async review(input: {
    id: string
    directory?: string
    models?: string[]
    path?: string
    base?: string
    maxDiffChars?: number
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<string> {
    const { r, results, worker } = await this.reviewAttempt(input)
    const first = results[0]!
    const parts = results.map((x) => renderVerdicts(r, x.verdicts, x.model))
    const disputes = results.slice(1).flatMap((x) => disagreements(first, x))
    const cost = results.reduce((n, x) => n + x.cost, 0)
    const same = worker && results.some((x) => x.model === worker) ? `\n(reviewed by the model that did the work: a different one catches more)` : ""
    return `${parts.join("\n\n")}${results.length > 1 ? `\n\n${disputes.length ? `Reviewers disagree on:\n${disputes.join("\n")}` : "Reviewers agree on every criterion."}` : ""}\n(${formatUsd(cost)})${same}`
  }

  /** The verdicts of each reviewer model; the first is kept on the attempt. `checks` that passed may be cited. */
  private async reviewAttempt(input: {
    id: string
    directory?: string
    models?: string[]
    path?: string
    base?: string
    maxDiffChars?: number
    timeoutMs?: number
    signal?: AbortSignal
    checks?: GateCheck[]
  }): Promise<{ r: ReviewInput; results: { model: string; verdicts: Verdict[]; cost: number }[]; worker?: string }> {
    const repo = this.resolveDir(input.directory)
    const board = await Board.open(repo)
    const attempt = current(board.task(input.id))
    const override = input.path ? { path: this.resolveDir(input.path), base: input.base ?? "HEAD" } : undefined
    const r = await collectReview(board, input.id, { override, maxDiffChars: input.maxDiffChars })
    const worker = attempt?.model
    const models = input.models?.length ? input.models : [loadTiers(repo).find((t) => t.model !== worker)?.model]
    const results: { model: string; verdicts: Verdict[]; cost: number }[] = []
    for (const model of models) {
      const answer = await this.ask({
        prompt: reviewPrompt(r, input.checks),
        model,
        schema: REVIEW_SCHEMA as unknown as JsonSchema,
        directory: repo,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
      })
      results.push({
        model: answer.model ? `${answer.model.providerID}/${answer.model.id}` : "default model",
        verdicts: checkVerdicts(r, answer.json, input.checks),
        cost: answer.cost,
      })
    }
    const first = results[0]!
    if (attempt && !override)
      await board.recordReview(input.id, attempt.n, {
        model: first.model,
        met: first.verdicts.filter((v) => v.status === "met").length,
        notMet: first.verdicts.filter((v) => v.status === "not_met").length,
        total: first.verdicts.length,
        at: Date.now(),
      })
    return { r, results, worker }
  }

  /** The gate's review: the change judged against the task's criteria, seeing the checks that just passed. Never throws. */
  private async reviewForGate(live: Live, taskId: string, checks: GateCheck[], signal: AbortSignal): Promise<ReviewSummary> {
    try {
      return await this.reviewGate(live, taskId, checks, signal)
    } catch {
      // A transient provider failure (a rate limit, a timeout) is not a verdict: pause and retry once.
      // Long enough for a rate limit or a refused slot to clear, short enough not to stall the gate.
      await sleep(5000)
      if (signal.aborted) return { model: "", cost: 0, total: 0, met: 0, notMet: [], unclear: [], error: "cancelled" }
      try {
        return await this.reviewGate(live, taskId, checks, signal)
      } catch (retryErr) {
        return { model: "", cost: 0, total: 0, met: 0, notMet: [], unclear: [], error: (retryErr as Error).message }
      }
    }
  }

  private async reviewGate(live: Live, taskId: string, checks: GateCheck[], signal: AbortSignal): Promise<ReviewSummary> {
    const { results } = await this.reviewAttempt({ id: taskId, directory: live.record.worktree?.repo ?? live.record.directory, checks, signal })
    const first = results[0]!
    const pick = (status: Verdict["status"]) => first.verdicts.filter((v) => v.status === status).map((v) => ({ n: v.criterion, text: v.text, note: v.note }))
    return {
      model: first.model,
      cost: results.reduce((n, x) => n + x.cost, 0),
      total: first.verdicts.length,
      met: first.verdicts.filter((v) => v.status === "met").length,
      notMet: pick("not_met"),
      unclear: pick("unclear"),
    }
  }

  /**
   * A one-shot answer: a session in the project whose permissions deny every tool, one
   * prompt, the answer, and the session is deleted. With a schema the reply must be JSON
   * that conforms; one retry is given with the problems.
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
    const timeout = input.timeoutMs ?? 300_000
    const once = async (profile: Profile) => {
      const name = `ask-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      const { snapshot } = await this.spawn({
        prompt: ASK_PREAMBLE + (input.schema ? schemaPrompt(input.prompt, input.schema) : input.prompt),
        name,
        model: input.model,
        variant: input.variant,
        profile,
        directory: project,
        files: input.files?.map((f) => path.resolve(project, f)),
        permissions: "deny",
        questions: "dismiss",
        limits: { maxSteps: 3 },
        reserve: false,
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
      return { ...(await once(ASK_PROFILE)), guarded: false }
    } catch (err) {
      // OpenCode's free tier refuses tool-less agents; ask again with tools present but denied.
      if (!/FreeTierError|free tier/i.test((err as Error).message)) throw err
      return { ...(await once(ASK_GUARDED_PROFILE)), guarded: true }
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
    const tiers = loadTiers(directory)
    // An explicit model that is one of the tiers records that tier (the highest, if listed twice),
    // so the outcome footer and the escalation hint name the real one.
    const matched = input.model ? tiers.reduce((found, t, i) => (t.model === input.model ? i : found), -1) : -1
    // Without an explicit model, the task's tier picks one from horde.json "tiers".
    const tier = input.model ? undefined : tierModel(current.tier, tiers, taskId)
    const effective: SpawnInput = {
      ...input,
      name,
      model: input.model ?? tier?.model,
      variant: input.model ? input.variant : (input.variant ?? tier?.variant),
      isolation: input.isolation ?? "worktree",
      gate: input.gate ?? (current.scope.length ? { allowed: current.scope } : true),
      // The task's scope confines edits too, not only the audit.
      scope: input.scope ?? (current.scope.length ? { paths: current.scope } : undefined),
    }
    // Everything that can be checked is checked before the board records an attempt.
    const checked = await this.checkSpawn(effective)
    try {
      // Only an accepted spawn moves the task to the tier its explicit model names.
      if (matched >= 0 && current.tier !== matched) await board.edit(taskId, { tier: matched })
      const { task, attempt } = await board.assign(taskId, name)
      const extra = input.prompt.trim()
      // An investigation's prompt is the whole instruction (no board reporting commands).
      const prompt = input.investigate
        ? extra
        : `${renderBrief(board, task, attempt, 6000, directory)}${extra ? `\n\n## Additional instructions\n${extra}` : ""}`
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
          `working ${task.id} "${task.title}" (attempt ${attempt.n}${tier || matched >= 0 ? `, ${tierLabel(task.tier, tiers)}` : ""}); its report lands on the board`,
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
      if (input.scope && !input.scope.paths.length) throw new Error("scope.paths needs at least one path or glob")
      const model = input.model ? parseModel(input.model, input.variant) : undefined
      if (!model && input.variant) throw new Error("variant requires model (pick one with opencode_models)")
      if (model) await this.validateModel(model, directory)
      if (input.agent) await this.validateAgent(input.agent, directory)
      // Profile rules are checked here too, so a bad effect fails before anything is created.
      if (input.profile) profileRules(input.profile)
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
    let sessionId: string | undefined
    let prompted = false
    try {
      if (input.isolation === "worktree") {
        // horde.json "workers" says how to prepare a worktree; without it, ignored dependency directories are linked.
        const workers = loadWorkers(directory)
        const made = await createWorktree(directory, name, {
          rootDir: this.config.worktreeDir,
          includeUncommitted: input.worktree?.includeUncommitted ?? true,
          link: input.worktree?.link ?? workers.link,
          setup: input.worktree?.setup ?? workers.setup,
          submodules: input.worktree?.submodules,
          signal: input.signal,
          onProgress: input.onProgress,
        })
        worktree = made.worktree
        notes.push(...made.notes)
        directory = worktree.path
      }
      if (input.signal?.aborted) throw new Error("cancelled")
      // A profile is the session's own permission rules, added after the agent's.
      const profile = input.scope ? withScope(input.profile ?? {}, input.scope) : input.profile
      const session = await req(
        "creating session",
        this.api.session.create({
          location: { directory },
          title: `horde: ${name}`,
          ...(model ? { model } : {}),
          ...(input.agent ? { agent: input.agent } : {}),
          ...(profile ? { permissions: profileRules(profile) } : {}),
        }),
      )
      sessionId = session.id
      const steps = [input.limits?.maxSteps, profile?.steps].filter((n): n is number => !!n)
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
        limits: defined({ ...input.limits, maxSteps: steps.length ? Math.min(...steps) : undefined }),
        scope: input.scope,
        createdAt: Date.now(),
        owner: SELF,
        ownerSeen: Date.now(),
        reportedSeq: 0,
        gate: await gateConfig(gate, directory, !!worktree),
        investigate: input.investigate,
      }
      this.store.put(record)
      const live = this.adoptRecord(record)
      live.loaded = true // a brand-new session has no history to replay
      const preamble: string[] = []
      if (input.instructions) preamble.push(`<instructions>\n${input.instructions}\n</instructions>`)
      if (worktree) {
        const hook = await commitMsgHook(worktree.repo)
        preamble.push(
          `<workspace>You are working in an isolated git worktree on branch ${worktree.branch}. Commit your changes to this branch with clear messages when the task is done. Do not push, and do not switch branches.${hook ? ` This repository has a commit-msg hook at ${hook}: commit your work with git commit in a message it accepts (read the hook for its rules), never with --no-verify.` : ""}</workspace>`,
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
          await this.api.session.remove({ sessionID: sessionId }).catch(() => undefined)
        }
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
        await req("switching model", this.api.session.switchModel({ sessionID: id, model }))
      }
      if (opts.agent) {
        await this.validateAgent(opts.agent, directory)
        await req("switching agent", this.api.session.switchAgent({ sessionID: id, agent: opts.agent }))
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
    let sent: { id: string }
    live.sending++
    try {
      sent = await req(
        "sending prompt",
        this.api.session.prompt({
          sessionID: live.record.id,
          text: body,
          ...(prepared.files.length ? { files: prepared.files } : {}),
          delivery: delivery ?? "steer",
        }),
      )
    } finally {
      live.sending--
    }
    // Any refresh that started before this point must not publish its (now stale) state.
    live.gen++
    live.state = "running"
    live.liveText = ""
    live.sent = { at: Date.now(), id: sent.id }
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
        else if (reply.answers) await this.answerQuestion(question, formAnswer(question, reply.answers))
        else await this.dismissQuestion(question)
      }
    } catch (err) {
      live.handled.delete(requestID)
      throw err
    }
    return this.snapshot(id)
  }

  private async replyPermission(p: PermissionRequest, decision: "once" | "always" | "reject", message?: string) {
    await req("replying to permission", this.api.permission.reply({ sessionID: p.sessionID, requestID: p.id, decision, ...(message ? { message } : {}) }))
  }

  private async answerQuestion(q: FormInfo, answer: FormAnswer) {
    await req("answering question", this.api.session.form.reply({ sessionID: q.sessionID, formID: q.id, answer }))
  }

  /** Cancelling a question halts the agent in OpenCode, so "dismiss" answers it instead. */
  private async dismissQuestion(q: FormInfo) {
    await this.answerQuestion(q, dismissAnswer(q))
  }

  private async rejectQuestion(q: FormInfo) {
    await req("rejecting question", this.api.session.form.cancel({ sessionID: q.sessionID, formID: q.id }))
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
      const err = await this.api.session.remove({ sessionID: id }).then(
        () => undefined,
        (e: Error) => e,
      )
      notes.push(err ? `could not delete session ${id} (${err.message}); it stays in OpenCode history` : `deleted session ${id}`)
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
        const release = () => this.api.debug.location.evict({ location: { directory: wt.path } }).catch(() => undefined)
        notes.push(await removeWorktree(wt, name, mode === "discard", release))
        // Its check logs go too: nothing reads them once the worktree is gone.
        for (const dir of new Set([wt.path, wt.root])) await fs.rm(logDirFor(path.join(verifyStateDir(), "logs"), dir), { recursive: true, force: true })
      }
    }
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
      if (synced.worktree) await this.rebindTaskBase(live, synced.worktree)
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

  /** After a sync, the task's attempt starts where the worktree's own work now starts (for reviews and report checks). */
  private async rebindTaskBase(live: Live, wt: Worktree) {
    const task = live.record.task
    if (!task) return
    const board = await Board.open(wt.repo).catch(() => undefined)
    const a = board?.task(task.id).attempts.find((x) => x.n === task.attempt)
    if (board && a?.workspace && !a.endedAt) await board.bindWorkspace(task.id, a.token, { ...a.workspace, base: workStart(wt) }).catch(() => undefined)
  }

  /** After a landing conflict the worker rebases its branch onto the target: move the recorded base
   * (and baseline) forward with it, before the next gate or landing counts the target's commits as
   * the worker's. Persists like a sync. */
  private async followRebase(live: Live, wt: Worktree): Promise<Worktree> {
    const followed = await followRebase(wt)
    if (followed === wt) return wt
    this.updateRecord(live.record.id, { worktree: followed })
    await this.rebindTaskBase(live, followed)
    return followed
  }

  /**
   * Land a task-bound agent's work without ever breaking your branch. Its own commits (everything
   * after the carried-over baseline) are rebased onto your branch's tip inside its worktree, the
   * project's checks run on exactly that tree, and only if they pass — and your branch has not moved
   * meanwhile — is your branch fast-forwarded to the checked commit, keeping its hashes. The user's
   * carried-over changes stay uncommitted in their checkout. Then the task is accepted and the
   * worktree and branch are removed. Anything that fails leaves your branch as it was; the agent is
   * then on top of your branch and can be told to fix it.
   *
   * With `message`, the task's own commits are squashed into one commit with it, judged first by the
   * repository's commit-msg hook. Without a message, a repository that has a hook needs its work
   * committed: leftover changes are refused rather than committed with --no-verify.
   */
  async land(ref: string, signal?: AbortSignal, message?: string): Promise<LandResult> {
    const live = await this.get(ref)
    const id = live.record.id
    const name = live.record.name ?? id
    const task = live.record.task
    if (live.record.investigate)
      throw new Error(`${name} is an investigation (horde_investigate): it produces a report, never changes, so there is nothing to land.`)
    if (!task || !live.record.worktree) throw new Error(`${name} is not a task in a worktree (horde_do starts one); merge it with opencode_worktree`)
    await this.refresh(live)
    if (this.working(live))
      throw new Error(`${name} is still ${live.state === "needs_input" ? "waiting for an answer" : "working"}; horde_wait for its outcome first`)
    if (!this.readyToLand(live)) {
      const g = this.gateView(live)
      throw new Error(
        `${name} is not ready to land: ${g ? `its checks ${g.state === "fail" ? "failed" : "have not passed yet"}` : `it is ${live.state}`}. horde_tell it to finish, or horde_drop it.`,
      )
    }
    return this.withoutGate(live, async () => {
      const repo = live.record.worktree!.repo
      const previous = this.landing.get(repo) ?? Promise.resolve()
      const run = previous.then(() => this.landLoop(live, id, name, task, signal, message))
      const tail = run.catch(() => undefined)
      this.landing.set(repo, tail)
      void tail.then(() => {
        if (this.landing.get(repo) === tail) this.landing.delete(repo)
      })
      return run
    })
  }

  /**
   * One landing, retried up to 3 times when the branch tip moves under it from outside this
   * process (the user committing, another session). Parallel lands of one repository queue here,
   * so a land waits for the previous one before its first attempt instead of redoing its checks.
   */
  private async landLoop(
    live: Live,
    id: string,
    name: string,
    task: { id: string; title: string; attempt: number },
    signal: AbortSignal | undefined,
    message: string | undefined,
  ): Promise<LandResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      let wt = live.record.worktree!
      const target = await git(wt.repo, "symbolic-ref", "-q", "--short", "HEAD").catch(() => "")
      if (!target) throw new Error(`your checkout ${wt.repo} is on a detached HEAD; switch to a branch first`)
      // After a landing conflict the worker rebased its branch onto the target: the recorded base
      // must follow it or the next gate and landing count the target's commits as the worker's.
      wt = await this.followRebase(live, wt)
      // A repository with a commit-msg hook judges every commit: our own --no-verify commit
      // would bypass it, so leftover work is refused until the worker commits it or a message
      // squashes everything into one commit the hook checks.
      const hook = await commitMsgHook(wt.repo)
      if (hook && !message && (await hasUncommitted(wt))) return { landed: false, target, why: "leftovers", text: hook }
      const tip = await git(wt.repo, "rev-parse", "HEAD")
      // 1. Onto your branch's tip, inside the worktree, leaving the carried-over baseline out. A
      // conflict leaves both as they were; anything else failing is reported by its own cause.
      let leftover = false
      try {
        const synced = await landSync(wt, name)
        leftover = synced.leftover ?? false
        if (synced.worktree) {
          wt = synced.worktree
          // The verdict stands for landing again; a new turn is gated as usual.
          const gs = live.record.gateState ?? { round: 0 }
          this.updateRecord(id, { worktree: wt, gateState: { ...gs, superseded: currentTurn(live.track)?.startSeq } })
          await this.rebindTaskBase(live, wt)
        }
      } catch (err) {
        if (!(err as { conflicts?: boolean }).conflicts) throw err
        return {
          landed: false,
          target,
          why: "conflict",
          text: (err as Error).message
            .split("\n")
            .filter((l) => !/^Tell the agent/.test(l))
            .join("\n"),
        }
      }
      // 1b. With a message: the task's own commits become one, which the hook just judged.
      if (message) {
        const squashed = await squashWorktree(wt, message, leftover)
        if (squashed.refused !== undefined) return { landed: false, target, why: "message", text: squashed.refused, hook }
      }
      // 2. workers.land, after the rebase and the optional squash: run it, commit its changes on
      // top (judged by the repository's hooks), keeping the branch's pre-step commit to restore if
      // this attempt does not fast-forward, so the worker's branch never keeps the land step's
      // commit or files.
      const land = loadWorkers(wt.repo).land
      let judged = ""
      let beforeLand: string | undefined
      if (land) {
        const before = await git(wt.root, "rev-parse", "HEAD")
        beforeLand = before
        try {
          judged = await runLandStep(wt, task.id, target, land)
        } catch (err) {
          await restoreWorktree(wt, before).catch(() => undefined)
          return { landed: false, target, why: "land", text: (err as Error).message }
        }
      } else {
        judged = await git(wt.root, "rev-parse", "HEAD")
      }
      const commits = (await git(wt.repo, "rev-list", "--count", `${tip}..${judged}`).catch(() => "0")).trim()
      // A husky v9 hook lives in a core.hooksPath directory git ignores, so it is absent from the
      // worktree and the worker's `git commit` there never ran it. Judge every commit that will
      // land (the task's own, from workStart); a workers.land commit is judged by commitLandStep.
      if (hook && !message) {
        const refused = await judgeCommits(wt, hook, workStart(wt), land ? beforeLand! : judged)
        if (refused !== undefined) {
          if (beforeLand) await restoreWorktree(wt, beforeLand).catch(() => undefined)
          return { landed: false, target, why: "message", text: refused, hook }
        }
      }
      const v = await runGate(wt.root, {
        audit: false,
        related: false,
        stage: "land",
        env: { HORDE_TASK: task.id, HORDE_WORKTREE: wt.root },
        baseline: this.baselineFor(wt.repo, tip, `${target}'s tip`),
        signal,
        stateDir: verifyStateDir(),
      })
      if (!v.pass) {
        if (beforeLand) await restoreWorktree(wt, beforeLand).catch(() => undefined)
        return { landed: false, target, why: "checks", text: v.text, checks: v.checks.map(gateCheck) }
      }
      // 3. Under a per-repository lock, fast-forward your branch only if it is still at the tip the
      // checks saw; otherwise go round again (rebase onto the new tip, check again).
      const lockDir = await lockDirFor(wt.repo, verifyStateDir())
      await fs.mkdir(lockDir, { recursive: true }).catch(() => undefined)
      let advanced = false
      try {
        advanced = await withLock(lockDir, "land", async () => {
          if ((await git(wt.repo, "rev-parse", "HEAD")) !== tip) return false
          await git(wt.repo, "merge", "--ff-only", judged)
          return true
        })
      } catch (err) {
        if (beforeLand) await restoreWorktree(wt, beforeLand).catch(() => undefined)
        // The tip was still where the checks saw it, so only the user's uncommitted changes can
        // refuse the fast-forward; the refusal names them.
        const changed = await git(wt.repo, "status", "--porcelain").catch(() => "")
        const detail = err instanceof Error ? err.message : String(err)
        return {
          landed: false,
          target,
          why: "uncommitted",
          text: `${detail}${changed ? `\nuncommitted changes:\n${changed}` : ""}`,
        }
      }
      if (!advanced) {
        if (beforeLand) await restoreWorktree(wt, beforeLand).catch(() => undefined)
        continue
      }
      const board = await Board.open(wt.repo)
      await board.accept(task.id, { note: `landed on ${target}` }).catch(() => undefined)
      // The branch goes only once every one of its commits is on your branch (they all are, after a fast-forward).
      const unmerged = (await git(wt.repo, "cherry", target, wt.branch, tip).catch(() => "+")).split("\n").filter((l) => l.startsWith("+"))
      await this.dispose(id, { worktree: "discard" })
      if (!unmerged.length) await git(wt.repo, "branch", "-D", wt.branch).catch(() => undefined)
      return {
        landed: true,
        target,
        commits: Number(commits) || 0,
        checks: v.checks.map(gateCheck),
        branchKept: unmerged.length ? wt.branch : undefined,
      }
    }
    throw new Error(`your branch kept moving while ${name} was being landed; call horde_land again`)
  }

  /** The agent finished and its gate passed (also when a landing synced it since). */
  private readyToLand(live: Live): boolean {
    if (this.gateView(live)?.state === "pass") return true
    const gs = live.record.gateState
    const turn = currentTurn(live.track)
    return !!(gs?.verdict?.pass && gs.verdict.final && turn && gs.superseded === turn.startSeq && gs.verdict.turn === turn.startSeq)
  }

  /** Replace an agent's scope: its session's edit rules, the gate's audit and its board task. Approving a request never does this. */
  async setScope(ref: string, paths: string[]): Promise<void> {
    if (!paths.length) throw new Error("scope needs at least one path or glob")
    const live = await this.get(ref)
    const id = live.record.id
    const scope: Scope = { paths, outside: live.record.scope?.outside ?? "deny" }
    const session = await this.session(id)
    const kept = (session.permissions ?? []).filter((r) => r.action !== "edit")
    await req("updating the agent's rules", this.api.session.update({ sessionID: id, permissions: [...kept, ...profileRules(withScope({}, scope))] }))
    this.updateRecord(id, { scope, ...(live.record.gate ? { gate: { ...live.record.gate, allowed: scopeGlobs(paths) } } : {}) })
    const task = live.record.task
    if (task) await (await Board.open(live.record.worktree?.repo ?? live.record.directory)).edit(task.id, { scope: paths })
  }

  /** Replace a task's done-criteria, the board acceptance the review judges each round. */
  async setDone(ref: string, criteria: string[]): Promise<void> {
    if (!criteria.length) throw new Error("done needs at least one criterion")
    const live = await this.get(ref)
    const task = live.record.task
    if (!task) throw new Error(`${live.record.name ?? live.record.id} has no task on the board`)
    await (await Board.open(live.record.worktree?.repo ?? live.record.directory)).edit(task.id, { acceptance: criteria })
  }

  /**
   * Re-judge a finished, failed turn under the agent's (possibly changed) rules, as the next
   * gate round. A scope change that lets the audit pass then produces a fresh verdict, instead
   * of leaving the task stuck with no new outcome. Runs in the background like a normal gate.
   */
  async regate(ref: string): Promise<void> {
    const live = await this.get(ref)
    await this.refresh(live)
    const id = live.record.id
    const turn = currentTurn(live.track)
    const gs = live.record.gateState
    if (!live.record.gate) throw new Error(`${live.record.name ?? id} has no gate to re-run`)
    if (!turn || !gs?.verdict?.final) throw new Error(`${live.record.name ?? id} has no finished, judged turn to re-check; horde_tell it a message instead`)
    // The same turn is judged again and reported again once the new verdict lands.
    this.updateRecord(id, { gateState: { round: gs.round }, reportedSeq: turn.startSeq - 1 })
    const abort = new AbortController()
    live.gating = { turn: turn.startSeq, abort }
    void this.runGateFor(live, turn.startSeq, abort).finally(() => {
      if (live.gating?.abort === abort) live.gating = undefined
      this.wake()
      if (!this.closed && this.live.get(id) === live) void this.refresh(live).catch(() => undefined)
    })
  }

  /** What an outcome reports beyond the snapshot: the record (worktree, task, gate verdict) and edits refused outside the scope. */
  async inspect(ref: string): Promise<{ snapshot: Snapshot; record: AgentRecord; refused: string[] }> {
    const live = await this.get(ref)
    const snapshot = await this.snapshot(live.record.id)
    const refused = new Set<string>()
    for (const m of live.track.messages) {
      if (m.type !== "assistant") continue
      for (const c of m.content) {
        if (c.type !== "tool" || c.state.status !== "error" || !/permission denied/i.test(c.state.error.message)) continue
        const input = c.state.input as { path?: unknown; filePath?: unknown; command?: unknown }
        const what = [input.path, input.filePath, input.command].find((x): x is string => typeof x === "string")
        refused.add(`${c.name}${what ? ` ${what}` : ""}`)
      }
    }
    return { snapshot, record: live.record, refused: [...refused] }
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

  async session(id: string): Promise<SessionInfo> {
    return req(`loading session ${id}`, this.api.session.get({ sessionID: id }))
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
    return new Set(Object.keys(await req("listing active sessions", this.api.session.active(timed()))))
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
    try {
      live.session = await this.api.session.get({ sessionID: id }, timed())
    } catch (err) {
      if (!isNotFound(err)) throw new Error(`loading session ${id} failed: ${(err as Error).message}`, { cause: err })
      this.forget(id)
      const wt = live.record.worktree
      throw new Error(
        `session ${id} no longer exists on the OpenCode server (deleted?); stopped tracking it${wt ? `. Its worktree is left as it was: ${wt.path} (branch ${wt.branch} in ${wt.repo}); merge or remove it with git` : ""}`,
      )
    }

    // The conversation since its last settled turn.
    const replaying = !live.loaded
    const turnsBefore = live.track.turns.length ? currentTurn(live.track)!.startSeq : -1
    const seqBefore = live.track.seq
    live.track = await this.readHistory(id, live.track, live.session.location.directory)
    // Grace windows run on local receive times, so a skewed server clock cannot shorten or stretch them.
    const seenAt = Date.now()
    if (live.track.seq !== seqBefore || replaying) live.lastNewEventAt = seenAt
    for (const mid of live.track.admitted.keys()) if (!live.admittedSeen.has(mid)) live.admittedSeen.set(mid, seenAt)
    for (const mid of live.admittedSeen.keys()) if (!live.track.admitted.has(mid)) live.admittedSeen.delete(mid)
    const sent = live.sent
    if (sent && (live.track.ids.has(sent.id) || live.track.admitted.has(sent.id))) live.sent = undefined
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
      const t = live.childTracks.get(c) ?? emptyTrack()
      live.childTracks.set(c, await this.readHistory(c, t, live.session.location.directory).catch(() => t))
    }
    const tree = [id, ...hot]
    const [perms, questions] = await Promise.all([
      Promise.all(tree.map((sid) => req("listing permissions", this.api.permission.list({ sessionID: sid }, timed())))),
      Promise.all(tree.map((sid) => req("listing questions", this.api.session.form.list({ sessionID: sid }, timed())))),
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

  private async readHistory(sessionID: string, track: Track, directory: string): Promise<Track> {
    // Pricing comes from the catalog; load it once per directory.
    if (!this.modelCache.has(directory)) await this.models(directory).catch(() => undefined)
    const [messages, inbox] = await Promise.all([
      this.conversation(sessionID, track.messages),
      req("reading the inbox", this.api.session.inbox.list({ sessionID }, timed())),
    ])
    return buildTrack(messages, inbox, this.estimator(directory))
  }

  /**
   * The conversation, oldest first. Everything through the last `idle` marker never changes,
   * so only newer messages are read; when that marker is gone (a revert), all of it is.
   * ponytail: an open turn is re-read whole on every refresh; read by message if long turns get slow.
   */
  private async conversation(sessionID: string, known: SessionMessageInfo[] = []): Promise<SessionMessageInfo[]> {
    const keep = stablePrefix(known)
    const anchor = known[keep - 1]
    const fresh: SessionMessageInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < 1000; page++) {
      // The cursor already encodes the order.
      const res = await req("reading the conversation", this.api.message.list({ sessionID, limit: 100, ...(cursor ? { cursor } : { order: "desc" }) }, timed()))
      for (const m of res.data) {
        if (anchor && m.id === anchor.id) return [...known.slice(0, keep), ...fresh.reverse()]
        if (anchor && m.time.created < anchor.time.created) return this.conversation(sessionID)
        fresh.push(m)
      }
      if (!res.cursor.next || res.data.length < 100) break
      cursor = res.cursor.next
    }
    return anchor ? this.conversation(sessionID) : fresh.reverse()
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

  /**
   * A throwaway checkout of `commit` where verify re-runs checks that fail, so failures the
   * commit already had are not blamed on the work. verify releases it after the run.
   */
  private baselineFor(repo: string, commit: string, label: string) {
    return {
      commit,
      label,
      checkout: async () => {
        const name = `base-${commit.slice(0, 8)}-${randomBytes(2).toString("hex")}`
        const workers = loadWorkers(repo)
        const { worktree } = await createWorktree(repo, name, {
          rootDir: this.config.worktreeDir,
          includeUncommitted: false,
          at: commit,
          link: workers.link,
          setup: workers.setup,
        })
        // verify deletes its own log dir; removeWorktree deletes the branch too (no commits).
        return {
          root: worktree.root,
          release: async () => {
            await removeWorktree(worktree, name, true)
          },
        }
      },
    }
  }

  private async runGateFor(live: Live, turn: number, abort: AbortController) {
    const id = live.record.id
    const cfg = live.record.gate!
    const round = (live.record.gateState?.round ?? 0) + 1
    let wt = live.record.worktree
    if (wt) wt = await this.followRebase(live, wt)
    const start = wt ? workStart(wt) : undefined
    let pass = false
    let text: string
    let checks: GateCheckSummary[] | undefined
    let review: ReviewSummary | undefined
    try {
      const v = await runGate(live.session?.location.directory ?? live.record.directory, {
        base: start ?? cfg.base,
        audit: cfg.audit,
        // Only an unaudited shared gate may use the human's working config; an audited one
        // must judge by the rules that were in force at base.
        settingsFrom: !wt && !cfg.audit ? "working" : "base",
        checks: cfg.checks,
        allowed: cfg.allowed,
        related: cfg.related !== false,
        stage: "work",
        env: wt ? { HORDE_TASK: live.record.task?.id ?? live.record.name ?? live.record.id, HORDE_WORKTREE: wt.root } : undefined,
        baseline: wt && start ? this.baselineFor(wt.repo, start, `${start.slice(0, 8)} where the task started`) : undefined,
        signal: abort.signal,
        stateDir: verifyStateDir(),
      })
      pass = v.pass
      text = v.text
      checks = v.checks.map(gateCheck)
    } catch (err) {
      text = `the gate could not run: ${(err as Error).message}`
    }
    // The checks pass: does the change do what the task asked? A criterion found not met goes back
    // to the agent like a failing check while rounds remain; on the last round it is reported.
    const task = live.record.task
    if (pass && cfg.review && task && !abort.signal.aborted) {
      review = await this.reviewForGate(live, task.id, checks ?? [], abort.signal)
      if (review.error) {
        // The review could not run: the checks passing is not enough to call it done.
        pass = false
        text = `the review could not run: ${review.error}`
      } else if (review.notMet.length) {
        // A criterion the reviewer judged not met is a failing check, whatever the round.
        pass = false
        text = reviewFeedback(review)
      }
    }
    // A repository with a commit-msg hook judges every commit. Work left uncommitted would be
    // committed during landing with --no-verify, bypassing the hook, so send it back to commit.
    if (pass && wt && round < cfg.maxRounds && !abort.signal.aborted && (await hasUncommitted(wt))) {
      const hook = await commitMsgHook(wt.repo)
      if (hook) {
        pass = false
        text = `The work in ${wt.branch} is not committed. Commit all of it with git commit, in a message the repository's commit-msg hook at ${hook} accepts (read the hook for its rules), and never with --no-verify.`
      }
    }
    // A new instruction (or dispose, or shutdown) superseded this run: its verdict is about an old task.
    if (this.closed || abort.signal.aborted || this.live.get(id) !== live) return
    if (live.sent || live.sending || live.track.lastPromptedSeq > turn || currentTurn(live.track)?.startSeq !== turn) return
    const final = pass || round >= cfg.maxRounds || text.startsWith("the gate could not run") || !!review?.error
    this.updateRecord(id, { gateState: { round, verdict: { turn, pass, final, text, at: Date.now(), checks, review } } })
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
    // Board writes take a file lock; serialise them so a later (higher-cost) snapshot cannot be
    // overtaken by an earlier one. A failed write does not block the next.
    const write = (live.activity?.write ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const board = await Board.open(live.record.worktree?.repo ?? live.record.directory).catch(() => undefined)
        if (!board) return false
        try {
          await board.recordActivity(task.id, task.attempt, { cost: s.cost || undefined, state: s.state, gate, model, variant })
          return true
        } catch {
          return false
        }
      })
      .then((ok) => {
        // Forget a failed snapshot so the next refresh retries it instead of short-circuiting.
        if (!ok && live.activity?.key === key) live.activity = undefined
      })
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
    const asks = live.pending.permissions.filter((p) => !live.handled.has(p.id) && p.action === "shell" && p.resources.length)
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
    if (record.interruptedSeq !== undefined || live.sent || live.sending || live.limitedTurn === turn.startSeq) return
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
    const res = await req("listing sessions", this.api.session.list({ directory, limit: 100, order: "desc" }, timed()))
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
          .map((r) => ("action" in r ? `${r.action} ${JSON.stringify(r.resources)}` : formText(r)))
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
      const queued = await req("compacting the session", this.api.session.compact({ sessionID: live.record.id }))
      // The summary is written by the model; wait for it to land (its message keeps the request's id).
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        await this.refresh(live)
        const m = live.track.messages.find((x) => x.id === queued.id)
        if (m?.type === "compaction" && m.status === "failed") throw new Error(`the compaction failed: ${m.error.message}`)
        if (m?.type === "compaction" && m.status === "completed" && !live.track.inLoop) return this.build(live)
        await sleep(250)
      }
      throw new Error("OpenCode accepted the compaction but did not finish it within 2 minutes")
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
    const conversation = () => this.conversation(sessionID)
    let messages = await conversation()
    const ids = messages.map((m) => m.id)
    // OpenCode undoes the given message and everything after it.
    let from: string
    let undone = 0
    if (opts.to) {
      const at = ids.indexOf(opts.to)
      if (at < 0) throw new Error(`no message ${opts.to} in ${name}'s conversation`)
      if (at === ids.length - 1) throw new Error(`nothing comes after ${opts.to} in ${name}'s conversation; there is nothing to revert`)
      from = ids[at + 1]!
      undone = live.track.turns.filter((t) => (t.messageIDs[0] ? ids.indexOf(t.messageIDs[0]) > at : false)).length
    } else {
      const n = opts.turns ?? 1
      const turns = live.track.turns
      if (n < 1 || n > turns.length) throw new Error(`${name} has ${turns.length} turn(s) on record; cannot revert ${n}`)
      from = turns[turns.length - n]!.messageIDs[0]!
      const at = ids.indexOf(from)
      if (at < 0) throw new Error("cannot find where that turn starts in the conversation; pass to: <message id>")
      if (!messages.slice(0, at).some((m) => m.type === "user"))
        throw new Error(`that would undo ${name}'s first turn, leaving nothing; dispose the agent (and its worktree) instead`)
      undone = n
    }
    // OpenCode records a step's file snapshot shortly after the step ends (the fields can be
    // missing altogether until then); revert only once the turns being undone have theirs, or
    // it would find no changes to restore. A session that records no snapshots (outside git)
    // is not waited for.
    const after = (ms: typeof messages) => ms.slice(ms.findIndex((m) => m.id === from))
    const snapshot = (m: SessionMessageInfo) => (m.type === "assistant" ? m.snapshot : undefined)
    const recording = (ms: typeof messages) => ms.some((m) => snapshot(m)?.start || snapshot(m)?.end)
    const pending = (ms: typeof messages) => recording(ms) && after(ms).some((m) => m.type === "assistant" && !m.snapshot?.end)
    for (let i = 0; i < 40 && pending(messages); i++) {
      await sleep(250)
      messages = await conversation()
    }
    const staged = await req("staging the revert", this.api.session.revert.stage({ sessionID, messageID: from, files: true }))
    await req("committing the revert", this.api.session.revert.commit({ sessionID }))
    await this.refresh(live)
    // The gate judged work that no longer exists, and what is left was judged before: the
    // current turn is not gated again; the agent's next turn is.
    this.updateRecord(sessionID, { gateState: this.supersededGate(live), reportedSeq: live.track.seq })
    return { snapshot: this.build(live), files: (staged.files ?? []).map((f) => ({ path: f.file, status: f.status })), turns: undone }
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
    untracked: SessionInfo[]
  }> {
    this.syncStore()
    const active = await this.activeSet().catch(() => undefined)
    const ids = [...this.live.keys()]
    const results = await Promise.allSettled(ids.map((id) => this.snapshot(id, active)))
    const snapshots: Snapshot[] = []
    const errors: string[] = []
    results.forEach((r, i) => {
      // Disposed since the ids were captured: no longer an agent to list, and not an error.
      if (this.gone.has(ids[i]!)) return
      if (r.status === "fulfilled") snapshots.push(r.value)
      else errors.push(`${ids[i]}: ${(r.reason as Error).message}`)
    })
    let untracked: SessionInfo[] = []
    if (opts.includeUntracked) {
      // OpenCode may record the real path (macOS /private/var, Windows long names): ask for both.
      const dir = this.resolveDir(opts.directory)
      const real = await fs.realpath(dir).catch(() => dir)
      const lists = await Promise.all(
        [...new Set([dir, real])].map((directory) => req("listing sessions", this.api.session.list({ directory, limit: opts.limit ?? 20, order: "desc" }))),
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
  private async messages(id: string, since?: number): Promise<SessionMessageInfo[]> {
    const out: SessionMessageInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < 200; page++) {
      // The cursor already encodes the order.
      const res = await req("loading messages", this.api.message.list({ sessionID: id, limit: 100, ...(cursor ? { cursor } : { order: "desc" }) }))
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
    const unreadableSince = new Map<string, number>()
    for (;;) {
      // One round of reads, given up at the deadline or on abort even if a request hangs.
      const round = await this.untilDeadline(
        (async () => {
          // A blip of the OpenCode server leaves the active set unknown for this round; each id is
          // then counted unreadable, so the UNREADABLE_MS window absorbs it instead of throwing.
          const active = await this.activeSet().catch(() => undefined)
          return Promise.allSettled(ids.map((id) => this.snapshot(id, active)))
        })(),
        deadline,
        opts.signal,
      )
      if (!round.done) {
        // What we knew last, as of the previous round; nothing new is marked as reported.
        return {
          snapshots: (last.length ? last : ids.flatMap((id) => (this.live.get(id) ? [this.build(this.live.get(id)!)] : []))).filter(
            (s) => !this.gone.has(s.id),
          ),
          news: new Set(),
          errors: ["the agents' status could not be read before the wait ended (the OpenCode server is not answering)"],
          timedOut: true,
          nothingToWaitFor: false,
        }
      }
      const results = round.value
      const snaps: Snapshot[] = []
      const errors: string[] = []
      results.forEach((r, i) => {
        const id = ids[i]!
        // A session disposed during the wait (its task landed or was dropped) is the normal end of
        // that task, not an error; one disposed before the wait still fails at the get above.
        if (this.gone.has(id)) {
          unreadableSince.delete(id)
          return
        }
        if (r.status === "fulfilled") {
          snaps.push(r.value)
          unreadableSince.delete(id)
        } else {
          errors.push(`${id}: ${(r.reason as Error).message}`)
          if (!unreadableSince.has(id)) unreadableSince.set(id, Date.now())
        }
      })
      // An idle agent is not done while its gate is undecided; anything needing attention still surfaces.
      const settled = snaps.filter((s) => SETTLED.has(s.state) && !(s.state === "idle" && gateUndecided(s)))
      const news = settled.filter((s) => this.hasNews(s))
      const waiting = ids.filter((id) => !this.gone.has(id))
      const allSettled = waitedOut(waiting, new Set(settled.map((s) => s.id)), unreadableSince, Date.now())
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

  private onEvent(e: OpenCodeEvent) {
    if (this.closed) return
    const raw = e as { type: string; data?: Record<string, unknown> }
    const d = raw.data ?? {}
    if (raw.type === "session.created") {
      const parentID = typeof d.parentID === "string" ? d.parentID : undefined
      const rootId = parentID ? (this.live.has(parentID) ? parentID : this.childToRoot.get(parentID)) : undefined
      const root = rootId ? this.live.get(rootId) : undefined
      if (root && typeof d.sessionID === "string") this.addChild(root, d.sessionID)
      return
    }
    // Forms carry their session inside.
    const form = d.form as { sessionID?: unknown } | undefined
    const sid = typeof d.sessionID === "string" ? d.sessionID : typeof form?.sessionID === "string" ? form.sessionID : undefined
    if (!sid) return
    const rootId = this.live.has(sid) ? sid : this.childToRoot.get(sid)
    const live = rootId ? this.live.get(rootId) : undefined
    if (!live) return
    if (sid !== rootId) live.hotChildren.set(sid, Date.now())
    switch (raw.type) {
      case "session.text.delta":
        if (sid === rootId) live.liveText = `${live.liveText}${String(d.delta ?? "")}`.slice(-400)
        return
      case "session.text.started":
      case "session.step.started":
        if (sid === rootId) {
          live.liveText = ""
          live.retry = undefined
        }
        break
      case "session.retry.scheduled": {
        const err = d.error as { message?: string } | undefined
        live.retry = { attempt: Number(d.attempt) || 1, message: err?.message ?? "provider error" }
        break
      }
      case "session.step.ended":
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
    if (
      /^session\.(inbox\.delivered|step\.(started|ended|failed)|tool\.(success|failed)|execution\.|idle$|status$|revert\.committed|compaction\.(ended|failed))|^(permission|form)\./.test(
        raw.type,
      )
    ) {
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
  private adopt(session: SessionInfo): Live {
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
    const session = await this.api.session.get({ sessionID: ref }).catch((err: unknown) => {
      throw new Error(isNotFound(err) ? `session ${ref} does not exist on this OpenCode server` : `loading session ${ref} failed: ${(err as Error).message}`)
    })
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

export type LandResult =
  | { landed: true; target: string; commits: number; checks: GateCheckSummary[]; branchKept?: string }
  | {
      landed: false
      target: string
      /**
       * message: the repository's commit-msg hook refused the message; leftovers: the worktree
       * still has uncommitted changes in a repository whose hook would judge the commit; land:
       * horde.json "workers.land" failed or its commit was refused by the repository's hooks.
       */
      why: "conflict" | "checks" | "uncommitted" | "message" | "leftovers" | "land"
      text: string
      checks?: GateCheckSummary[]
      /** why "message": the hook that refused it. */
      hook?: string
    }

interface Prepared {
  files: { uri: string; name: string }[]
  inlined: string[]
}

/** Text attachments are inlined up to this size. */
const INLINE_LIMIT = 256 * 1024
/** Never read a whole attachment into memory past this; providers reject huge parts anyway. */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/**
 * Text files are inlined (many providers reject text/plain file parts), so a text file over
 * the inline limit is refused; binary files (images, PDFs) are attached for models that accept them.
 */
async function prepareFiles(paths: string[], directory: string): Promise<Prepared> {
  const out: Prepared = { files: [], inlined: [] }
  for (const f of paths) {
    const abs = path.resolve(directory, f)
    const rel = path.relative(directory, abs) || abs
    const fh = await fs.open(abs, "r").catch(() => undefined)
    if (!fh) throw new Error(`attachment not found: ${abs}`)
    let buf: Buffer
    try {
      const st = await fh.stat()
      if (!st.isFile()) throw new Error(`attachment not found: ${abs}`)
      if (st.size > MAX_ATTACHMENT_BYTES)
        throw new Error(
          `attachment ${rel} is ${(st.size / (1024 * 1024)).toFixed(1)} MB; attachments are limited to ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`,
        )
      // Read at most the size checked above: a file growing concurrently must not allocate past the limit.
      buf = Buffer.alloc(st.size)
      let read = 0
      while (read < buf.length) {
        const { bytesRead } = await fh.read(buf, read, buf.length - read, read)
        if (!bytesRead) break
        read += bytesRead
      }
      if ((await fh.stat()).size !== st.size) throw new Error(`attachment ${rel} changed while it was being read; try again`)
      buf = buf.subarray(0, read)
    } finally {
      await fh.close()
    }
    const isText = !buf.subarray(0, 8192).includes(0)
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
