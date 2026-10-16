import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { AgentV2Info, ModelRef, ModelV2Info, PermissionV2Request, QuestionV2Request, SessionMessage, SessionV2Info, V2Event } from "@opencode-ai/sdk/v2"
import type { Backend } from "./backend.js"
import type { Config, PermissionPolicy } from "./config.js"
import { type Detail, inputSummary, oneLine, renderTranscript } from "./render.js"
import type { AgentRecord, Limits, Store } from "./state.js"
import { apply, currentTurn, type DurableEvent, emptyTrack, type Track, type Turn, turnsSince } from "./tracker.js"
import { commitAll, createWorktree, excludeFromGit, mergeWorktree, removeWorktree, type Worktree, worktreeDiff } from "./worktree.js"

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

/** A freshly prompted or quiet turn gets this long before we call it stuck. */
const GRACE_MS = 10_000
const POLL_MS = 1_000
const IDLE_REFRESH_MS = 15_000
const CHILD_SCAN_MS = 30_000

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
  worktree?: { includeUncommitted?: boolean; link?: string[]; setup?: string }
  permissions?: PermissionPolicy
  questions?: QuestionPolicy
  limits?: Limits
  files?: string[]
}

export interface Hooks {
  /** True when the client can show elicitation dialogs to the human. */
  canElicit(): boolean
  askPermission(snap: Snapshot, req: PermissionV2Request): Promise<{ reply: "once" | "always" | "reject"; message?: string } | undefined>
  askQuestion(snap: Snapshot, req: QuestionV2Request): Promise<string[][] | "dismiss" | undefined>
  /** Called once each time an agent settles (channel push). */
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
  liveText: string
  retry?: { attempt: number; message: string }
  lastRefresh: number
  lastChildScan: number
  /** Request ids we already handled automatically or are asking the human about. */
  handled: Set<string>
  /** Request ids already shown to the caller by opencode_wait. */
  reportedRequests: Set<string>
  /** Requests the human dismissed: they go to the calling model instead. */
  handedToCaller: Set<string>
  /** When the agent last went from running to settled. */
  settledAt: number
  lock: Promise<unknown>
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

/** Orchestrates OpenCode sessions ("agents") through the OpenCode v2 API. */
export class Fleet {
  private readonly live = new Map<string, Live>()
  private readonly childToRoot = new Map<string, string>()
  private readonly modelCache = new Map<string, { at: number; models: ModelV2Info[] }>()
  private readonly wakeups = new Set<() => void>()
  private monitor?: NodeJS.Timeout
  private monitoring = false

  constructor(
    private readonly backend: Backend,
    private readonly config: Config,
    private readonly store: Store,
    private readonly hooks: Hooks,
  ) {
    for (const record of store.agents(this.serverKey)) this.adoptRecord(record)
    backend.events.on("event", (e: V2Event) => this.onEvent(e))
    this.monitor = setInterval(() => void this.tick(), POLL_MS)
    this.monitor.unref()
  }

  close() {
    if (this.monitor) clearInterval(this.monitor)
  }

  private get serverKey() {
    return this.backend.info.url
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
    this.modelCache.set(dir, { at: Date.now(), models })
    return models
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

  private runningCount(): number {
    let n = 0
    for (const l of this.live.values()) if (l.state === "running" || l.state === "needs_input") n++
    return n
  }

  private checkCapacity() {
    if (this.config.maxRunning > 0 && this.runningCount() >= this.config.maxRunning) {
      const busy = [...this.live.values()].filter((l) => l.state === "running" || l.state === "needs_input").map((l) => l.record.name ?? l.record.id)
      throw new Error(
        `${busy.length} agents are already working (limit HORDE_OPENCODE_MAX_RUNNING=${this.config.maxRunning}): ${busy.join(", ")}. Wait for one with opencode_wait, or stop one.`,
      )
    }
  }

  async spawn(input: SpawnInput): Promise<{ snapshot: Snapshot; notes: string[] }> {
    this.checkCapacity()
    let directory = path.resolve(input.directory ?? this.config.directory)
    const stat = await fs.stat(directory).catch(() => undefined)
    if (!stat?.isDirectory()) throw new Error(`directory does not exist: ${directory}`)
    if (input.name) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(input.name)) throw new Error("name may only contain letters, digits, '.', '_' and '-' (max 64)")
      if (this.findByName(input.name)) throw new Error(`an agent named "${input.name}" already exists; pick another name or dispose it`)
    }
    const model = input.model ? parseModel(input.model, input.variant) : undefined
    if (!model && input.variant) throw new Error("variant requires model (pick one with opencode_models)")
    if (model) await this.validateModel(model, directory)
    if (input.agent) await this.validateAgent(input.agent, directory)
    if (input.profile && input.agent) throw new Error("pass either agent (an existing profile) or profile (a custom one), not both")

