import type { EventEmitter } from "node:events"
import type {
  AgentInfo,
  FormInfo,
  ModelInfo,
  ModelRef,
  OpenCodeEvent,
  PermissionRequest,
  PermissionSavedInfo,
  SessionInboxInfo,
  SessionInfo,
  SessionMessageInfo,
} from "@opencode/client"
import type { Backend } from "./backend.js"

/**
 * The worker runtime seam.
 *
 * A runtime starts and stops agent sessions, sends them turns, reads their history and reports
 * their status. OpenCode is the only implementation today; Codex and Cursor will plug in behind
 * the same interface without the tracker, the snapshots or the tools learning another shape.
 *
 * The data types are OpenCode's on purpose. `SessionMessageInfo`, `SessionInboxInfo`, the model
 * catalog and the event objects are what the tracker, the renderer and the snapshots already
 * consume, so adapting another CLI means mapping its records into these shapes at the edge,
 * rather than changing every reader in the middle. Likewise `status` answers in the vocabulary
 * the fleet derives today (running, idle, error with its text), not in any one server's wording.
 */
export type RuntimeKind = "opencode" | "codex" | "cursor"

/** What a runtime can do, so callers can word outcomes and refusals without trying an operation first. */
export interface RuntimeCapabilities {
  /** A prompt can join a turn already in progress instead of waiting for the next one. */
  midTurnSteering: boolean
  /** The runtime asks for permission (and questions) that a caller can answer. */
  permissionPrompts: boolean
  /** Conversation turns can be reverted, restoring their files. */
  revert: boolean
  /** A conversation can be compacted into a summary. */
  compact: boolean
  /** Edits can be confined to a set of paths by the runtime itself. */
  scopeRules: boolean
}

/** A session permission rule, in the shape OpenCode stores and every reader compares. */
export interface SessionRule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

export interface CreateSessionInput {
  directory: string
  title: string
  /** The model and effort the session starts on; absent leaves the runtime's default. */
  model?: ModelRef
  variant?: string
  /** A runtime-specific agent profile (OpenCode's "build", "plan", …). */
  agent?: string
  /** The session's permission policy; a runtime without prompts uses "deny" to run read-only. */
  permissions?: "user" | "ask" | "allow" | "deny"
  /** The session's own permission rules, applied before any turn. */
  rules?: SessionRule[]
  /** Environment variables the session's tools should see. */
  env?: Record<string, string>
  /** Directories outside the session's own that a sandboxed runtime must be able to write. */
  writableDirs?: string[]
}

export interface PromptOptions {
  /** Files attached to the turn (already materialised for the runtime). */
  files?: { uri: string; name?: string; description?: string }[]
  /** Steer an open turn, or queue the text for the next one. */
  delivery?: "steer" | "queue"
}

export interface MessageOptions {
  /** Continue after an opaque cursor returned by an earlier read. */
  cursor?: string
  /** The order of these messages; the default is the server's. */
  order?: "asc" | "desc"
  limit?: number
  /** Read this one message again (the newest, which can still change). */
  messageID?: string
  /** Only the messages after this one, for runtimes whose history is addressed by message id. */
  after?: string
}

export interface MessagePage {
  messages: SessionMessageInfo[]
  /** The position just past this page; feed it back as `cursor`. Absent when the list ends here. */
  cursor?: string
}

/** What the fleet derives from a session read: the session, whether it is active, and any failure. */
export interface RuntimeStatus {
  state: "running" | "idle" | "error"
  /** Why it is in error, when the runtime knows. */
  error?: string
  session: SessionInfo
  /** The active session ids read alongside this one, so a tree check needs no second round trip. */
  active: Set<string>
}

export interface PermissionReply {
  decision: "once" | "always" | "reject"
  message?: string
}

/** OpenCode's forms: the question tool's questions, and any other input it asks for. */
export interface RuntimeForm {
  list(sessionID: string): Promise<FormInfo[]>
  reply(sessionID: string, formID: string, answer: Record<string, string | string[] | number | boolean>): Promise<void>
  cancel(sessionID: string, formID: string): Promise<void>
}

