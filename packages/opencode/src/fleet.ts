import fs from "node:fs/promises"
import path from "node:path"
import type {
  ModelRef,
  ModelV2Info,
  AgentV2Info,
  PermissionV2Request,
  QuestionV2Request,
  SessionMessage,
  SessionV2Info,
  V2Event,
} from "@opencode-ai/sdk/v2"
import type { Backend } from "./backend.js"
import type { Config, PermissionPolicy } from "./config.js"
import { assistantText, currentActivity, renderTranscript, type Detail } from "./render.js"
import { createWorktree, removeWorktree, type Worktree } from "./worktree.js"

/**
 * running      – the agent loop is executing (or about to start on a fresh prompt)
 * needs_input  – blocked on a permission or question only the orchestrator can answer
 * idle         – finished its last turn successfully and is waiting for a new message
 * interrupted  – stopped by opencode_interrupt; resume with opencode_resume/opencode_message
 * error        – the last turn ended with an error
 */
export type AgentState = "running" | "needs_input" | "idle" | "interrupted" | "error"

export const SETTLED: ReadonlySet<AgentState> = new Set(["needs_input", "idle", "interrupted", "error"])

/** A freshly prompted session can take a moment before it shows up as active. */
const START_GRACE_MS = 15_000
const POLL_MS = 2_000

interface AgentMeta {
  id: string
  name?: string
  policy: PermissionPolicy
  worktree?: Worktree
  lastPromptAt: number
  interruptedAt?: number
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
  activity?: string
  error?: string
  permissions: PermissionV2Request[]
  questions: QuestionV2Request[]
  /** Messages since the latest user prompt, oldest first. */
  turn: SessionMessage[]
  updated: number
}

export interface SpawnInput {
  prompt: string
  name?: string
  model?: string
  variant?: string
  agent?: string
  directory?: string
  isolation?: "none" | "worktree"
  permissions?: PermissionPolicy
  files?: string[]
}

type Res<T> = { data?: T; error?: unknown; response?: Response }