    const notes: string[] = []
    const name = input.name ?? `agent-${Date.now().toString(36)}`
    let worktree: Worktree | undefined
    if (input.isolation === "worktree") {
      const made = await createWorktree(directory, name, {
        rootDir: this.config.worktreeDir,
        includeUncommitted: input.worktree?.includeUncommitted ?? true,
        link: input.worktree?.link ?? [],
        setup: input.worktree?.setup,
      })
      worktree = made.worktree
      notes.push(...made.notes)
      directory = worktree.path
    }

    let agent = input.agent
    let agentFile: string | undefined
    try {
      if (input.profile) {
        const made = await this.writeProfile(directory, name, input.profile)
        agent = made.agent
        agentFile = made.file
      }
      const session = unwrap(
        await this.api.session.create({ location: { directory }, ...(model ? { model } : {}), ...(agent ? { agent } : {}) }),
        "creating session",
      ).data
      // v2 cannot set titles; the legacy endpoint can, and it makes agents recognisable in the TUI.
      await this.backend.client.session.update({ sessionID: session.id, directory, title: `horde: ${name}` }).catch(() => undefined)
      const policy = input.permissions ?? this.config.defaultPermissions
      const record: AgentRecord = {
        id: session.id,
        name: input.name,
        server: this.serverKey,
        directory,
        policy,
        questions: input.questions ?? defaultQuestionPolicy(policy),
        worktree,
        limits: input.limits ?? {},
        agentFile,
        createdAt: Date.now(),
        reportedSeq: 0,
      }
      this.store.put(record)
      this.adoptRecord(record)
      const preamble: string[] = []
      if (input.instructions) preamble.push(`<instructions>\n${input.instructions}\n</instructions>`)
      if (worktree) {
        preamble.push(
          `<workspace>You are working in an isolated git worktree on branch ${worktree.branch}. Commit your changes to this branch with clear messages when the task is done. Do not push, and do not switch branches.</workspace>`,
        )
      }
      const text = preamble.length ? `${preamble.join("\n\n")}\n\n${input.prompt}` : input.prompt
      await this.prompt(session.id, text, { files: input.files, directory })
      return { snapshot: await this.snapshot(session.id), notes }
    } catch (err) {
      if (agentFile) await fs.rm(agentFile, { force: true })
      if (worktree) await removeWorktree(worktree, name, true).catch(() => undefined)
      throw err
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
    } = {},
  ): Promise<Snapshot> {
    const live = this.get(ref)
    const id = live.record.id
    await this.refresh(id)
    if (live.state && SETTLED.has(live.state) && live.state !== "needs_input") this.checkCapacity()
    const session = await this.session(id)
    if (opts.model || opts.variant) {
      const current = session.model
      const model = opts.model
        ? parseModel(opts.model, opts.variant)
        : current
          ? { providerID: current.providerID, id: current.id, variant: opts.variant }
          : undefined
      if (!model) throw new Error("variant requires model: the agent has no explicit model yet")
      await this.validateModel(model, session.location.directory)
      unwrap(await this.api.session.switchModel({ sessionID: id, model }), "switching model")
    }
    if (opts.agent) {
      await this.validateAgent(opts.agent, session.location.directory)
      unwrap(await this.api.session.switchAgent({ sessionID: id, agent: opts.agent }), "switching agent")
    }
    const patch: Partial<AgentRecord> = {}
    if (opts.permissions) {
      patch.policy = opts.permissions
      if (!opts.questions) patch.questions = defaultQuestionPolicy(opts.permissions)
    }
    if (opts.questions) patch.questions = opts.questions
    if (opts.limits) patch.limits = { ...live.record.limits, ...opts.limits }
    if (Object.keys(patch).length) this.updateRecord(id, patch)
    await this.prompt(id, text, { delivery: opts.delivery, files: opts.files, directory: session.location.directory })
    return this.snapshot(id)
  }

