import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { isTrustedCommand } from "@mcp-horde/board"
import { git, oneLine } from "@mcp-horde/core"
import { gate as runGate, defaultStateDir as verifyStateDir } from "@mcp-horde/verify"
import type { AgentV2Info, ModelRef, ModelV2Info, PermissionV2Request, QuestionV2Request, SessionMessage, SessionV2Info, V2Event } from "@opencode-ai/sdk/v2"
import type { Backend } from "./backend.js"
import { deleteSession, releaseDirectory, renameSession } from "./compat.js"
import type { Config, PermissionPolicy } from "./config.js"
import { type Detail, inputSummary, renderTranscript } from "./render.js"
import { type AgentRecord, type GateConfig, type Limits, ownerAlive, SELF, type Store } from "./state.js"
import { apply, type CostEstimator, costSince, currentTurn, type DurableEvent, emptyTrack, latestTool, type Track, type Turn, turnsSince } from "./tracker.js"
import { commitAll, createWorktree, excludeFromGit, mergeWorktree, removeWorktree, type Worktree, workStart, worktreeDiff } from "./worktree.js"

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
  children: string[]
  /** Present when the agent has a gate. */
  gate?: GateView
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
}

export interface SpawnInput {
  prompt: string
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
}

type Res<T> = { data?: T; error?: unknown; response?: Response }