function unwrap<T>(res: Res<T>, what: string): T {
  if (res.error !== undefined || res.data === undefined) {
    if (res.response && res.response.ok && res.data === undefined) return undefined as T
    const e = res.error as { message?: string; _tag?: string } | undefined
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

/** Orchestrates OpenCode sessions ("agents") through the OpenCode v2 API. */
export class Fleet {
  private readonly meta = new Map<string, AgentMeta>()
  private modelCache?: { at: number; directory: string; models: ModelV2Info[] }

  constructor(
    private readonly backend: Backend,
    private readonly config: Config,
  ) {
    backend.events.on("event", (e: V2Event) => void this.onEvent(e))
  }

  private get api() {
    return this.backend.client.v2
  }

  // ---------------------------------------------------------------- catalog

  async models(directory?: string): Promise<ModelV2Info[]> {
    const dir = directory ?? this.config.directory
    if (this.modelCache && this.modelCache.directory === dir && Date.now() - this.modelCache.at < 60_000) {
      return this.modelCache.models
    }
    const res = unwrap(await this.api.model.list({ location: { directory: dir } }), "listing models")
    this.modelCache = { at: Date.now(), directory: dir, models: res.data }
    return res.data
  }

  async agents(directory?: string): Promise<AgentV2Info[]> {
    const res = unwrap(await this.api.agent.list({ location: { directory: directory ?? this.config.directory } }), "listing agents")
    return res.data
  }

  private async validateModel(ref: ModelRef, directory: string) {
    const models = await this.models(directory)
    const found = models.find((m) => m.providerID === ref.providerID && m.id === ref.id)
    if (!found) {
      const needle = ref.id.toLowerCase()
      const close = models
        .filter((m) => m.providerID === ref.providerID || m.id.toLowerCase().includes(needle) || needle.includes(m.id.toLowerCase()))
        .slice(0, 10)
        .map((m) => `${m.providerID}/${m.id}`)
      throw new Error(
        `Unknown model "${ref.providerID}/${ref.id}".${close.length ? ` Did you mean: ${close.join(", ")}?` : ""} Use opencode_models to list available models.`,
      )
    }
    if (ref.variant && ref.variant !== "default" && !found.variants.some((v) => v.id === ref.variant)) {
      const names = found.variants.map((v) => v.id)
      throw new Error(
        `Model ${ref.providerID}/${ref.id} has no variant "${ref.variant}". ${names.length ? `Available: ${names.join(", ")}` : "It has no variants."}`,
      )
    }
  }

  // ------------------------------------------------------------ lifecycle

  async spawn(input: SpawnInput): Promise<Snapshot> {
    let directory = path.resolve(input.directory ?? this.config.directory)
    const stat = await fs.stat(directory).catch(() => undefined)
    if (!stat?.isDirectory()) throw new Error(`directory does not exist: ${directory}`)
    if (input.name && this.findByName(input.name)) throw new Error(`an agent named "${input.name}" already exists`)

    const model = input.model ? parseModel(input.model, input.variant) : undefined
    if (!model && input.variant) throw new Error("variant requires a model")
    if (model) await this.validateModel(model, directory)

    let worktree: Worktree | undefined
    if (input.isolation === "worktree") {
      worktree = await createWorktree(directory, input.name ?? `agent-${Date.now().toString(36)}`)
      directory = worktree.path
    }

    const session = unwrap(
      await this.api.session.create({
        location: { directory },
        ...(model ? { model } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
      }),
      "creating session",
    ).data
    this.meta.set(session.id, {
      id: session.id,
      name: input.name,
      policy: input.permissions ?? this.config.defaultPermissions,
      worktree,
      lastPromptAt: Date.now(),
    })
    await this.prompt(session.id, input.prompt, { files: input.files, directory })
    return this.snapshot(session.id)
  }

  async message(
    ref: string,
    text: string,
    opts: { delivery?: "steer" | "queue"; model?: string; variant?: string; agent?: string; files?: string[] } = {},
  ): Promise<Snapshot> {
    const id = this.resolve(ref)
    const session = await this.session(id)
    if (opts.model || opts.variant) {
      const current = session.model
      const model = opts.model
        ? parseModel(opts.model, opts.variant)
        : current
          ? { providerID: current.providerID, id: current.id, variant: opts.variant }
          : undefined
      if (!model) throw new Error("variant requires a model (the session has no explicit model yet)")
      await this.validateModel(model, session.location.directory)
      unwrap(await this.api.session.switchModel({ sessionID: id, model }), "switching model")
    }
    if (opts.agent) unwrap(await this.api.session.switchAgent({ sessionID: id, agent: opts.agent }), "switching agent")
    await this.prompt(id, text, { delivery: opts.delivery, files: opts.files, directory: session.location.directory })
    return this.snapshot(id)
  }

  private async prompt(id: string, text: string, opts: { delivery?: "steer" | "queue"; files?: string[]; directory: string }) {
    const files = opts.files?.map((f) => {
      const abs = path.resolve(opts.directory, f)
      return { uri: `file://${abs}`, name: path.basename(abs) }
    })
    unwrap(
      await this.api.session.prompt({
        sessionID: id,
        prompt: { text, ...(files?.length ? { files } : {}) },
        delivery: opts.delivery ?? "steer",
      }),
      "sending prompt",
    )
    const meta = this.ensureMeta(id)
    meta.lastPromptAt = Date.now()
    meta.interruptedAt = undefined
  }

  async interrupt(ref: string): Promise<Snapshot> {
    const id = this.resolve(ref)
    unwrap(await this.api.session.interrupt({ sessionID: id }), "interrupting session")
    this.ensureMeta(id).interruptedAt = Date.now()
    // Give the runner a moment to settle so the snapshot reflects the stop.
    await this.waitFor([id], "all", 5_000)
    return this.snapshot(id)
  }

  async resume(ref: string, text?: string): Promise<Snapshot> {
    return this.message(
      ref,
      text ?? "You were interrupted. Continue the task from where you left off.",
    )
  }

  async respond(
    ref: string,
    requestID: string,
    reply: { decision?: "once" | "always" | "reject"; message?: string; answers?: string[][] },
  ): Promise<Snapshot> {
    const id = this.resolve(ref)
    const [perms, questions] = await Promise.all([this.permissions(id), this.questions(id)])
    if (perms.some((p) => p.id === requestID)) {
      const decision = reply.decision ?? "once"
      unwrap(
        await this.api.session.permission.reply({
          sessionID: id,
          requestID,
          reply: decision,
          ...(reply.message ? { message: reply.message } : {}),
        }),
        "replying to permission",
      )
    } else if (questions.some((q) => q.id === requestID)) {
      if (reply.decision === "reject" || !reply.answers) {
        unwrap(await this.api.session.question.reject({ sessionID: id, requestID }), "rejecting question")
      } else {
        unwrap(
          await this.api.session.question.reply({ sessionID: id, requestID, questionV2Reply: { answers: reply.answers } }),
          "answering question",
        )
      }
    } else {
      throw new Error(`no pending permission or question ${requestID} on agent ${id}`)
    }
    return this.snapshot(id)
  }

  async dispose(ref: string, opts: { removeWorktree?: boolean; force?: boolean }): Promise<string> {
    const id = this.resolve(ref)
    const notes: string[] = []
    const snap = await this.snapshot(id)
    if (snap.state === "running" || snap.state === "needs_input") {
      unwrap(await this.api.session.interrupt({ sessionID: id }), "interrupting session")
      notes.push("interrupted the running turn")
    }
    const meta = this.meta.get(id)
    if (meta?.worktree) {
      if (opts.removeWorktree) notes.push(await removeWorktree(meta.worktree, !!opts.force))
      else notes.push(`kept worktree ${meta.worktree.path} (branch ${meta.worktree.branch})`)
    }
    this.meta.delete(id)
    notes.push(`stopped tracking ${id}; the session stays in OpenCode history`)
    return notes.join("\n")
  }

  // --------------------------------------------------------------- reading

  async session(id: string): Promise<SessionV2Info> {
    return unwrap(await this.api.session.get({ sessionID: id }), `loading session ${id}`).data
  }

  private async permissions(id: string): Promise<PermissionV2Request[]> {
    return unwrap(await this.api.session.permission.list({ sessionID: id }), "listing permissions").data
  }

  private async questions(id: string): Promise<QuestionV2Request[]> {
    return unwrap(await this.api.session.question.list({ sessionID: id }), "listing questions").data
  }

  private async active(): Promise<Set<string>> {
    const res = unwrap(await this.api.session.active(), "listing active sessions")
    return new Set(Object.keys(res.data))
  }

  /** Messages from the latest user prompt onwards (or the last `limit` if none). */
  private async recentMessages(id: string, limit = 50): Promise<SessionMessage[]> {
    const res = unwrap(await this.api.session.messages({ sessionID: id, order: "desc", limit }), "loading messages")
    const desc = res.data
    const userIdx = desc.findIndex((m) => m.type === "user")
    const slice = userIdx === -1 ? desc : desc.slice(0, userIdx + 1)
    return slice.reverse()
  }

  async allMessages(id: string): Promise<SessionMessage[]> {
    const out: SessionMessage[] = []
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      const res = unwrap(
        // The cursor already encodes the order; the API rejects both together.
        await this.api.session.messages({ sessionID: id, limit: 200, ...(cursor ? { cursor } : { order: "asc" }) }),
        "loading messages",
      )
      out.push(...res.data)
      if (!res.cursor.next || res.data.length < 200) break
      cursor = res.cursor.next
    }
    return out
  }

  async snapshot(ref: string, active?: Set<string>): Promise<Snapshot> {
    const id = this.resolve(ref)
    const meta = this.ensureMeta(id)
    const [session, perms, questions, turn, act] = await Promise.all([
      this.session(id),
      this.permissions(id),
      this.questions(id),
      this.recentMessages(id),
      active ? Promise.resolve(active) : this.active(),
    ])
    let permissions = perms
    if (meta.policy !== "ask" && perms.length) {
      // Catch requests that arrived while we were not listening to events.
      await Promise.all(perms.map((p) => this.autoReply(p, meta.policy)))
      permissions = []
    }

    const last = turn[turn.length - 1]
    const lastAssistant = [...turn].reverse().find((m) => m.type === "assistant")
    const error = lastAssistant?.type === "assistant" ? lastAssistant.error?.message : undefined
    let state: AgentState
    if (permissions.length || questions.length) state = "needs_input"
    else if (act.has(id)) state = "running"
    else if (last?.type === "user" && Date.now() - meta.lastPromptAt < START_GRACE_MS && !meta.interruptedAt) state = "running"
    else if (meta.interruptedAt || (error && /interrupt|abort/i.test(error))) state = "interrupted"
    else if (error) state = "error"
    else state = "idle"

    return {
      id,
      name: meta.name,
      title: session.title,
      state,
      directory: session.location.directory,
      agent: session.agent ?? (lastAssistant?.type === "assistant" ? lastAssistant.agent : undefined),
      model: session.model ?? (lastAssistant?.type === "assistant" ? lastAssistant.model : undefined),
      worktree: meta.worktree,
      policy: meta.policy,
      activity: state === "running" ? currentActivity(turn) : undefined,
      error: state === "error" || state === "interrupted" ? error : undefined,
      permissions,
      questions,
      turn,
      updated: session.time.updated,
    }
  }

  /** Snapshots for tracked agents plus, optionally, other sessions in a directory. */
  async list(opts: { includeUntracked?: boolean; directory?: string; limit?: number }): Promise<Snapshot[]> {
    const ids = new Set(this.meta.keys())
    if (opts.includeUntracked) {
      const res = unwrap(
        await this.api.session.list({ directory: opts.directory ?? this.config.directory, limit: opts.limit ?? 20, order: "desc" }),
        "listing sessions",
      )
      for (const s of res.data) ids.add(s.id)
    }
    const active = await this.active()
    return Promise.all([...ids].map((id) => this.snapshot(id, active)))
  }

  async transcript(ref: string, opts: { scope: "turn" | "all"; detail: Detail }): Promise<string> {
    const id = this.resolve(ref)
    const messages = opts.scope === "all" ? await this.allMessages(id) : await this.recentMessages(id, 200)
    return renderTranscript(messages, opts.detail)
  }

  // --------------------------------------------------------------- waiting

  /**
   * Block until agents settle. mode "any" returns as soon as one of them is
   * settled, "all" when every one is. Wakes on server events and also polls,
   * so a dropped event stream only costs latency.
   */
  async waitFor(
    refs: string[],
    mode: "any" | "all",
    timeoutMs: number,
    opts: { signal?: AbortSignal; onTick?: (snaps: Snapshot[], elapsedMs: number) => void } = {},
  ): Promise<{ snapshots: Snapshot[]; timedOut: boolean }> {
    const ids = refs.map((r) => this.resolve(r))
    const start = Date.now()
    const deadline = start + timeoutMs
    for (;;) {
      const active = await this.active()
      const snaps = await Promise.all(ids.map((id) => this.snapshot(id, active)))
      const settled = snaps.filter((s) => SETTLED.has(s.state)).length
      if ((mode === "any" && settled > 0) || (mode === "all" && settled === snaps.length)) {
        return { snapshots: snaps, timedOut: false }
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0 || opts.signal?.aborted) return { snapshots: snaps, timedOut: true }
      opts.onTick?.(snaps, Date.now() - start)
      await this.nextEvent(new Set(ids), Math.min(POLL_MS, remaining), opts.signal)
    }
  }

  private nextEvent(ids: Set<string>, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.backend.events.off("event", onEvent)
        signal?.removeEventListener("abort", done)
        resolve()
      }
      const onEvent = (e: V2Event) => {
        const sid = eventSession(e)
        if (sid && ids.has(sid) && /step\.(ended|failed)|asked|idle|status|interrupt/.test(e.type)) done()
      }
      const timer = setTimeout(done, timeoutMs)
      this.backend.events.on("event", onEvent)
      signal?.addEventListener("abort", done)
    })
  }

  // ---------------------------------------------------------------- events

  private async onEvent(e: V2Event) {
    if (e.type !== "permission.v2.asked") return
    const meta = this.meta.get(e.data.sessionID)
    if (!meta || meta.policy === "ask") return
    await this.autoReply(e.data, meta.policy).catch(() => undefined)
  }

  private async autoReply(p: PermissionV2Request, policy: PermissionPolicy) {
    await this.api.session.permission.reply({
      sessionID: p.sessionID,
      requestID: p.id,
      reply: policy === "allow" ? "once" : "reject",
      ...(policy === "deny" ? { message: "Denied by the orchestrator's permission policy. Find another way or explain what you need." } : {}),
    })
  }

  // --------------------------------------------------------------- helpers

  tracked(): string[] {
    return [...this.meta.keys()]
  }

  private findByName(name: string): AgentMeta | undefined {
    for (const m of this.meta.values()) if (m.name === name) return m
    return undefined
  }

  /** Accept a session id or an agent name. Unknown ids are adopted (e.g. after a restart). */
  resolve(ref: string): string {
    const byName = this.findByName(ref)
    if (byName) return byName.id
    if (ref.startsWith("ses_")) return ref
    throw new Error(`unknown agent "${ref}". Pass a session id (ses_…) or the name given at spawn.`)
  }

  private ensureMeta(id: string): AgentMeta {
    let meta = this.meta.get(id)
    if (!meta) {
      meta = { id, policy: this.config.defaultPermissions, lastPromptAt: 0 }
      this.meta.set(id, meta)
    }
    return meta
  }

  setPolicy(ref: string, policy: PermissionPolicy) {
    this.ensureMeta(this.resolve(ref)).policy = policy
  }

  lastText(snap: Snapshot): string | undefined {
    const last = [...snap.turn].reverse().find((m) => m.type === "assistant" && assistantText(m))
    return last?.type === "assistant" ? assistantText(last) : undefined
  }
}

function eventSession(e: V2Event): string | undefined {
  const raw = e as { data?: { sessionID?: unknown }; properties?: { sessionID?: unknown } }
  const holder = raw.data ?? raw.properties
  return typeof holder?.sessionID === "string" ? holder.sessionID : undefined
}