  private async prompt(id: string, text: string, opts: { delivery?: "steer" | "queue"; files?: string[]; directory: string }) {
    // Text files are inlined: many providers reject text/plain file parts.
    // Binary files (images, PDFs) are attached for models that accept them.
    const files: { uri: string; name: string }[] = []
    const inlined: string[] = []
    for (const f of opts.files ?? []) {
      const abs = path.resolve(opts.directory, f)
      const buf = await fs.readFile(abs).catch(() => {
        throw new Error(`attachment not found: ${abs}`)
      })
      const isText = !buf.subarray(0, 8192).includes(0)
      if (isText && buf.length <= 256 * 1024) inlined.push(`<file path="${path.relative(opts.directory, abs) || abs}">\n${buf.toString("utf8")}\n</file>`)
      else files.push({ uri: pathToFileURL(abs).href, name: path.basename(abs) })
    }
    const body = inlined.length ? `${text}\n\n${inlined.join("\n\n")}` : text
    unwrap(
      await this.api.session.prompt({
        sessionID: id,
        prompt: { text: body, ...(files.length ? { files } : {}) },
        delivery: opts.delivery ?? "steer",
      }),
      "sending prompt",
    )
    this.updateRecord(id, { interruptedAt: undefined, stopReason: undefined, pauseAfterStep: undefined })
    const live = this.live.get(id)
    if (live) {
      live.state = "running"
      live.liveText = ""
    }
  }

  async interrupt(ref: string, when: "now" | "after_step" = "now", reason?: string): Promise<Snapshot> {
    const live = this.get(ref)
    const id = live.record.id
    await this.refresh(id)
    if (live.state !== "running" && live.state !== "needs_input") return this.snapshot(id)
    if (when === "after_step" && live.track.stepOpen) {
      this.updateRecord(id, { pauseAfterStep: true, stopReason: reason ?? "paused after step" })
      return this.snapshot(id)
    }
    await this.interruptNow(id, reason)
    await this.waitFor([id], "all", 5_000, { markReported: false })
    return this.snapshot(id)
  }

  private async interruptNow(id: string, reason?: string) {
    const tree = [id, ...(this.live.get(id)?.children ?? [])]
    await Promise.all(tree.map((sid) => this.api.session.interrupt({ sessionID: sid })))
    this.updateRecord(id, { interruptedAt: Date.now(), pauseAfterStep: undefined, ...(reason ? { stopReason: reason } : {}) })
  }

  async respond(ref: string, requestID: string, reply: { decision?: "once" | "always" | "reject"; message?: string; answers?: string[][] }): Promise<Snapshot> {
    const live = this.get(ref)
    const id = live.record.id
    await this.refresh(id)
    if (live.handled.has(`asking:${requestID}`)) throw new Error(`${requestID} is currently being shown to the user; their answer will be applied`)
    const perm = live.pending.permissions.find((p) => p.id === requestID)
    const question = live.pending.questions.find((q) => q.id === requestID)
    if (perm) {
      await this.replyPermission(perm, reply.decision ?? "once", reply.message)
    } else if (question) {
      if (reply.decision === "reject") await this.rejectQuestion(question)
      else if (reply.answers) await this.answerQuestion(question, reply.answers)
      else await this.dismissQuestion(question)
    } else {
      const known = [...live.pending.permissions, ...live.pending.questions].map((r) => r.id)
      throw new Error(`no pending request ${requestID} on ${live.record.name ?? id}.${known.length ? ` Pending: ${known.join(", ")}` : " Nothing is pending."}`)
    }
    live.handled.add(requestID)
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
    const live = this.get(ref)
    const id = live.record.id
    const name = live.record.name ?? id
    const notes: string[] = []
    await this.refresh(id).catch(() => undefined)
    if (live.state === "running" || live.state === "needs_input") {
      await this.interruptNow(id, "disposed")
      notes.push("interrupted the running turn")
    }
    const wt = live.record.worktree
    if (wt) {
      const mode = opts.worktree ?? "keep"
      // Let OpenCode release the directory before it disappears.
      if (mode !== "keep") await this.backend.client.instance.dispose({ directory: wt.path }).catch(() => undefined)
      if (mode === "keep") {
        const committed = await commitAll(wt, `horde: uncommitted work from ${name}`).catch(() => undefined)
        if (committed) notes.push(committed)
        notes.push(`kept worktree ${wt.root} (branch ${wt.branch})`)
      } else notes.push(await removeWorktree(wt, name, mode === "discard"))
    }
    if (live.record.agentFile) await fs.rm(live.record.agentFile, { force: true })
    if (opts.deleteSession) {
      // v2 has no delete yet; the legacy endpoint removes the session and its children.
      const res = await this.backend.client.session.delete({ sessionID: id, directory: live.session?.location.directory ?? live.record.directory })
      notes.push(res.response?.ok ? `deleted session ${id}` : `could not delete session ${id} (HTTP ${res.response?.status})`)
    } else notes.push(`the session ${id} stays in OpenCode history`)
    this.live.delete(id)
    for (const c of live.children) this.childToRoot.delete(c)
    this.store.remove(id)
    notes.push(`stopped tracking ${name}`)
    return notes.join("\n")
  }

