import { type ChildProcess, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import path from "node:path"
import { killTree, loadTiers } from "@mcp-horde/core"
import type {
  ModelInfo,
  ModelRef,
  SessionInboxInfo,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageIdle,
  SessionMessageInfo,
  SessionMessageUser,
} from "@opencode/client"
import { type Backend, serverEnv, workerEnvironment } from "./backend.js"
import type { Config } from "./config.js"
import type { CreateSessionInput, MessageOptions, MessagePage, PromptOptions, Runtime, RuntimeCapabilities, RuntimeStatus } from "./runtime.js"

/** One turn's process and the OpenCode-shaped records it produces. */
interface Turn {
  assistant: SessionMessageAssistant
  tools: Map<string, SessionMessageAssistantTool>
  parts: SessionMessageAssistant["content"]
  textOrdinal: number
  /** Text from the CLI's assistant events, to avoid repeating the result's copy of it. */
  text: string
  usage?: SessionMessageAssistant["tokens"]
  isError: boolean
  resultText: string
  spawnError?: string
  finished: boolean
  /** A completed tool closed the current assistant message: the next content opens a new one. */
  split: boolean
}

interface Queued {
  id: string
  text: string
  at: number
}

interface Session {
  /** The id the fleet knows this session by. The CLI's own id is `cursorID`. */
  id: string
  cursorID?: string
  directory: string
  title: string
  model?: ModelRef
  /** The model id passed to `--model` (without the runtime prefix). */
  modelID?: string
  askMode: boolean
  env?: Record<string, string>
  writableDirs?: string[]
  createdAt: number
  updatedAt: number
  seq: number
  messages: SessionMessageInfo[]
  queue: Queued[]
  proc?: ChildProcess
  running: boolean
  interrupted: boolean
  removed: boolean
  lastOutcome?: "succeeded" | "failed" | "interrupted"
  lastError?: string
}

const isWindows = process.platform === "win32"

/**
 * Cursor's agent CLI behind the runtime seam.
 *
 * One process per turn, in print mode with JSONL (`stream-json`). The fleet still sees
 * OpenCode's messages, parts and events; this file maps one onto the other. The first turn
 * starts a Cursor chat, later turns continue it with `--resume <session_id>`.
 */
export class CursorRuntime implements Runtime {
  readonly kind = "cursor" as const
  readonly capabilities: RuntimeCapabilities = {
    midTurnSteering: false,
    permissionPrompts: false,
    revert: false,
    compact: false,
    scopeRules: false,
  }
  readonly events = new EventEmitter()
  private readonly chats = new Map<string, Session>()
  private readonly bin: string
  private readonly baseEnv: Record<string, string>

  constructor(backend: Backend, config?: Config) {
    this.bin = config?.cursorBin ?? process.env.HORDE_CURSOR_BIN ?? "cursor-agent"
    const worker = backend.info.workerEnv ?? workerEnvironment(serverEnv({ username: "cursor" }))
    this.baseEnv = { ...worker }
    // Cursor's CLI needs its login (HOME, inherited from the allowlist). A provider key reaches
    // the child only through the allowlist's HORDE_OPENCODE_PASS_ENV opt-in, like any other.
    if (!this.baseEnv.HOME && process.env.HOME) this.baseEnv.HOME = process.env.HOME
    if (!this.baseEnv.PATH && process.env.PATH) this.baseEnv.PATH = process.env.PATH
  }

  async models(directory?: string): Promise<ModelInfo[]> {
    const ids = new Set<string>()
    try {
      for (const tier of loadTiers(directory ?? process.cwd())) {
        const named = /^cursor\/(.+)$/.exec(tier.model)
        if (named) ids.add(named[1]!)
      }
    } catch {
      // A malformed horde.json is reported where it is read; the catalog still has its defaults.
    }
    ids.add("auto")
    return [...ids].map((id) => ({
      id,
      modelID: id,
      providerID: "cursor",
      name: id,
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      variants: [],
      time: { released: 0 },
      cost: [],
      status: "active" as const,
      enabled: true,
      limit: { context: 0, output: 0 },
    }))
  }

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    const id = this.newID("ses")
    const now = Date.now()
    const model = input.model
    const session: Session = {
      id,
      directory: input.directory,
      title: input.title,
      model,
      modelID: model?.id,
      // The ask path runs read-only (with every tool denied, or with the deny policy): Cursor's
      // ask mode keeps it to answering.
      askMode: input.permissions === "deny" || !!input.rules?.some((r) => r.action === "*" && r.resource === "*" && r.effect === "deny"),
      ...(input.env ? { env: input.env } : {}),
      ...(input.writableDirs?.length ? { writableDirs: input.writableDirs } : {}),
      createdAt: now,
      updatedAt: now,
      seq: now,
      messages: [],
      queue: [],
      running: false,
      interrupted: false,
      removed: false,
    }
    this.chats.set(id, session)
    this.emit("session.created", {
      sessionID: id,
      projectID: input.directory,
      location: { directory: input.directory },
      slug: id,
      title: input.title,
      ...(model ? { model } : {}),
      version: "cursor",
    })
    return this.info(session)
  }

  async prompt(id: string, text: string, opts: PromptOptions = {}): Promise<{ id: string }> {
    const session = this.require(id)
    const userID = this.newID("msg")
    const body = opts.files?.length ? `${text}\n\n${opts.files.map((f) => `<file uri="${f.uri}"${f.name ? ` name="${f.name}"` : ""} />`).join("\n")}` : text
    const queued = { id: userID, text: body, at: Date.now() }
    // No mid-turn steering: a prompt sent while the process runs starts the next --resume turn.
    if (session.proc) session.queue.push(queued)
    else this.start(session, queued)
    return { id: userID }
  }

  async messages(id: string, opts: MessageOptions = {}): Promise<MessagePage> {
    const session = this.require(id)
    if (opts.messageID) {
      const message = session.messages.find((m) => m.id === opts.messageID)
      return { messages: message ? [message] : [] }
    }
    let start = opts.cursor ? Number(opts.cursor) : 0
    if (!Number.isInteger(start) || start < 0) start = 0
    const limit = opts.limit ?? 100
    const all = opts.order === "desc" ? [...session.messages].reverse() : session.messages
    const page = all.slice(start, start + limit)
    const next = start + page.length
    return { messages: page, ...(next < all.length ? { cursor: String(next) } : {}) }
  }

  async inbox(id: string): Promise<SessionInboxInfo[]> {
    const session = this.require(id)
    return session.queue.map((q) => ({
      id: q.id,
      sessionID: session.id,
      time: { created: q.at },
      type: "user" as const,
      payload: { text: q.text },
      delivery: "queue" as const,
    }))
  }

  async status(id: string, active?: Set<string>): Promise<RuntimeStatus> {
    const session = this.require(id)
    // The process state is authoritative; a caller's stale active set must not hide it.
    const running = active ?? (await this.active())
    if (session.running) return { state: "running", session: this.info(session), active: running }
    if (session.lastOutcome === "failed")
      return { state: "error", error: session.lastError ?? "the last turn failed", session: this.info(session), active: running }
    return { state: "idle", session: this.info(session), active: running }
  }

  async session(id: string): Promise<SessionInfo> {
    return this.info(this.require(id))
  }

  async active(): Promise<Set<string>> {
    return new Set([...this.chats.values()].filter((s) => s.running).map((s) => s.id))
  }

  async sessions(directory: string, opts: { limit?: number; order?: "asc" | "desc" } = {}): Promise<SessionInfo[]> {
    const list = [...this.chats.values()]
      .filter((s) => !s.removed && path.resolve(s.directory) === path.resolve(directory))
      .sort((a, b) => (opts.order === "asc" ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt))
    return list.slice(0, opts.limit ?? 100).map((s) => this.info(s))
  }

  async interrupt(id: string): Promise<void> {
    const session = this.chats.get(id)
    if (!session) return
    session.interrupted = true
    const proc = session.proc
    if (!proc?.pid) return
    killTree(proc.pid, true)
    const timer = setTimeout(() => {
      if (session.proc === proc && proc.pid) killTree(proc.pid, true, "SIGKILL")
    }, 5_000)
    timer.unref()
  }

  /**
   * Dispose a session: kill its turn, drop everything still queued (a dropped worker must not
   * start another turn), and keep the transcript readable.
   */
  async dispose(id: string): Promise<void> {
    const session = this.chats.get(id)
    if (!session) return
    session.removed = true
    session.queue = []
    await this.interrupt(id)
  }

  async setEnvironment(id: string, env: Record<string, string>): Promise<void> {
    const session = this.require(id)
    session.env = { ...session.env, ...env }
    session.updatedAt = Date.now()
  }

  async remove(id: string): Promise<void> {
    const session = this.chats.get(id)
    if (!session) return
    session.removed = true
    session.queue = []
    const proc = session.proc
    if (proc?.pid) {
      killTree(proc.pid, true)
      const timer = setTimeout(() => {
        if (session.proc === proc && proc.pid) killTree(proc.pid, true, "SIGKILL")
      }, 5_000)
      timer.unref()
    }
    this.chats.delete(id)
  }

  // --------------------------------------------------------------- the process

  private start(session: Session, prompt: Queued) {
    const now = this.stamp(session)
    const user: SessionMessageUser = { id: prompt.id, time: { created: now }, text: prompt.text, type: "user" }
    const assistant = this.newAssistant(session, now)
    const turn: Turn = {
      assistant,
      tools: new Map(),
      parts: assistant.content,
      textOrdinal: 0,
      text: "",
      isError: false,
      resultText: "",
      finished: false,
      split: false,
    }
    session.messages.push(user, assistant)
    session.running = true
    session.interrupted = false
    session.lastOutcome = undefined
    session.lastError = undefined
    session.updatedAt = now
    this.emit("session.execution.started", { sessionID: session.id })

    const args = ["-p", "--output-format", "stream-json", "--sandbox", "enabled", "--workspace", session.directory, "--trust"]
    for (const dir of session.writableDirs ?? []) args.push("--add-dir", dir)
    // --force auto-approves every tool, and ask mode is read-only only without it: the real CLI
    // still writes files in ask mode when forced (probed 2026-11-01).
    if (session.askMode) args.push("--mode", "ask")
    else args.push("--force")
    if (session.modelID) args.push("--model", session.modelID)
    if (session.cursorID) args.push("--resume", session.cursorID)

    let proc: ChildProcess
    try {
      proc = spawn(this.bin, args, {
        cwd: session.directory,
        env: this.environment(session),
        stdio: ["pipe", "pipe", "pipe"],
        detached: !isWindows,
        windowsHide: true,
      })
    } catch (err) {
      turn.spawnError = (err as Error).message
      this.finish(session, turn, undefined)
      return
    }
    session.proc = proc
    const stderr = { text: "" }
    let pending = ""
    // The prompt goes through stdin: a large prompt cannot hit argv's E2BIG, and a prompt that
    // starts with "-" is not parsed as an option.
    proc.stdin?.on("error", (err) => {
      if (turn.finished) return
      if ((err as NodeJS.ErrnoException).code !== "EPIPE") turn.spawnError = err.message
    })
    proc.stdin?.end(prompt.text)
    proc.stdout?.setEncoding("utf8")
    proc.stdout?.on("data", (chunk: string) => {
      if (turn.finished) return
      const lines = (pending + chunk).split("\n")
      pending = lines.pop() ?? ""
      for (const line of lines) this.ingest(session, turn, line)
    })
    proc.stderr?.setEncoding("utf8")
    proc.stderr?.on("data", (chunk: string) => {
      stderr.text = (stderr.text + chunk).slice(-8000)
    })
    proc.once("error", (err) => {
      turn.spawnError = err.message
      this.finish(session, turn, undefined, stderr.text)
    })
    // Finish when the pipes close (every line has been read), or two seconds after exit when a
    // grandchild that inherited stdout keeps them open: the turn must not wait for it.
    let ended = false
    const end = (code: number | null, signal: NodeJS.Signals | null) => {
      if (ended) return
      ended = true
      if (pending) this.ingest(session, turn, pending)
      this.finish(session, turn, code, stderr.text, signal ?? undefined)
      proc.stdout?.destroy()
      proc.stderr?.destroy()
    }
    proc.once("close", (code, signal) => end(code, signal))
    proc.once("exit", (code, signal) => {
      const grace = setTimeout(() => end(code, signal), 2_000)
      grace.unref()
    })
  }

  private newAssistant(session: Session, at: number): SessionMessageAssistant {
    return {
      id: this.newID("msg"),
      time: { created: at },
      type: "assistant",
      agent: "cursor",
      model: this.modelRef(session),
      content: [],
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
      finish: "stop",
    }
  }

  /** The current step: opens a new assistant message after a completed tool closed the last. */
  private step(session: Session, turn: Turn): SessionMessageAssistant {
    if (!turn.split) return turn.assistant
    turn.split = false
    const at = this.stamp(session)
    const assistant = this.newAssistant(session, at)
    session.messages.push(assistant)
    session.updatedAt = at
    turn.assistant = assistant
    turn.parts = assistant.content
    return assistant
  }

  /** Close the step after a completed tool, so the tracker counts it while the turn still runs. */
  private closeStep(session: Session, turn: Turn) {
    if (turn.split) return
    const at = this.stamp(session)
    turn.assistant.time.completed = at
    turn.assistant.finish = "tool-calls"
    turn.split = true
  }

  private finish(session: Session, turn: Turn, code: number | null | undefined, stderr?: string, signal?: string) {
    if (turn.finished) return
    turn.finished = true
    const interrupted = session.interrupted
    const failure =
      turn.spawnError ??
      (interrupted
        ? undefined
        : turn.isError
          ? turn.resultText || "cursor-agent reported an error"
          : signal
            ? `cursor-agent was killed by ${signal}`
            : code !== undefined && code !== 0
              ? turn.resultText || stderr?.trim() || `cursor-agent exited with code ${code}`
              : undefined)
    const outcome: "succeeded" | "failed" | "interrupted" = interrupted ? "interrupted" : failure ? "failed" : "succeeded"
    const at = this.stamp(session)
    // The turn's usage and cost belong to its last assistant message.
    turn.assistant.time.completed = at
    turn.assistant.finish = outcome === "failed" ? "error" : "stop"
    turn.assistant.tokens = turn.usage ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    turn.assistant.cost = 0
    // A tool still marked running was cut off with the process.
    for (const part of turn.tools.values()) {
      if (part.state.status !== "running" && part.state.status !== "streaming") continue
      part.state = {
        status: "error",
        input: part.state.status === "running" ? part.state.input : {},
        error: { type: "cursor", message: interrupted ? "interrupted" : "the turn ended before the tool finished" },
      }
      part.time.completed = at
    }
    const idle: SessionMessageIdle = {
      id: this.newID("msg"),
      time: { created: at },
      type: "idle",
      outcome,
      ...(failure ? { error: { type: "cursor", message: failure } } : {}),
    }
    session.messages.push(idle)
    session.lastOutcome = outcome
    session.lastError = failure
    session.running = false
    session.proc = undefined
    session.updatedAt = at
    this.emit(outcome === "succeeded" ? "session.execution.succeeded" : outcome === "failed" ? "session.execution.failed" : "session.execution.interrupted", {
      sessionID: session.id,
      ...(failure ? { error: { type: "cursor", message: failure } } : outcome === "interrupted" ? { reason: "user" } : {}),
    })
    this.emit("session.idle", { sessionID: session.id })
    if (session.removed || !session.queue.length) return
    const next = session.queue.shift()!
    this.start(session, next)
  }

  private ingest(session: Session, turn: Turn, line: string) {
    if (turn.finished) return
    const text = line.trim()
    if (!text) return
    let raw: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(text)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return
      raw = parsed as Record<string, unknown>
    } catch {
      return
    }
    const type = typeof raw.type === "string" ? raw.type : ""
    if (type === "system" && raw.subtype === "init") {
      if (typeof raw.session_id === "string" && raw.session_id) session.cursorID = raw.session_id
      if (typeof raw.model === "string" && raw.model && !session.modelID) session.modelID = raw.model
      return
    }
    if (type === "assistant") {
      const message = record(raw.message)
      const content = Array.isArray(message?.content) ? message.content : []
      for (const part of content) {
        const p = record(part)
        if (p?.type !== "text" || typeof p.text !== "string" || !p.text) continue
        this.addText(session, turn, p.text)
      }
      return
    }
    if (type === "tool_call") {
      this.toolCall(session, turn, raw)
      return
    }
    if (type === "result") {
      const usage = record(raw.usage)
      turn.usage = {
        input: number(usage?.inputTokens),
        output: number(usage?.outputTokens),
        reasoning: 0,
        cache: { read: number(usage?.cacheReadTokens), write: number(usage?.cacheWriteTokens) },
      }
      turn.isError = raw.is_error === true || raw.subtype === "error"
      const result = typeof raw.result === "string" ? raw.result : ""
      if (result.trim()) {
        turn.resultText = result
        if (result.trim() !== turn.text.trim()) this.addText(session, turn, result)
      }
    }
  }

  private addText(session: Session, turn: Turn, text: string) {
    if (!text) return
    // Only a repeat of the whole answer is a duplicate; a chunk that repeats a tail is real text.
    if (turn.text && text === turn.text) return
    this.step(session, turn)
    turn.text += text
    turn.parts.push({ type: "text", text })
    const ordinal = turn.textOrdinal++
    this.emit("session.text.started", { sessionID: session.id, assistantMessageID: turn.assistant.id, ordinal })
    this.emit("session.text.delta", { sessionID: session.id, assistantMessageID: turn.assistant.id, ordinal, delta: text })
  }

  private toolCall(session: Session, turn: Turn, raw: Record<string, unknown>) {
    const call = record(raw.tool_call)
    const shell = record(call?.shellToolCall)
    const edit = record(call?.editToolCall)
    if (!shell && !edit) return
    const id = typeof raw.call_id === "string" ? raw.call_id : this.newID("call")
    const name = shell ? "bash" : "edit"
    const args = record(shell?.args) ?? record(edit?.args) ?? {}
    const input: Record<string, string> = {}
    if (shell && typeof args.command === "string") input.command = args.command
    if (edit && typeof args.path === "string") input.path = args.path
    const started = raw.subtype !== "completed"
    const at = Date.now()
    let part = turn.tools.get(id)
    if (!part) {
      this.step(session, turn)
      part = {
        type: "tool",
        id,
        name,
        state: { status: "running", input, metadata: {} },
        time: { created: at, ran: at },
      }
      turn.tools.set(id, part)
      turn.parts.push(part)
      this.emit("session.step.started", {
        sessionID: session.id,
        assistantMessageID: turn.assistant.id,
        agent: "cursor",
        model: this.modelRef(session),
        started: at,
      })
    }
    if (started) return
    const result = shell?.result ?? edit?.result
    part.state = {
      status: "completed",
      input,
      content: [{ type: "text", text: outputText(result) }],
    }
    part.time.completed = at
    this.emit("session.step.ended", {
      sessionID: session.id,
      assistantMessageID: turn.assistant.id,
      finish: "tool-calls",
      cost: 0,
      tokens: turn.usage ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    this.closeStep(session, turn)
  }

  /** The allowlisted worker environment plus the session's own variables (paths such as HOME stay). */
  private environment(session: Session): Record<string, string> {
    return { ...this.baseEnv, ...session.env }
  }

  // --------------------------------------------------------------- records

  private info(session: Session): SessionInfo {
    const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    let cost = 0
    for (const message of session.messages) {
      if (message.type !== "assistant") continue
      cost += message.cost ?? 0
      tokens.input += message.tokens?.input ?? 0
      tokens.output += message.tokens?.output ?? 0
      tokens.reasoning += message.tokens?.reasoning ?? 0
      tokens.cache.read += message.tokens?.cache.read ?? 0
      tokens.cache.write += message.tokens?.cache.write ?? 0
    }
    return {
      id: session.id,
      projectID: session.directory,
      ...(session.model ? { model: session.model } : {}),
      agent: "cursor",
      cost,
      tokens,
      ...(session.lastOutcome ? { outcome: session.lastOutcome } : {}),
      time: {
        created: session.createdAt,
        updated: session.updatedAt,
        ...(session.running ? {} : { idle: session.updatedAt }),
      },
      title: session.title,
      location: { directory: session.directory },
    }
  }

  private modelRef(session: Session): ModelRef {
    return session.model ?? { providerID: "cursor", id: session.modelID ?? "auto" }
  }

  private require(id: string): Session {
    const session = this.chats.get(id)
    if (!session) throw new Error(`session ${id} does not exist on the cursor runtime`)
    return session
  }

  private stamp(session: Session): number {
    session.seq = Math.max(Date.now(), session.seq + 1)
    return session.seq
  }

  private newID(prefix: string): string {
    return `${prefix}_cursor${randomBytes(8).toString("hex")}`
  }

  private emit(type: string, data: Record<string, unknown>) {
    this.events.emit("event", { type, data })
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/** A tool's output as one string: the CLI's shape varies by tool and version. */
function outputText(result: unknown): string {
  if (typeof result === "string") return result
  const r = record(result)
  if (!r) return result === undefined || result === null ? "" : JSON.stringify(result)
  for (const key of ["stdout", "output", "text", "message"]) {
    if (typeof r[key] === "string" && r[key]) return r[key]
  }
  if (typeof r.stderr === "string" && r.stderr.trim()) return r.stderr
  return JSON.stringify(result)
}
