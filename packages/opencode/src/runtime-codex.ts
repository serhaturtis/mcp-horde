import { type ChildProcess, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { loadTiers } from "@mcp-horde/core"
import type {
  JsonValue,
  ModelInfo,
  ModelRef,
  SessionInboxInfo,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageInfo,
  ToolContent,
} from "@opencode/client"
import type { Backend } from "./backend.js"
import { loadPrices, type Price } from "./config.js"
import type { CreateSessionInput, MessageOptions, MessagePage, PromptOptions, Runtime, RuntimeCapabilities, RuntimeStatus } from "./runtime.js"

/** One JSONL record from `codex exec --json`. */
interface CodexEvent {
  type?: string
  thread_id?: string
  item?: CodexItem
  usage?: CodexUsage
  message?: string
  error?: { message?: string } | string
}

interface CodexItem {
  id?: string
  type?: string
  text?: string
  command?: string
  aggregated_output?: string
  exit_code?: number
  status?: string
  changes?: { path?: string; kind?: string }[]
  name?: string
  arguments?: unknown
  result?: unknown
  [key: string]: unknown
}

interface CodexUsage {
  input_tokens?: number
  cached_input_tokens?: number
  cache_write_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
}

interface TurnState {
  assistant: SessionMessageAssistant
  interrupted: boolean
  failure?: string
  usage?: CodexUsage
  completed: boolean
  /** A completed tool closed the current assistant message: the next content opens a new one. */
  split: boolean
  /** Item id -> the part it produced (across every assistant message in the turn). */
  parts: Map<string, SessionMessageAssistant["content"][number]>
}

interface Queued {
  id: string
  text: string
  at: number
}

interface CodexSession {
  /** The id the fleet stores: a provisional one until the first `thread.started` gives the thread id. */
  id: string
  threadId?: string
  directory: string
  title: string
  model?: ModelRef
  readOnly: boolean
  rules: CreateSessionInput["rules"]
  env?: Record<string, string>
  writableDirs?: string[]
  createdAt: number
  updatedAt: number
  messages: SessionMessageInfo[]
  turns: TurnState[]
  queue: Queued[]
  proc?: ChildProcess
  running: boolean
  interrupted: boolean
  removed: boolean
  /** A note for the next turn: its thread was rejected and it starts a fresh conversation. */
  freshThreadNote?: string
  error?: string
  outcome?: "succeeded" | "failed" | "interrupted"
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  cost: number
}

const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
/** The reasoning efforts Codex accepts in `model_reasoning_effort`. */
const REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"])

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

function messageText(e: CodexEvent): string | undefined {
  if (typeof e.message === "string") return e.message
  if (typeof e.error === "string") return e.error
  return e.error?.message
}

/**
 * The Codex implementation: one `codex exec` process per turn, translated into the OpenCode
 * shapes the fleet already reads. The thread id is Codex's session id; the fleet's provisional
 * id keeps addressing it after the first `thread.started`.
 */
export class CodexRuntime implements Runtime {
  readonly kind = "codex" as const
  readonly capabilities: RuntimeCapabilities = {
    midTurnSteering: false,
    permissionPrompts: false,
    revert: false,
    compact: false,
    scopeRules: false,
  }
  readonly events = new EventEmitter()
  private readonly byID = new Map<string, CodexSession>()
  private clock = 0
  private counter = 0

  constructor(
    private readonly backend: Backend,
    private readonly bin: string,
  ) {
    this.events.setMaxListeners(0)
  }

  /** A monotonically increasing creation time, so messages stay ordered within one clock tick. */
  private now(): number {
    this.clock = Math.max(Date.now(), this.clock + 1)
    return this.clock
  }

  private messageID(): string {
    return `cdx_${++this.counter}`
  }

  private get(sessionID: string): CodexSession {
    const session = this.byID.get(sessionID)
    if (!session) throw new Error(`unknown codex session ${sessionID}`)
    return session
  }

  async models(directory?: string): Promise<ModelInfo[]> {
    const ids: string[] = []
    try {
      for (const tier of loadTiers(directory ?? process.cwd())) {
        const named = /^codex\/(.+)$/.exec(tier.model)
        if (named && !ids.includes(named[1]!)) ids.push(named[1]!)
      }
    } catch {
      // A malformed horde.json is reported where it is read; the catalog still has its defaults.
    }
    for (const id of ["gpt-5.3-codex", "gpt-5.1-codex", "gpt-5-codex"]) if (!ids.includes(id)) ids.push(id)
    return ids.map((id) => ({
      id,
      modelID: id,
      providerID: "codex",
      name: id,
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      variants: [],
      time: { released: 0 },
      cost: [],
      status: "active" as const,
      enabled: true,
      limit: { context: 200_000, output: 32_000 },
    }))
  }

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    const id = `codex-${randomBytes(4).toString("hex")}`
    const now = this.now()
    const model = input.model && input.variant && !input.model.variant ? { ...input.model, variant: input.variant } : input.model
    const session: CodexSession = {
      id,
      directory: input.directory,
      title: input.title,
      ...(model ? { model } : {}),
      readOnly: input.permissions === "deny",
      rules: input.rules,
      ...(input.env ? { env: input.env } : {}),
      ...(input.writableDirs?.length ? { writableDirs: input.writableDirs } : {}),
      createdAt: now,
      updatedAt: now,
      messages: [],
      turns: [],
      queue: [],
      running: false,
      interrupted: false,
      removed: false,
      tokens: { ...ZERO_TOKENS },
      cost: 0,
    }
    this.byID.set(id, session)
    this.emit("session.created", { sessionID: id, title: input.title, model: this.modelRef(session) })
    return this.sessionInfo(session)
  }

  async prompt(id: string, text: string, _opts: PromptOptions = {}): Promise<{ id: string }> {
    const session = this.get(id)
    const messageID = this.messageID()
    const at = this.now()
    session.queue.push({ id: messageID, text, at })
    session.updatedAt = at
    if (!session.running) this.startNext(session)
    return { id: messageID }
  }

  async messages(id: string, opts: MessageOptions = {}): Promise<MessagePage> {
    const session = this.get(id)
    if (opts.messageID) {
      const message = session.messages.find((m) => m.id === opts.messageID)
      return { messages: message ? [message] : [] }
    }
    // The cursor records its direction, so a descending read continues toward older messages.
    let desc = opts.order === "desc"
    let at: string | undefined = opts.after
    if (opts.cursor?.startsWith("desc:")) {
      desc = true
      at = opts.cursor.slice(5)
    } else if (opts.cursor?.startsWith("asc:")) {
      desc = false
      at = opts.cursor.slice(4)
    } else if (opts.cursor) at = opts.cursor
    let list = session.messages
    if (at) {
      const found = list.findIndex((m) => m.id === at)
      list = found < 0 ? [] : desc ? list.slice(0, found) : list.slice(found + 1)
    }
    if (desc) list = [...list].reverse()
    const limit = opts.limit ?? 100
    const messages = list.slice(0, limit)
    const last = messages[messages.length - 1]
    return { messages, ...(last ? { cursor: `${desc ? "desc" : "asc"}:${last.id}` } : {}) }
  }

  async inbox(id: string): Promise<SessionInboxInfo[]> {
    const session = this.get(id)
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
    const session = this.get(id)
    // The process state is authoritative; a caller's stale active set must not hide it.
    const running = active ?? (await this.active())
    if (session.running) return { state: "running", session: this.sessionInfo(session), active: running }
    if (session.outcome === "failed")
      return { state: "error", error: session.error ?? "the last turn failed", session: this.sessionInfo(session), active: running }
    return { state: "idle", session: this.sessionInfo(session), active: running }
  }

  async session(id: string): Promise<SessionInfo> {
    return this.sessionInfo(this.get(id))
  }

  async active(): Promise<Set<string>> {
    return new Set([...this.byID.values()].filter((s) => s.running).map((s) => s.id))
  }

  async sessions(directory: string, opts: { limit?: number; order?: "asc" | "desc" } = {}): Promise<SessionInfo[]> {
    const list = [...this.byID.values()]
      .filter((s) => s.directory === directory)
      .sort((a, b) => (opts.order === "asc" ? a.createdAt - b.createdAt : b.createdAt - a.createdAt))
      .slice(0, opts.limit ?? 100)
    return list.map((s) => this.sessionInfo(s))
  }

  /** Kill the turn's process group: SIGTERM now, SIGKILL after 5 s if it is still there. */
  async interrupt(id: string): Promise<void> {
    const session = this.byID.get(id)
    if (!session) return
    const turn = session.turns[session.turns.length - 1]
    if (turn && !turn.completed) turn.interrupted = true
    session.interrupted = true
    // Keep the queue: a tell sent behind the running turn starts once the killed turn closes.
    const proc = session.proc
    if (!proc?.pid || proc.exitCode !== null || proc.signalCode !== null) return
    this.signal(proc, "SIGTERM")
    const timer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) this.signal(proc, "SIGKILL")
    }, 5_000)
    timer.unref()
  }

  /** Forget a session. The thread stays on disk: it is the user's Codex history, not ours to delete. */
  async remove(id: string): Promise<void> {
    const session = this.byID.get(id)
    if (!session) return
    session.removed = true
    session.queue = []
    this.byID.delete(id)
    const proc = session.proc
    if (!proc?.pid) return
    this.signal(proc, "SIGTERM")
    const timer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) this.signal(proc, "SIGKILL")
    }, 5_000)
    timer.unref()
  }

  /**
   * Dispose a session: kill its turn, drop everything still queued (a dropped worker must not
   * start another turn), and keep the transcript readable.
   */
  async dispose(id: string): Promise<void> {
    const session = this.byID.get(id)
    if (!session) return
    session.removed = true
    session.queue = []
    await this.interrupt(id)
  }

  async switchModel(id: string, model: ModelRef): Promise<void> {
    const session = this.get(id)
    session.model = model
    session.updatedAt = this.now()
  }

  async setEnvironment(id: string, env: Record<string, string>): Promise<void> {
    const session = this.get(id)
    session.env = { ...session.env, ...env }
    session.updatedAt = this.now()
  }

  private modelRef(session: CodexSession): ModelRef {
    return session.model
      ? { providerID: "codex", id: session.model.id, ...(session.model.variant ? { variant: session.model.variant } : {}) }
      : { providerID: "codex", id: "default" }
  }

  private sessionInfo(session: CodexSession): SessionInfo {
    return {
      id: session.id,
      projectID: "codex",
      agent: "codex",
      ...(session.model ? { model: this.modelRef(session) } : {}),
      cost: session.cost,
      tokens: {
        input: session.tokens.input,
        output: session.tokens.output,
        reasoning: session.tokens.reasoning,
        cache: { read: session.tokens.cacheRead, write: session.tokens.cacheWrite },
      },
      ...(session.outcome ? { outcome: session.outcome } : {}),
      time: { created: session.createdAt, updated: session.updatedAt, ...(session.running ? {} : { idle: session.updatedAt }) },
      title: session.title,
      location: { directory: session.directory },
      ...(session.rules ? { permissions: session.rules } : {}),
    }
  }

  /** Start the next queued prompt in its own `codex exec` (first turn) or `codex exec resume`. */
  private startNext(session: CodexSession) {
    if (session.removed) {
      session.running = false
      return
    }
    const next = session.queue.shift()
    if (!next) {
      session.running = false
      return
    }
    const first = session.turns.length === 0
    const at = this.now()
    const user: SessionMessageInfo = { id: next.id, type: "user", time: { created: at }, text: next.text }
    const assistant = this.newAssistant(session)
    const turn: TurnState = { assistant, interrupted: false, completed: false, split: false, parts: new Map() }
    session.messages.push(user, assistant)
    session.turns.push(turn)
    session.running = true
    session.updatedAt = at
    session.outcome = undefined
    session.error = undefined
    session.interrupted = false
    // `session.created` belongs to createSession: a later turn is not a new session.
    if (session.freshThreadNote) {
      const note = session.freshThreadNote
      session.freshThreadNote = undefined
      this.note(session, turn, "thread", note)
    } else if (!first && !session.threadId) {
      // The first turn ended before Codex reported a thread id; starting over would lose the history silently.
      this.fail(session, turn, "cannot resume the Codex thread: the previous turn ended before Codex reported a thread id")
      session.freshThreadNote = "the previous Codex turn ended before it reported a thread id; this turn started a new conversation"
      this.finish(session, turn, undefined)
      return
    }
    if (session.model?.variant && !REASONING_EFFORTS.has(session.model.variant)) {
      this.note(session, turn, "variant", `Codex does not accept the model variant "${session.model.variant}"; using the default reasoning effort`)
    }
    this.run(session, turn, next.text)
  }

  private newAssistant(session: CodexSession): SessionMessageAssistant {
    return {
      id: this.messageID(),
      type: "assistant",
      agent: "codex",
      model: this.modelRef(session),
      time: { created: this.now() },
      content: [],
    }
  }

  /** The current step: opens a new assistant message after a completed tool closed the last. */
  private step(session: CodexSession, turn: TurnState): SessionMessageAssistant {
    if (!turn.split) return turn.assistant
    turn.split = false
    const assistant = this.newAssistant(session)
    session.messages.push(assistant)
    session.updatedAt = assistant.time.created
    turn.assistant = assistant
    return assistant
  }

  /** Close the step after a completed tool, so the tracker counts it while the turn still runs. */
  private closeStep(turn: TurnState) {
    if (turn.split) return
    turn.assistant.time = { ...turn.assistant.time, completed: this.now() }
    turn.assistant.finish = "tool-calls"
    turn.split = true
  }

  private run(session: CodexSession, turn: TurnState, text: string) {
    const args = this.args(session)
    let proc: ChildProcess
    try {
      proc = spawn(this.bin, args, {
        cwd: session.directory,
        env: this.environment(session),
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      })
    } catch (err) {
      this.fail(session, turn, (err as Error).message)
      this.finish(session, turn, undefined)
      return
    }
    session.proc = proc
    let out = ""
    let err = ""
    // Codex reads the instructions from stdin when no prompt argument is given: this avoids
    // argv's E2BIG limit and keeps a prompt that starts with "-" from being parsed as an option.
    proc.stdin?.on("error", (e) => {
      if (turn.completed) return
      if ((e as NodeJS.ErrnoException).code !== "EPIPE") this.fail(session, turn, e.message)
    })
    proc.stdin?.end(text)
    proc.stdout?.setEncoding("utf8")
    proc.stderr?.setEncoding("utf8")
    proc.stdout?.on("data", (chunk: string) => {
      out += chunk
      for (;;) {
        const nl = out.indexOf("\n")
        if (nl < 0) break
        const line = out.slice(0, nl).trim()
        out = out.slice(nl + 1)
        if (!line) continue
        try {
          this.record(session, turn, line)
        } catch (e) {
          // A malformed protocol line may fail this turn, but never escapes the stream handler.
          this.fail(session, turn, `codex sent a malformed event: ${(e as Error).message}`)
        }
      }
    })
    proc.stderr?.on("data", (chunk: string) => {
      err = `${err}${chunk}`.slice(-8_000)
    })
    proc.once("error", (e) => {
      this.fail(session, turn, e.message)
      // A spawn failure may not emit "exit" (e.g. ENOENT): close the turn here; finish is idempotent.
      this.finish(session, turn, undefined)
    })
    // Finish when the pipes close (every line has been read), or two seconds after exit when a
    // grandchild that inherited stdout keeps them open: the turn must not wait for it.
    let ended = false
    const end = (code: number | null, signal: NodeJS.Signals | null) => {
      if (ended) return
      ended = true
      if (out.trim()) {
        try {
          this.record(session, turn, out.trim())
        } catch (e) {
          this.fail(session, turn, `codex sent a malformed event: ${(e as Error).message}`)
        }
      }
      if (!turn.interrupted && !turn.failure && code !== 0) {
        const reason = err.trim() || (signal ? `codex was killed by ${signal}` : `codex exited with code ${code}`)
        this.fail(session, turn, reason)
      }
      this.finish(session, turn, code)
      proc.stdout?.destroy()
      proc.stderr?.destroy()
    }
    proc.once("close", (code, signal) => end(code, signal))
    proc.once("exit", (code, signal) => {
      const grace = setTimeout(() => end(code, signal), 2_000)
      grace.unref()
    })
  }

  private args(session: CodexSession): string[] {
    const sandbox = session.readOnly ? "read-only" : "workspace-write"
    const model = session.model ? ["-m", session.model.id] : []
    const variant = session.model?.variant
    const effort = variant && REASONING_EFFORTS.has(variant) ? ["-c", `model_reasoning_effort="${variant}"`] : []
    const dirs = session.writableDirs ?? []
    if (!session.threadId)
      return [
        "exec",
        "--json",
        "-C",
        session.directory,
        "-s",
        sandbox,
        "--skip-git-repo-check",
        ...dirs.flatMap((dir) => ["--add-dir", dir]),
        ...effort,
        ...model,
      ]
    // `codex exec resume` takes no -C, -s or --add-dir: the cwd is set on the process, and -c carries the sandbox.
    const roots = dirs.length ? ["-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(dirs)}`] : []
    return ["exec", "resume", session.threadId, "--json", "-c", `sandbox_mode="${sandbox}"`, ...roots, ...effort, "--skip-git-repo-check", ...model]
  }

  /** The allowlisted worker environment plus the paths Codex itself needs. */
  private environment(session: CodexSession): Record<string, string> {
    const env: Record<string, string> = { ...(this.backend.info.workerEnv ?? {}) }
    // CODEX_HOME is a path, not a credential; the CLI's own auth.json is its default login.
    if (process.env.CODEX_HOME) env.CODEX_HOME = process.env.CODEX_HOME
    return { ...env, ...session.env }
  }

  private record(session: CodexSession, turn: TurnState, line: string) {
    let event: CodexEvent
    try {
      event = JSON.parse(line) as CodexEvent
    } catch {
      // Not a protocol line (Codex can print a banner): ignore it rather than fail the turn.
      return
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) return
    switch (event.type) {
      case "thread.started":
        if (typeof event.thread_id === "string") {
          session.threadId = event.thread_id
          session.freshThreadNote = undefined
        }
        break
      case "turn.started":
        break
      case "item.started":
        this.item(session, turn, event.item, false)
        break
      case "item.completed":
        this.item(session, turn, event.item, true)
        break
      case "turn.completed":
        turn.usage = event.usage
        break
      case "turn.failed": {
        this.fail(session, turn, messageText(event) ?? "codex reported a failed turn")
        break
      }
      case "error": {
        const message = messageText(event)
        if (message) this.fail(session, turn, message)
        break
      }
      default:
        break
    }
  }

  private item(session: CodexSession, turn: TurnState, item: CodexItem | undefined, completed: boolean) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return
    const id = typeof item.id === "string" ? item.id : `item_${turn.parts.size}`
    if (item.type === "error" || item.error !== undefined) {
      this.fail(session, turn, messageText(item as CodexEvent) ?? "codex reported an error item")
      return
    }
    switch (item.type) {
      case "agent_message": {
        const text = typeof item.text === "string" ? item.text : ""
        const part = this.part(session, turn, id, () => ({ type: "text", text: "" }))
        if (part.type === "text") part.text = text
        if (completed && text) {
          const ordinal = turn.assistant.content.indexOf(part)
          this.emit("session.text.started", { sessionID: session.id, assistantMessageID: turn.assistant.id, ordinal })
          this.emit("session.text.delta", { sessionID: session.id, assistantMessageID: turn.assistant.id, ordinal, delta: text })
        }
        break
      }
      case "reasoning": {
        const text = typeof item.text === "string" ? item.text : ""
        const part = this.part(session, turn, id, () => ({ type: "reasoning", text: "" }))
        if (part.type === "reasoning") part.text = text
        break
      }
      case "command_execution": {
        const command = typeof item.command === "string" ? item.command : ""
        const output = typeof item.aggregated_output === "string" ? item.aggregated_output : ""
        const exit = typeof item.exit_code === "number" ? item.exit_code : undefined
        const failed = completed && (item.status === "failed" || (exit !== undefined && exit !== 0))
        const content: [ToolContent, ...ToolContent[]] = [{ type: "text", text: output }]
        const state: SessionMessageAssistantTool["state"] = completed
          ? failed
            ? { status: "error", input: { command }, error: { type: "codex", message: output || `exit code ${exit ?? "unknown"}` }, content }
            : { status: "completed", input: { command }, content, metadata: { exitCode: exit ?? 0 } }
          : { status: "running", input: { command }, metadata: {} }
        this.toolPart(session, turn, id, "bash", state, completed)
        break
      }
      case "file_change": {
        const raw = Array.isArray(item.changes) ? item.changes : []
        const changes = raw.filter((c): c is { path: string; kind?: string } => {
          if (!c || typeof c !== "object" || Array.isArray(c)) return false
          return typeof (c as { path?: unknown }).path === "string" && (c as { path: string }).path !== ""
        })
        if (!changes.length) {
          this.note(session, turn, id, "Codex reported a file_change item without a usable path; skipped it")
          break
        }
        if (changes.length !== raw.length) this.note(session, turn, id, `Codex reported ${raw.length - changes.length} malformed file change(s); skipped them`)
        const paths = changes.map((c) => c.path)
        const input: Record<string, JsonValue> = {
          path: paths[0] ?? "",
          changes: changes.map((c) => ({ path: c.path, kind: typeof c.kind === "string" ? c.kind : "update" })),
        }
        const content: [ToolContent, ...ToolContent[]] = [{ type: "text", text: paths.join("\n") }]
        const state: SessionMessageAssistantTool["state"] = completed ? { status: "completed", input, content } : { status: "running", input, metadata: {} }
        this.toolPart(session, turn, id, "edit", state, completed)
        break
      }
      case "mcp_tool_call": {
        const name = typeof item.name === "string" ? item.name : "mcp"
        const input: Record<string, JsonValue> =
          item.arguments && typeof item.arguments === "object" && !Array.isArray(item.arguments) ? (item.arguments as Record<string, JsonValue>) : {}
        const output = typeof item.result === "string" ? item.result : item.result === undefined ? "" : JSON.stringify(item.result)
        const content: [ToolContent, ...ToolContent[]] = [{ type: "text", text: output }]
        const state: SessionMessageAssistantTool["state"] = completed ? { status: "completed", input, content } : { status: "running", input, metadata: {} }
        this.toolPart(session, turn, id, name, state, completed)
        break
      }
      default: {
        if (!completed) return
        this.part(session, turn, id, () => ({ type: "text", text: JSON.stringify(item) }))
        break
      }
    }
  }

  /** The content part for an item, creating it (and opening a new step) on first use. */
  private part(
    session: CodexSession,
    turn: TurnState,
    id: string,
    make: () => SessionMessageAssistant["content"][number],
  ): SessionMessageAssistant["content"][number] {
    const existing = turn.parts.get(id)
    if (existing) return existing
    const assistant = this.step(session, turn)
    const part = make()
    assistant.content.push(part)
    turn.parts.set(id, part)
    return part
  }

  private toolPart(session: CodexSession, turn: TurnState, id: string, name: string, state: SessionMessageAssistantTool["state"], completed: boolean) {
    const part = this.part(session, turn, id, () => ({ type: "tool" as const, id, name, state, time: { created: this.now() } }))
    if (part.type !== "tool") return
    part.name = name
    part.state = state
    if (!completed) {
      this.emit("session.step.started", {
        sessionID: session.id,
        assistantMessageID: turn.assistant.id,
        agent: "codex",
        model: this.modelRef(session),
        started: this.now(),
      })
    } else {
      part.time = { ...part.time, completed: this.now() }
      this.emit("session.step.ended", {
        sessionID: session.id,
        assistantMessageID: turn.assistant.id,
        finish: state.status === "error" ? "error" : "tool-calls",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      this.closeStep(turn)
    }
  }

  /** A visible note in the assistant message: the event was unusual but not fatal. */
  private note(session: CodexSession, turn: TurnState, id: string, text: string) {
    const part = this.part(session, turn, `note:${id}`, () => ({ type: "text" as const, text: "" }))
    if (part.type === "text") part.text = text
  }

  private fail(session: CodexSession, turn: TurnState, message: string) {
    turn.failure = message
    session.error = message
    // A deleted or moved CODEX_HOME makes `exec resume` reject the stored thread: forget it so the
    // next prompt can start fresh instead of failing forever. Its history is already unreachable.
    if (session.threadId && /(?:no rollout found for thread|thread\/resume failed|unknown thread|thread .*not found)/i.test(message)) {
      const lost = session.threadId
      session.threadId = undefined
      session.freshThreadNote = `the previous Codex thread (${lost}) was no longer available; this turn started a new one`
    }
  }

  /** The process is gone: close the assistant step, add the idle marker, and start the next queued turn. */
  private finish(session: CodexSession, turn: TurnState, code: number | null | undefined) {
    if (turn.completed) return
    turn.completed = true
    const ended = this.now()
    const usage = turn.usage
    const tokens = {
      input: num(usage?.input_tokens),
      output: num(usage?.output_tokens),
      reasoning: num(usage?.reasoning_output_tokens),
      cacheRead: num(usage?.cached_input_tokens),
      cacheWrite: num(usage?.cache_write_input_tokens),
    }
    const outcome = turn.interrupted ? "interrupted" : turn.failure ? "failed" : code === 0 || code === null || code === undefined ? "succeeded" : "failed"
    if (outcome === "failed" && !turn.failure) turn.failure = `codex exited with code ${code}`
    // A tool still marked running was cut off with the process.
    if (outcome !== "succeeded") {
      for (const part of turn.parts.values()) {
        if (part.type !== "tool" || (part.state.status !== "running" && part.state.status !== "streaming")) continue
        part.state = {
          status: "error",
          input: part.state.status === "running" ? part.state.input : {},
          error: { type: "codex", message: outcome === "interrupted" ? "interrupted" : "the turn ended before the tool finished" },
        }
        part.time = { ...part.time, completed: ended }
      }
    }
    const cost = this.cost(session, tokens)
    turn.assistant.time = { ...turn.assistant.time, completed: ended }
    turn.assistant.tokens = {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cache: { read: tokens.cacheRead, write: tokens.cacheWrite },
    }
    turn.assistant.cost = cost
    turn.assistant.finish = outcome === "failed" ? "error" : "stop"
    if (turn.failure) turn.assistant.error = { type: "codex", message: turn.failure }
    session.cost += cost
    for (const key of Object.keys(tokens) as (keyof typeof tokens)[]) session.tokens[key] += tokens[key]
    session.outcome = outcome
    session.error = turn.failure
    session.proc = undefined
    session.updatedAt = ended
    const idle: SessionMessageInfo = {
      id: this.messageID(),
      type: "idle",
      time: { created: this.now() },
      outcome,
      ...(turn.failure ? { error: { type: "codex", message: turn.failure } } : {}),
    }
    session.messages.push(idle)
    this.emit("session.step.ended", {
      sessionID: session.id,
      assistantMessageID: turn.assistant.id,
      finish: outcome === "failed" ? "error" : "stop",
      cost,
      tokens: { input: tokens.input, output: tokens.output, reasoning: tokens.reasoning, cache: { read: tokens.cacheRead, write: tokens.cacheWrite } },
    })
    session.running = false
    if (session.queue.length && !session.removed) this.startNext(session)
  }

  private cost(session: CodexSession, tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }): number {
    let prices: Record<string, Price>
    try {
      prices = loadPrices(session.directory)
    } catch {
      return 0
    }
    const key = session.model ? `codex/${session.model.id}` : "codex/default"
    const price = prices[key]
    if (!price) return 0
    const cached = price.cachedInput ?? price.input
    // Codex reports Responses API usage: input_tokens is gross of cached and cache-write tokens, and
    // output_tokens already includes reasoning_output_tokens. The codex-cli 0.166.0 binary confirms
    // it by exporting token_usage.non_cached_input_tokens separately from cached_input_tokens and
    // carries a `last_usage_includes_reasoning` flag (see `strings $(command -v codex)`); the
    // app-server protocol's TokenUsageBreakdown in `codex app-server generate-json-schema` names the
    // same fields. Price only the uncached remainder as input, and do not add reasoning on top of
    // output, or cached input and reasoning are charged twice.
    const netInput = Math.max(tokens.input - tokens.cacheRead - tokens.cacheWrite, 0)
    return (netInput * price.input + tokens.output * price.output + tokens.cacheRead * cached + tokens.cacheWrite * price.input) / 1_000_000
  }

  private signal(proc: ChildProcess, signal: NodeJS.Signals) {
    if (!proc.pid) return
    try {
      process.kill(process.platform === "win32" ? proc.pid : -proc.pid, signal)
    } catch {
      try {
        proc.kill(signal)
      } catch {
        // Already gone.
      }
    }
  }

  private emit(type: string, data: Record<string, unknown>) {
    this.events.emit("event", { type, data })
  }
}