  async worktree(ref: string, action: "diff" | "commit" | "merge", opts: { strategy?: "merge" | "squash"; maxChars?: number }): Promise<string> {
    const live = this.get(ref)
    const wt = live.record.worktree
    const name = live.record.name ?? live.record.id
    if (!wt) throw new Error(`${name} does not run in a worktree (spawn with isolation "worktree")`)
    if (action === "diff") return worktreeDiff(wt, opts.maxChars ?? 20_000)
    await this.refresh(live.record.id)
    if (live.state === "running") throw new Error(`${name} is still running; wait for it or interrupt it first`)
    if (action === "commit") return (await commitAll(wt, `horde: work from ${name}`)) ?? "nothing to commit"
    return mergeWorktree(wt, name, opts.strategy ?? "merge")
  }

  // --------------------------------------------------------------- reading

  async session(id: string): Promise<SessionV2Info> {
    return unwrap(await this.api.session.get({ sessionID: id }), `loading session ${id}`).data
  }

  private async activeSet(): Promise<Set<string>> {
    const res = unwrap(await this.api.session.active(), "listing active sessions")
    return new Set(Object.keys(res.data))
  }

  /** Refresh one agent: new history, children, pending requests, derived state, policies, limits. */
  refresh(id: string, active?: Set<string>): Promise<void> {
    const live = this.live.get(id)
    if (!live) return Promise.reject(new Error(`unknown agent ${id}`))
    const run = live.lock.then(() => this.doRefresh(live, active))
    live.lock = run.catch(() => undefined)
    return run
  }

  private async doRefresh(live: Live, activeIn?: Set<string>) {
    const id = live.record.id
    const sessionRes = await this.api.session.get({ sessionID: id })
    if (sessionRes.response?.status === 404) {
      this.live.delete(id)
      this.store.remove(id)
      throw new Error(`session ${id} does not exist on this OpenCode server (deleted, or from another server); stopped tracking it`)
    }
    live.session = unwrap(sessionRes, `loading session ${id}`).data

    // Durable history since the last seq we applied.
    for (let page = 0; page < 1000; page++) {
      const res = unwrap(await this.api.session.history({ sessionID: id, after: live.track.seq, limit: 100 }), "reading session history")
      for (const e of res.data as DurableEvent[]) apply(live.track, e)
      if (res.data.length < 100) break
    }
    live.loaded = true

    if (Date.now() - live.lastChildScan > CHILD_SCAN_MS) await this.scanChildren(live).catch(() => undefined)

    const tree = [id, ...live.children]
    const [perms, questions] = await Promise.all([
      Promise.all(tree.map(async (sid) => unwrap(await this.api.session.permission.list({ sessionID: sid }), "listing permissions").data)),
      Promise.all(tree.map(async (sid) => unwrap(await this.api.session.question.list({ sessionID: sid }), "listing questions").data)),
    ])
    live.pending = { permissions: perms.flat(), questions: questions.flat() }
    const active = activeIn ?? (await this.activeSet())
    const before = live.state
    const { state, error } = this.derive(live, active)
    live.state = state
    live.error = error
    live.lastRefresh = Date.now()

    await this.applyPolicies(live)
    if (live.state === "running") await this.enforceLimits(live)

    if (before !== undefined && !SETTLED.has(before) && SETTLED.has(live.state)) {
      live.liveText = ""
      live.settledAt = Date.now()
      // Pushes do not count as reported: if the client drops them (channels
      // not enabled), opencode_wait must still deliver the result.
      this.hooks.settled(this.build(live))
    }
  }