export interface RuntimePermissions {
  list(sessionID: string): Promise<PermissionRequest[]>
  reply(sessionID: string, requestID: string, reply: PermissionReply): Promise<void>
  saved: {
    list(projectID?: string): Promise<PermissionSavedInfo[]>
    remove(id: string): Promise<void>
  }
}

export interface RuntimeLocation {
  get(directory: string): Promise<{ directory: string; project: { id: string; directory: string } }>
  /** Let the runtime release a directory before it is removed (best effort). */
  evict?(directory: string): Promise<void>
}

export interface RuntimeUpdate {
  permissions?: SessionRule[]
  title?: string
}

export interface RuntimeRevert {
  stage(sessionID: string, messageID: string, files: boolean): Promise<{ files?: { file: string; status: string }[] }>
  commit(sessionID: string): Promise<void>
}

/**
 * Everything the worker lifecycle needs. The OpenCode-only operations are optional: a runtime
 * that lacks one says so through `notSupported` instead of failing with an unexplained error.
 */
export interface Runtime {
  readonly kind: RuntimeKind
  readonly capabilities: RuntimeCapabilities
  /** The runtime's event stream, delivering the same objects the fleet switches on today. */
  readonly events: EventEmitter
  models(directory?: string): Promise<ModelInfo[]>
  createSession(input: CreateSessionInput): Promise<SessionInfo>
  /** Start a turn without waiting for it. */
  prompt(id: string, text: string, opts?: PromptOptions): Promise<{ id: string }>
  messages(id: string, opts?: MessageOptions): Promise<MessagePage>
  inbox(id: string): Promise<SessionInboxInfo[]>
  status(id: string, active?: Set<string>): Promise<RuntimeStatus>
  session(id: string): Promise<SessionInfo>
  /** The ids of every session that is running now. */
  active(): Promise<Set<string>>
  /** Sessions in a directory, newest first unless asked otherwise. */
  sessions(directory: string, opts?: { limit?: number; order?: "asc" | "desc" }): Promise<SessionInfo[]>
  interrupt(id: string): Promise<void>
  remove(id: string): Promise<void>
  /** Interrupt, drop every queued prompt and keep the transcript readable (a dropped agent must not start another turn). */
  dispose?(id: string): Promise<void>
  readonly form?: RuntimeForm
  readonly permissions?: RuntimePermissions
  readonly revert?: RuntimeRevert
  compact?(id: string): Promise<{ id: string }>
  switchModel?(id: string, model: ModelRef): Promise<void>
  switchAgent?(id: string, agent: string): Promise<void>
  update?(id: string, update: RuntimeUpdate): Promise<void>
  setEnvironment?(id: string, env: Record<string, string>): Promise<void>
  readonly location?: RuntimeLocation
  /** The runtime's agent profiles (OpenCode's build, plan, subagents). */
  agents?(directory?: string): Promise<AgentInfo[]>
}

/** The answer a runtime without an operation gives, naming what was asked and what it runs. */
export function notSupported(runtime: Runtime, what: string): Error {
  return new Error(`${what} is not supported by the ${runtime.kind} runtime`)
}

export const REQUEST_MS = 30_000
export const REQUEST_GRACE_MS = 5_000
export const LONG_REQUEST_MS = 120_000

/** Request options that give up after `ms` (the SDK passes them to fetch). */
export function timed(ms = REQUEST_MS): { signal: AbortSignal } {
  return { signal: AbortSignal.timeout(ms) }
}