function unwrap<T>(res: Res<T>, what: string): T {
  if (res.error !== undefined || res.data === undefined) {
    if (res.response?.ok && res.data === undefined) return undefined as T
    const e = res.error as { message?: string } | undefined
    const detail = e?.message ?? (e ? JSON.stringify(e) : `HTTP ${res.response?.status}`)
    throw new Error(`${what} failed: ${detail}`)
  }
  return res.data
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

/** Drop undefined values, so a partial update never erases other fields. */
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
    this.monitor = setInterval(() => void this.tick(), POLL_MS)
    this.monitor.unref()
  }

  /** Stop monitoring and hand our agents over: another MCP process may claim them at once. */
  close() {
    this.closed = true
    if (this.monitor) clearInterval(this.monitor)
    for (const d of this.liveDialogs()) d.abort()
    for (const l of this.live.values()) {
      try {
        this.store.update(l.record.id, { owner: undefined })
      } catch {
        // best effort
      }
    }
  }

  private *liveDialogs() {
    for (const l of this.live.values()) yield* l.dialogs.values()
  }

  private get serverKey() {
    return this.backend.info.key
  }

  private get api() {
    return this.backend.client.v2
  }

  // ---------------------------------------------------------------- catalog

  async models(directory?: string): Promise<ModelV2Info[]> {
    const dir = directory ?? this.config.directory
    const cached = this.modelCache.get(dir)
    if (cached && Date.now() - cached.at < 60_000) return cached.models
    let models: ModelV2Info[] = []
    // A directory OpenCode has not opened yet answers with an empty catalog at first.
    for (let i = 0; i < 20; i++) {
      models = unwrap(await this.api.model.list({ location: { directory: dir } }), "listing models").data
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

  async agents(directory?: string): Promise<AgentV2Info[]> {
    const dir = directory ?? this.config.directory
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
          `${busy.length + this.reserved} agents are already working or starting (limit HORDE_OPENCODE_MAX_RUNNING=${this.config.maxRunning})${busy.length ? `: ${busy.join(", ")}` : ""}. Wait for one with opencode_wait, or stop one.`,
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
      return await this.spawnReserved(input)
    } finally {
      release()
    }
  }

  private async spawnReserved(input: SpawnInput): Promise<{ snapshot: Snapshot; notes: string[] }> {
    let directory = this.resolveDir(input.directory)
    const stat = await fs.stat(directory).catch(() => undefined)
    if (!stat?.isDirectory()) throw new Error(`directory does not exist: ${directory}`)
    if (input.name) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(input.name)) throw new Error("name may only contain letters, digits, '.', '_' and '-' (max 64)")
      this.syncStore()
      const taken = this.findByName(input.name) ?? this.store.agents(this.serverKey).find((r) => r.name === input.name)
      if (taken) throw new Error(`an agent named "${input.name}" already exists; pick another name or dispose it`)
    }
    if (input.profile && input.agent) throw new Error("pass either agent (an existing profile) or profile (a custom one), not both")
    const model = input.model ? parseModel(input.model, input.variant) : undefined
    if (!model && input.variant) throw new Error("variant requires model (pick one with opencode_models)")
    if (model) await this.validateModel(model, directory)
    if (input.agent) await this.validateAgent(input.agent, directory)
    // Read attachments before anything is created, so a typo fails cleanly.
    const prepared = await prepareFiles(input.files ?? [], directory)

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
        // Re-resolve attachments relative to the worktree (they were checked in the original directory).
      }
      if (input.signal?.aborted) throw new Error("cancelled")
      let agent = input.agent
      if (input.profile) {
        const made = await this.writeProfile(directory, name, input.profile)
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
        createdAt: Date.now(),
        owner: SELF,
        reportedSeq: 0,
        gate: await gateConfig(input.gate, directory, !!worktree),
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
    // A new instruction is a new task for the gate: cancel a run in flight and start counting rounds again.
    live.gating?.abort.abort()
    await this.refresh(live)
    if (this.config.maxRunning > 0) await this.refreshUnknown()
    // Waking a settled agent takes a running slot.
    const waking = !!live.state && SETTLED.has(live.state) && live.state !== "needs_input"
    const release = waking ? this.reserve() : () => undefined
    try {
      // After an interrupt OpenCode may still be winding the old loop down; a
      // steer sent now would be parked in that loop instead of starting a turn.
      if (waking) await this.untilInactive(live)
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
        unwrap(await this.api.session.switchModel({ sessionID: id, model }), "switching model")
      }
      if (opts.agent) {
        await this.validateAgent(opts.agent, directory)
        unwrap(await this.api.session.switchAgent({ sessionID: id, agent: opts.agent }), "switching agent")
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
      if (Object.keys(patch).length) this.updateRecord(id, patch)
      await this.sendPrompt(live, text, prepared, opts.delivery)
    } finally {
      release()
    }
    return this.snapshot(id)
  }

  private async sendPrompt(live: Live, text: string, prepared: Prepared, delivery?: "steer" | "queue") {
    const body = prepared.inlined.length ? `${text}\n\n${prepared.inlined.join("\n\n")}` : text
    unwrap(
      await this.api.session.prompt({
        sessionID: live.record.id,
        prompt: { text: body, ...(prepared.files.length ? { files: prepared.files } : {}) },
        delivery: delivery ?? "steer",
      }),
      "sending prompt",
    )
    // Any refresh that started before this point must not publish its (now stale) state.
    live.gen++
    live.state = "running"
    live.liveText = ""
    live.sent = { at: Date.now(), seq: live.track.seq }
    this.updateRecord(live.record.id, { interruptedSeq: undefined, stopReason: undefined, pauseAfterStep: undefined })
  }

  async interrupt(ref: string, when: "now" | "after_step" = "now", reason?: string): Promise<Snapshot> {
    const live = await this.get(ref)
    const id = live.record.id
    // Stopping an agent stops its checks too; the gate is decided (cancelled) so it does not start again.
    if (live.gating) {
      const turn = live.gating.turn
      live.gating.abort.abort()
      live.gating = undefined
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
    await Promise.all(tree.map((sid) => this.api.session.interrupt({ sessionID: sid }).catch(() => undefined)))
    this.updateRecord(live.record.id, { interruptedSeq: live.track.seq, pauseAfterStep: undefined, stopReason: reason })
    live.sent = undefined
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
    unwrap(
      await this.api.session.permission.reply({ sessionID: p.sessionID, requestID: p.id, reply, ...(message ? { message } : {}) }),
      "replying to permission",
    )
  }

  private async answerQuestion(q: QuestionV2Request, answers: string[][]) {
    unwrap(await this.api.session.question.reply({ sessionID: q.sessionID, requestID: q.id, questionV2Reply: { answers } }), "answering question")
  }

  /** Rejecting a question halts the agent in OpenCode, so "dismiss" answers it instead. */
  private async dismissQuestion(q: QuestionV2Request) {
    await this.answerQuestion(
      q,
      q.questions.map(() => ["No preference: use your best judgment and continue."]),
    )
  }

  private async rejectQuestion(q: QuestionV2Request) {
    unwrap(await this.api.session.question.reject({ sessionID: q.sessionID, requestID: q.id }), "rejecting question")
  }

  async dispose(ref: string, opts: { worktree?: "keep" | "remove" | "discard"; deleteSession?: boolean }): Promise<string> {
    const live = await this.get(ref)
    const id = live.record.id
    const name = live.record.name ?? id
    const notes: string[] = []
    live.gating?.abort.abort()
    await this.refresh(live).catch(() => undefined)
    if (live.state === "running" || live.state === "needs_input") {
      await this.interruptNow(live, "disposed")
      notes.push("interrupted the running turn")
    }
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

  async worktree(ref: string, action: "diff" | "commit" | "merge", opts: { strategy?: "merge" | "squash"; maxChars?: number }): Promise<string> {
    const live = await this.get(ref)
    const wt = live.record.worktree
    const name = live.record.name ?? live.record.id
    if (!wt) throw new Error(`${name} does not run in a worktree (spawn with isolation "worktree")`)
    if (action === "diff") return worktreeDiff(wt, opts.maxChars ?? 20_000)
    await this.refresh(live)
    if (this.working(live) && live.state !== "needs_input") throw new Error(`${name} is still running; wait for it or interrupt it first`)
    if (action === "commit") return (await commitAll(wt, `horde: work from ${name}`)) ?? "nothing to commit"
    const result = await mergeWorktree(wt, name, opts.strategy ?? "merge")
    if (result.merged && result.merged !== wt.merged) this.updateRecord(live.record.id, { worktree: { ...wt, merged: result.merged } })
    return result.text
  }

  // --------------------------------------------------------------- reading

  async session(id: string): Promise<SessionV2Info> {
    return unwrap(await this.api.session.get({ sessionID: id }), `loading session ${id}`).data
  }

  private async untilInactive(live: Live, timeoutMs = 10_000) {
    const tree = [live.record.id, ...live.hotChildren.keys()]
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const active = await this.activeSet().catch(() => undefined)
      if (!active || !tree.some((sid) => active.has(sid))) return
      await sleep(100)
    }
  }

  private async activeSet(): Promise<Set<string>> {
    const res = unwrap(await this.api.session.active(), "listing active sessions")
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
    const sessionRes = await this.api.session.get({ sessionID: id })
    if (sessionRes.response?.status === 404) {
      this.forget(id)
      throw new Error(`session ${id} no longer exists on the OpenCode server (deleted?); stopped tracking it`)
    }
    live.session = unwrap(sessionRes, `loading session ${id}`).data

    // Durable history since the last seq we applied.
    const replaying = !live.loaded
    const turnsBefore = live.track.turns.length ? currentTurn(live.track)!.startSeq : -1
    await this.readHistory(id, live.track, live.session.location.directory)
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
      Promise.all(tree.map(async (sid) => unwrap(await this.api.session.permission.list({ sessionID: sid }), "listing permissions").data)),
      Promise.all(tree.map(async (sid) => unwrap(await this.api.session.question.list({ sessionID: sid }), "listing questions").data)),
    ])
    live.pending = { permissions: perms.flat(), questions: questions.flat() }
    this.pruneRequestSets(live)
    await this.approveTrusted(live)

    if (live.record.pauseAfterStep && !live.track.inLoop) this.updateRecord(id, { pauseAfterStep: undefined })
    // Interrupting before the loop picked up the prompt is a no-op in OpenCode, so
    // the turn may start afterwards: stop it again once it does.
    const marker = live.record.interruptedSeq
    const cur = currentTurn(live.track)
    if (marker !== undefined && cur && live.track.inLoop && cur.startSeq > marker && cur.admittedSeq <= marker && live.gen === gen) {
      await Promise.all([id, ...live.hotChildren.keys()].map((sid) => this.api.session.interrupt({ sessionID: sid }).catch(() => undefined)))
    }
    live.lastRefresh = Date.now()
    // A prompt was sent while we were reading: our view predates it.
    if (live.gen !== gen) return

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
      const res = unwrap(await this.api.session.history({ sessionID, after: track.seq, limit: 100 }), "reading session history")
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
    if (v && turn && v.turn === turn.startSeq) return { ...view, state: v.final ? (v.pass ? "pass" : "fail") : "retrying" }
    if (this.gateTurn(live)) return { ...view, state: "pending" }
    if (v && !v.final) return { ...view, state: "retrying" }
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
    if (!turn || live.gating || live.sent) return
    const gs = live.record.gateState ?? { round: 0 }
    if (gs.verdict?.turn === turn.startSeq) return
    const abort = new AbortController()
    live.gating = { turn: turn.startSeq, abort }
    void this.runGateFor(live, turn.startSeq, abort).finally(() => {
      if (live.gating?.abort === abort) live.gating = undefined
      this.wake()
      void this.refresh(live).catch(() => undefined)
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
    // A new instruction (or dispose) superseded this run: its verdict is about an old task.
    if (abort.signal.aborted || !this.live.has(id)) return
    if (live.sent || live.track.lastPromptedSeq > turn || currentTurn(live.track)?.startSeq !== turn) return
    const final = pass || round >= cfg.maxRounds || text.startsWith("the gate could not run")
    this.updateRecord(id, { gateState: { round, verdict: { turn, pass, final, text, at: Date.now() } } })
    if (!final) {
      await this.sendPrompt(live, gateFeedback(round, cfg.maxRounds, text), { files: [], inlined: [] }).catch((err: Error) => {
        // The agent could not be told: report the failure instead of waiting forever.
        this.updateRecord(id, {
          gateState: {
            round,
            verdict: { turn, pass, final: true, text: `${text}\n(could not send the failure back to the agent: ${err.message})`, at: Date.now() },
          },
        })
      })
    }
  }

  /** Push once per distinct settled outcome (and per new request). */
  private maybePush(live: Live) {
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
      const newest = Math.max(...[...t.admitted.values()].map((a) => a.at))
      if (now - newest < (t.totalSteps ? START_GRACE_MS : FIRST_START_GRACE_MS)) return { state: "running" }
      return { state: "error", error: "the prompt was accepted but the agent never started on it; check the OpenCode server log" }
    }
    const turn = currentTurn(t)
    // e.g. a rejected question: OpenCode interrupts the tool and halts the loop.
    if (turn?.interrupted) return { state: "interrupted", error: turn.failure }
    if (t.inLoop) {
      if (now - t.lastEventAt < GRACE_MS) return { state: "running" }
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
   * plumbing: approve exactly those, whatever the agent's policy, so reporting
   * never waits on a human. Anything else, including a board command with a
   * chained shell command, goes through the normal policy.
   */
  private async approveTrusted(live: Live) {
    for (const p of live.pending.permissions) {
      if (live.handled.has(p.id) || p.action !== "bash" || !p.resources.length || !p.resources.every((r) => isTrustedCommand(r))) continue
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
    const res = unwrap(await this.api.session.list({ directory, limit: 100, order: "desc" }), "listing sessions")
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
      children: [...live.children],
      gate: this.gateView(live),
    }
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
    for (;;) {
      const active = await this.activeSet()
      const results = await Promise.allSettled(ids.map((id) => this.snapshot(id, active)))
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
        return { snapshots: snaps, news: new Set(news.map((s) => s.id)), errors, timedOut, nothingToWaitFor: done && news.length === 0 && mode === "any" }
      }
      opts.onTick?.(snaps, Date.now() - start)
      await this.sleepUntilWoken(Math.min(this.backend.streaming ? 2_000 : 1_000, deadline - Date.now()), opts.signal)
    }
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
      const now = Date.now()
      const due = [...this.live.values()].filter((l) => {
        if (!l.loaded || this.working(l)) return true
        const recent = now - l.track.lastEventAt < 60 * 60_000
        return now - l.lastRefresh > (recent ? SETTLED_REFRESH_MS : DORMANT_REFRESH_MS)
      })
      if (!due.length) return
      const active = await this.activeSet()
      await Promise.all(due.map((l) => this.refresh(l, active).catch(() => undefined)))
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
      reportedSeq: 0,
      adoptPending: true,
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
  private syncStore() {
    const records = this.store.agents(this.serverKey)
    const ids = new Set(records.map((r) => r.id))
    for (const id of [...this.live.keys()]) if (!ids.has(id)) this.dropLive(id)
    for (const r of records) {
      if (this.live.has(r.id) || this.gone.has(r.id)) continue
      if (r.owner?.token !== SELF.token && ownerAlive(r.owner)) continue // another MCP session drives it
      const claimed = { ...r, owner: SELF }
      this.store.put(claimed)
      this.adoptRecord(claimed)
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
    this.syncStore()
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

/**
 * Text files are inlined (many providers reject text/plain file parts);
 * binary files (images, PDFs) are attached for models that accept them.
 */
async function prepareFiles(paths: string[], directory: string): Promise<Prepared> {
  const out: Prepared = { files: [], inlined: [] }
  for (const f of paths) {
    const abs = path.resolve(directory, f)
    const buf = await fs.readFile(abs).catch(() => {
      throw new Error(`attachment not found: ${abs}`)
    })
    const isText = !buf.subarray(0, 8192).includes(0)
    if (isText && buf.length <= 256 * 1024) out.inlined.push(`<file path="${path.relative(directory, abs) || abs}">\n${buf.toString("utf8")}\n</file>`)
    else out.files.push({ uri: pathToFileURL(abs).href, name: path.basename(abs) })
  }
  return out
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