  private derive(live: Live, active: Set<string>): { state: AgentState; error?: string } {
    const { record, track: t } = live
    const unhandled = [...live.pending.permissions, ...live.pending.questions].filter((r) => !live.handled.has(r.id))
    if (unhandled.length) return { state: "needs_input" }
    const tree = [record.id, ...live.children]
    if (tree.some((sid) => active.has(sid))) return { state: "running" }
    const now = Date.now()
    if (record.interruptedAt && record.interruptedAt >= t.lastPromptedAt) return { state: "interrupted", error: record.stopReason }
    if (t.admitted.size) {
      const newest = Math.max(...[...t.admitted.values()].map((a) => a.at))
      if (now - newest < GRACE_MS) return { state: "running" }
      return { state: "error", error: "the prompt was accepted but the agent never started on it; check the OpenCode server log" }
    }
    const turn = currentTurn(t)
    // e.g. a rejected question: OpenCode interrupts the tool and halts the loop without ending the step.
    if (turn?.interrupted) return { state: "interrupted", error: record.stopReason ?? turn.failure }
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

  private async applyPolicies(live: Live) {
    const { record } = live
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
        live.handled.add(p.id)
        live.handled.add(`asking:${p.id}`)
        void this.hooks
          .askPermission(this.build(live), p)
          .then(async (answer) => {
            if (answer) await this.replyPermission(p, answer.reply, answer.message)
            else this.handToCaller(live, p.id)
          })
          .catch(() => live.handled.delete(p.id))
          .finally(() => {
            live.handled.delete(`asking:${p.id}`)
            this.wake()
          })
      }
    }
    for (const q of live.pending.questions) {
      if (live.handled.has(q.id) || live.handedToCaller.has(q.id)) continue
      if (record.questions === "dismiss") {
        live.handled.add(q.id)
        await this.dismissQuestion(q).catch(() => live.handled.delete(q.id))
      } else if (record.questions === "user" && this.hooks.canElicit()) {
        live.handled.add(q.id)
        live.handled.add(`asking:${q.id}`)
        void this.hooks
          .askQuestion(this.build(live), q)
          .then(async (answer) => {
            if (answer === "dismiss") await this.dismissQuestion(q)
            else if (answer) await this.answerQuestion(q, answer)
            else this.handToCaller(live, q.id)
          })
          .catch(() => live.handled.delete(q.id))
          .finally(() => {
            live.handled.delete(`asking:${q.id}`)
            this.wake()
          })
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

  private async enforceLimits(live: Live) {
    const { record, track } = live
    const turn = currentTurn(track)
    if (!turn) return
    const { maxSteps, maxCostUsd, timeoutMinutes } = record.limits
    let reason: string | undefined
    if (maxSteps && (turn.steps > maxSteps || (turn.steps >= maxSteps && !track.stepOpen))) reason = `step limit reached (${maxSteps} steps this turn)`
    else if (maxCostUsd && turn.cost >= maxCostUsd) reason = `cost limit reached ($${turn.cost.toFixed(4)} ≥ $${maxCostUsd} this turn)`
    else if (timeoutMinutes && Date.now() - turn.startedAt > timeoutMinutes * 60_000) reason = `time limit reached (${timeoutMinutes} min this turn)`
    else if (record.pauseAfterStep && !track.stepOpen) reason = record.stopReason ?? "paused after step"
    if (reason) {
      await this.interruptNow(record.id, reason)
      live.state = "interrupted"
      live.error = reason
    }
  }

  private async scanChildren(live: Live) {
    live.lastChildScan = Date.now()
    const res = unwrap(await this.api.session.list({ directory: live.record.directory, limit: 100, order: "desc" }), "listing sessions")
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
    this.childToRoot.set(child, live.record.id)
  }

  private build(live: Live): Snapshot {
    const { record, track } = live
    const session = live.session
    const state = live.state ?? "running"
    const turn = currentTurn(track)
    let activity: string | undefined
    if (state === "running") {
      const asking = [...live.pending.permissions, ...live.pending.questions].filter((r) => live.handled.has(`asking:${r.id}`))
      if (asking.length) {
        activity = `waiting for the user to answer: ${asking
          .map((r) => ("action" in r ? `${r.action} ${JSON.stringify(r.resources)}` : (r.questions[0]?.question ?? "a question")))
          .join("; ")}`
      } else if (record.pauseAfterStep) activity = "pausing after the current step"
      else if (track.openTool) activity = `${track.openTool.tool}: ${inputSummary(track.openTool.input)}`
      else if (live.liveText) activity = `writing: …${oneLine(live.liveText).slice(-160)}`
      else if (track.stepOpen) activity = "thinking"
      else activity = "starting"
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
      unreported: turnsSince(track, record.reportedSeq).filter((x) => x.endedAt !== undefined),
      lastTurn: turn,
      steps: track.totalSteps,
      cost: track.cost,
      tokens: track.tokens,
      children: [...live.children],
    }
  }

  async snapshot(ref: string, active?: Set<string>): Promise<Snapshot> {
    const live = this.get(ref)
    await this.refresh(live.record.id, active)
    return this.build(live)
  }

  async list(opts: { includeUntracked?: boolean; directory?: string; limit?: number }): Promise<Snapshot[]> {
    this.syncStore()
    if (opts.includeUntracked) {
      const res = unwrap(
        await this.api.session.list({ directory: opts.directory ?? this.config.directory, limit: opts.limit ?? 20, order: "desc" }),
        "listing sessions",
      )
      for (const s of res.data) if (!s.parentID && !this.live.has(s.id) && !this.childToRoot.has(s.id)) this.adopt(s.id)
    }
    const active = await this.activeSet()
    return Promise.all([...this.live.keys()].map((id) => this.snapshot(id, active)))
  }

  async transcript(ref: string, opts: { scope: "turn" | "all"; detail: Detail }): Promise<string> {
    const live = this.get(ref)
    await this.refresh(live.record.id)
    const since = opts.scope === "turn" ? currentTurn(live.track)?.startedAt : undefined
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
    if (s.state === "needs_input") return [...s.pending.permissions, ...s.pending.questions].some((r) => !live.reportedRequests.has(r.id))
    if (s.unreported.length > 0) return true
    // Interrupted or stuck before any turn could finish.
    return s.state !== "idle" && live.settledAt > (live.record.reportedAt ?? 0)
  }

  /** Remember what the caller has seen: pending requests, and turns that have finished. */
  private markReported(live: Live) {
    for (const r of [...live.pending.permissions, ...live.pending.questions]) live.reportedRequests.add(r.id)
    if (live.state === "needs_input") return
    const ended = live.track.turns.filter((t) => t.endedAt !== undefined)
    const seq = ended.length ? ended[ended.length - 1]!.startSeq : live.record.reportedSeq
    this.updateRecord(live.record.id, { reportedSeq: Math.max(seq, live.record.reportedSeq), reportedAt: Date.now() })
  }

  /**
   * Block until agents have news. mode "any": until one of them settled with
   * something not yet reported; "all": until every one is settled. Results are
   * marked as reported, so the next "any" wait returns the next agent.
   */
  async waitFor(
    refs: string[],
    mode: "any" | "all",
    timeoutMs: number,
    opts: { signal?: AbortSignal; onTick?: (snaps: Snapshot[], elapsedMs: number) => void; markReported?: boolean } = {},
  ): Promise<{ snapshots: Snapshot[]; news: Set<string>; timedOut: boolean; nothingToWaitFor: boolean }> {
    const ids = refs.map((r) => this.get(r).record.id)
    const start = Date.now()
    const deadline = start + timeoutMs
    for (;;) {
      const active = await this.activeSet()
      const snaps = await Promise.all(ids.map((id) => this.snapshot(id, active)))
      const settled = snaps.filter((s) => SETTLED.has(s.state))
      const news = settled.filter((s) => this.hasNews(s))
      const allSettled = settled.length === snaps.length
      const done = mode === "any" ? news.length > 0 || allSettled : allSettled
      if (done || Date.now() >= deadline || opts.signal?.aborted) {
        if (done && opts.markReported !== false) for (const s of snaps) if (SETTLED.has(s.state)) this.markReported(this.live.get(s.id)!)
        return { snapshots: snaps, news: new Set(news.map((s) => s.id)), timedOut: !done, nothingToWaitFor: done && news.length === 0 && mode === "any" }
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
      const timer = setTimeout(done, ms)
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
      const root = info?.parentID ? (this.live.has(info.parentID) ? info.parentID : this.childToRoot.get(info.parentID)) : undefined
      if (root && info?.id) this.addChild(this.live.get(root)!, info.id)
      return
    }
    const sid = typeof d.sessionID === "string" ? d.sessionID : undefined
    if (!sid) return
    const rootId = this.live.has(sid) ? sid : this.childToRoot.get(sid)
    const live = rootId ? this.live.get(rootId) : undefined
    if (!live) return
    switch (raw.type) {
      case "session.next.text.delta":
        if (sid === rootId) live.liveText = `${live.liveText}${String(d.delta ?? "")}`.slice(-400)
        return
      case "session.next.text.started":
      case "session.next.step.started":
        live.liveText = ""
        live.retry = undefined
        break
      case "session.next.retried": {
        const err = d.error as { message?: string } | undefined
        live.retry = { attempt: Number(d.attempt) || 1, message: err?.message ?? "provider error" }
        break
      }
      case "session.next.step.ended":
        live.retry = undefined
        // Pause requested: stop now, between steps, so no tool gets killed mid-run.
        if (live.record.pauseAfterStep) void this.interruptNow(live.record.id, live.record.stopReason).then(() => this.wake())
        break
    }
    if (/session\.next\.(prompted|step\.|tool\.(success|failed))|asked|replied|rejected|session\.idle|session\.status/.test(raw.type)) {
      void this.refresh(live.record.id)
        .catch(() => undefined)
        .then(() => this.wake())
    }
  }

  /** Background refresh so policies, limits and channel pushes work without a caller waiting. */
  private async tick() {
    if (this.monitoring) return
    this.monitoring = true
    try {
      const due = [...this.live.values()].filter(
        (l) => !l.loaded || l.state === undefined || !SETTLED.has(l.state) || l.state === "needs_input" || Date.now() - l.lastRefresh > IDLE_REFRESH_MS,
      )
      if (!due.length) return
      const active = await this.activeSet()
      await Promise.all(due.map((l) => this.refresh(l.record.id, active).catch(() => undefined)))
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
      liveText: "",
      lastRefresh: 0,
      lastChildScan: 0,
      handled: new Set(),
      reportedRequests: new Set(),
      handedToCaller: new Set(),
      settledAt: 0,
      lock: Promise.resolve(),
    }
    this.live.set(record.id, live)
    return live
  }

  /** Track a session this server did not spawn (e.g. from before a restart). */
  private adopt(id: string): Live {
    const policy = this.config.defaultPermissions
    const record: AgentRecord = {
      id,
      server: this.serverKey,
      directory: this.config.directory,
      policy,
      questions: defaultQuestionPolicy(policy),
      limits: {},
      createdAt: Date.now(),
      reportedSeq: Number.MAX_SAFE_INTEGER,
    }
    this.store.put(record)
    const live = this.adoptRecord(record)
    // Do not report history from before adoption as news.
    void this.refresh(id)
      .then(() => this.updateRecord(id, { reportedSeq: live.track.seq, reportedAt: Date.now() }))
      .catch(() => undefined)
    return live
  }

  /** Pick up agents another MCP process (sharing the server) created. */
  private syncStore() {
    this.store.reload()
    for (const r of this.store.agents(this.serverKey)) if (!this.live.has(r.id)) this.adoptRecord(r)
  }

  private updateRecord(id: string, patch: Partial<AgentRecord>) {
    const live = this.live.get(id)
    if (live) Object.assign(live.record, patch)
    this.store.update(id, patch)
  }

  private findByName(name: string): Live | undefined {
    for (const l of this.live.values()) if (l.record.name === name) return l
    return undefined
  }

  /** Resolve a session id or agent name. Unknown session ids are adopted. */
  get(ref: string): Live {
    let live = this.findByName(ref) ?? this.live.get(ref)
    if (!live) {
      this.syncStore()
      live = this.findByName(ref) ?? this.live.get(ref)
    }
    if (live) return live
    if (ref.startsWith("ses_")) {
      const root = this.childToRoot.get(ref)
      if (root) return this.live.get(root)!
      return this.adopt(ref)
    }
    throw new Error(`unknown agent "${ref}". Pass a session id (ses_…) or the name given at spawn; opencode_status lists them.`)
  }

  resolveId(ref: string): string {
    return this.get(ref).record.id
  }

  runningIds(): string[] {
    return [...this.live.values()].filter((l) => l.state === undefined || !SETTLED.has(l.state)).map((l) => l.record.id)
  }

  ids(): string[] {
    return [...this.live.keys()]
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