/** Settle with `p`, or reject after `ms` (the work itself is not cancelled). */
export function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${Math.round(ms / 1000)}s`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

/** The answer of a request, or an error that names what failed. Settles within a local deadline whatever the SDK does. */
export async function req<T>(what: string, p: Promise<T>, ms = REQUEST_MS + REQUEST_GRACE_MS): Promise<T> {
  try {
    return await within(p, ms, what)
  } catch (err) {
    // A local deadline already names the request; anything else is named once here.
    if ((err as Error).message === `${what} did not finish within ${Math.round(ms / 1000)}s`) throw err
    throw new Error(`${what} failed: ${(err as Error).message || String(err)}`, { cause: err })
  }
}

/** The OpenCode implementation: the existing backend client behind the runtime interface. */
export class OpenCodeRuntime implements Runtime {
  readonly kind = "opencode" as const
  readonly capabilities: RuntimeCapabilities = {
    midTurnSteering: true,
    permissionPrompts: true,
    revert: true,
    compact: true,
    scopeRules: true,
  }
  readonly events: EventEmitter
  readonly form: RuntimeForm
  readonly permissions: RuntimePermissions
  readonly revert: RuntimeRevert
  readonly location: RuntimeLocation

  constructor(private readonly backend: Backend) {
    this.events = backend.events
    this.form = {
      list: async (sessionID) => req("listing questions", this.client.session.form.list({ sessionID }, timed())),
      reply: async (sessionID, formID, answer) => {
        await req("answering question", this.client.session.form.reply({ sessionID, formID, answer }, timed()))
      },
      cancel: async (sessionID, formID) => {
        await req("rejecting question", this.client.session.form.cancel({ sessionID, formID }, timed()))
      },
    }
    this.permissions = {
      list: async (sessionID) => req("listing permissions", this.client.permission.list({ sessionID }, timed())),
      reply: async (sessionID, requestID, reply) => {
        await req(
          "replying to permission",
          this.client.permission.reply({ sessionID, requestID, decision: reply.decision, ...(reply.message ? { message: reply.message } : {}) }, timed()),
        )
      },
      saved: {
        list: async (projectID) => req("listing saved permissions", this.client.permission.saved.list(projectID ? { projectID } : {}, timed())),
        remove: async (id) => {
          await req("removing the saved permission", this.client.permission.saved.remove({ id }, timed()))
        },
      },
    }
    this.revert = {
      stage: async (sessionID, messageID, files) => req("staging the revert", this.client.session.revert.stage({ sessionID, messageID, files }, timed())),
      commit: async (sessionID) => {
        await req("committing the revert", this.client.session.revert.commit({ sessionID }, timed()))
      },
    }
    this.location = {
      get: async (directory) => req("locating the project", this.client.location.get({ location: { directory } }, timed(LONG_REQUEST_MS)), LONG_REQUEST_MS),
      evict: async (directory) => {
        await within(this.client.debug.location.evict({ location: { directory } }), REQUEST_MS + REQUEST_GRACE_MS, "evicting the location").catch(
          () => undefined,
        )
      },
    }
  }

  private get client() {
    return this.backend.client
  }

  async models(directory?: string): Promise<ModelInfo[]> {
    // The first catalog read after a server start loads providers and the models.dev catalog; with
    // several servers starting at once it takes well over the usual request deadline.
    const list = () =>
      req(
        "listing models",
        this.client.model.list({ location: directory ? { directory } : undefined }, timed(LONG_REQUEST_MS)),
        LONG_REQUEST_MS + REQUEST_GRACE_MS,
      )
    return (await list()).data
  }

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    const model = input.model && input.variant && !input.model.variant ? { ...input.model, variant: input.variant } : input.model
    const session = await req(
      "creating session",
      this.client.session.create(
        {
          location: { directory: input.directory },
          title: input.title,
          ...(model ? { model } : {}),
          ...(input.agent ? { agent: input.agent } : {}),
          ...(input.rules ? { permissions: input.rules } : {}),
        },
        timed(LONG_REQUEST_MS),
      ),
      LONG_REQUEST_MS,
    )
    if (input.env) await this.setEnvironment(session.id, input.env)
    return session
  }

  async prompt(id: string, text: string, opts: PromptOptions = {}): Promise<{ id: string }> {
    const sent = await req(
      "sending prompt",
      this.client.session.prompt(
        {
          sessionID: id,
          text,
          ...(opts.files?.length ? { files: opts.files } : {}),
          delivery: opts.delivery ?? "steer",
        },
        timed(LONG_REQUEST_MS),
      ),
      LONG_REQUEST_MS,
    )
    return { id: sent.id }
  }

  async messages(id: string, opts: MessageOptions = {}): Promise<MessagePage> {
    if (opts.messageID) {
      const message = await req("reading the newest message", this.client.session.message.get({ sessionID: id, messageID: opts.messageID }, timed()))
      return { messages: [message] }
    }
    if (opts.after) return this.messagesAfter(id, opts)
    const res = await req(
      "reading the conversation",
      this.client.message.list(
        {
          sessionID: id,
          limit: opts.limit ?? 100,
          ...(opts.cursor ? { cursor: opts.cursor } : opts.order ? { order: opts.order } : {}),
        },
        timed(),
      ),
    )
    return { messages: res.data, cursor: res.cursor.next ?? opts.cursor }
  }

  /** Read from the start to find a message id, then the page after it (runtimes may address history either way). */
  private async messagesAfter(id: string, opts: MessageOptions): Promise<MessagePage> {
    const all: SessionMessageInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < 1000; page++) {
      const res = await this.messages(id, { ...opts, after: undefined, cursor, order: cursor ? undefined : "asc", limit: 100 })
      all.push(...res.messages)
      if (res.messages.length < 100 || !res.cursor) break
      cursor = res.cursor
    }
    const at = all.findIndex((m) => m.id === opts.after)
    const rest = at < 0 ? all : all.slice(at + 1)
    return { messages: rest.slice(0, opts.limit ?? 100) }
  }

  async inbox(id: string): Promise<SessionInboxInfo[]> {
    return req("reading the inbox", this.client.session.inbox.list({ sessionID: id }, timed()))
  }

  async session(id: string): Promise<SessionInfo> {
    return req(`loading session ${id}`, this.client.session.get({ sessionID: id }, timed()))
  }

  async active(): Promise<Set<string>> {
    return new Set(Object.keys(await req("listing active sessions", this.client.session.active(timed()))))
  }

  async sessions(directory: string, opts: { limit?: number; order?: "asc" | "desc" } = {}): Promise<SessionInfo[]> {
    return (await req("listing sessions", this.client.session.list({ directory, limit: opts.limit ?? 100, order: opts.order ?? "desc" }, timed()))).data
  }

  async status(id: string, active?: Set<string>): Promise<RuntimeStatus> {
    const session = await this.session(id)
    const running = active ?? (await this.active())
    if (running.has(id)) return { state: "running", session, active: running }
    if (session.outcome === "failed") return { state: "error", error: "the last turn failed", session, active: running }
    return { state: "idle", session, active: running }
  }

  async interrupt(id: string): Promise<void> {
    await req("interrupting the session", this.client.session.interrupt({ sessionID: id }, timed()), REQUEST_MS + REQUEST_GRACE_MS)
  }

  async remove(id: string): Promise<void> {
    await req("removing the session", this.client.session.remove({ sessionID: id }), REQUEST_MS + REQUEST_GRACE_MS)
  }

  async compact(id: string): Promise<{ id: string }> {
    const queued = await req("compacting the session", this.client.session.compact({ sessionID: id }, timed()))
    return { id: queued.id }
  }

  async switchModel(id: string, model: ModelRef): Promise<void> {
    await req("switching model", this.client.session.switchModel({ sessionID: id, model }, timed()))
  }

  async switchAgent(id: string, agent: string): Promise<void> {
    await req("switching agent", this.client.session.switchAgent({ sessionID: id, agent }, timed()))
  }

  async update(id: string, update: RuntimeUpdate): Promise<void> {
    await req("updating the agent's rules", this.client.session.update({ sessionID: id, ...update }, timed()))
  }

  async setEnvironment(id: string, env: Record<string, string>): Promise<void> {
    await req("setting the session environment", this.client.session.environment({ sessionID: id, variables: env }, timed()))
  }

  async agents(directory?: string): Promise<AgentInfo[]> {
    return (await req("listing agents", this.client.agent.list({ location: directory ? { directory } : undefined }, timed()))).data
  }
}

/** The event types the fleet switches on, named here so a future runtime knows what to deliver. */
export type RuntimeEvent = Extract<
  OpenCodeEvent,
  {
    type:
      | "session.created"
      | "session.step.started"
      | "session.step.ended"
      | "session.text.started"
      | "session.text.delta"
      | "session.retry.scheduled"
      | "session.revert.committed"
  }
>
