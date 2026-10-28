/**
 * Reduces an OpenCode session's conversation into the facts the fleet needs: is a turn in
 * progress, did it fail or get interrupted, what did it answer, what did it cost.
 *
 * OpenCode 2 keeps no replayable event history, but its messages are the projection of one:
 * a turn is a user prompt (plus anything steered into it), the assistant's steps, and the
 * `idle` marker that closes the run with its outcome. Rebuilding from the messages is exact
 * across restarts; everything up to the last `idle` marker never changes, so callers re-read
 * only the open tail (see `stablePrefix`).
 *
 * Ordering uses the server's creation times (`seq` below): a turn is identified by the time
 * its opening prompt was created, and "after X" means created after X.
 */
import type { SessionInboxInfo, SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"

export interface Tokens {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export interface Turn {
  /** Creation time of the prompt that started this turn: the turn's identity. */
  startSeq: number
  startedAt: number
  /** When the opening prompt was admitted (OpenCode delivers prompts from its inbox). */
  admittedAt: number
  admittedSeq: number
  prompt: string
  /** Text of the latest assistant message that produced text. */
  finalText: string
  finalMessageID?: string
  steps: number
  cost: number
  endedAt?: number
  failure?: string
  interrupted?: boolean
  /** Messages of this turn, in order: its prompt(s) and the assistant's messages. */
  messageIDs: string[]
}

export interface Track {
  /** Creation time of the newest message or inbox item seen. */
  seq: number
  /** Prompts admitted but not yet picked up by the agent loop (OpenCode's inbox). */
  admitted: Map<string, { at: number; seq: number; text: string; delivery?: string }>
  /** A turn is open from its prompt until OpenCode's `idle` marker. */
  inLoop: boolean
  stepOpen: boolean
  /** Tool calls in flight, by call id (models can call several in parallel). */
  openTools: Map<string, { tool: string; input: Record<string, unknown> }>
  turns: Turn[]
  totalSteps: number
  cost: number
  tokens: Tokens
  /** Step costs with their time, so limits can include child sessions. */
  stepCosts: { at: number; cost: number }[]
  lastPromptedAt: number
  lastPromptedSeq: number
  /** Context window in use after the latest step (its prompt plus its output), in tokens. */
  context?: number
  /** Compactions so far (each resets the context). */
  compactions: number
  /** Model and agent profile of the latest step. */
  model?: { id: string; providerID: string; variant?: string }
  agent?: string
  /** Every message id seen, to tell when a prompt we sent has shown up. */
  ids: Set<string>
  /** The conversation this was built from, oldest first (the stable prefix is reused on the next read). */
  messages: SessionMessageInfo[]
  /**
   * The server's opaque cursor just after the newest message read: the next read asks for
   * only what comes after it. Undefined when the server gave none (the next read is whole).
   */
  cursor?: string
}

/** Prices a step from its token usage when OpenCode reports no cost. */
export type CostEstimator = (model: { id: string; providerID: string }, tokens: Tokens) => number | undefined

export function emptyTrack(): Track {
  return {
    seq: 0,
    admitted: new Map(),
    inLoop: false,
    stepOpen: false,
    openTools: new Map(),
    turns: [],
    totalSteps: 0,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    stepCosts: [],
    compactions: 0,
    lastPromptedAt: 0,
    lastPromptedSeq: 0,
    ids: new Set(),
    messages: [],
  }
}

const MAX_TURNS = 50

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

export function currentTurn(t: Track): Turn | undefined {
  return t.turns[t.turns.length - 1]
}

/** The tool call that started most recently, if any are running. */
export function latestTool(t: Track): { tool: string; input: Record<string, unknown> } | undefined {
  return [...t.openTools.values()].pop()
}

/** Cost of steps that ended at or after `since`. */
export function costSince(t: Track, since: number): number {
  return t.stepCosts.filter((s) => s.at >= since).reduce((a, s) => a + s.cost, 0)
}

/** Turns that started after `seq` (exclusive), oldest first. */
export function turnsSince(t: Track, seq: number): Turn[] {
  return t.turns.filter((x) => x.startSeq > seq)
}

/** How many leading messages can be kept on the next read: through the last `idle` marker. */
export function stablePrefix(messages: SessionMessageInfo[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.type === "idle") return i + 1
  return 0
}

/** An OpenCode error as one line, with the HTTP status when a provider answered with one. */
export function errorText(e: { message: string; status?: number }): string {
  return e.status ? `${e.message} (HTTP ${e.status})` : e.message
}

function assistantText(m: SessionMessageAssistant): string {
  return m.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("")
}

/** Build the track from a conversation (oldest first) and the prompts still waiting in the inbox. */
export function buildTrack(messages: SessionMessageInfo[], inbox: SessionInboxInfo[] = [], estimate?: CostEstimator): Track {
  const t = emptyTrack()
  t.messages = messages
  let turn: Turn | undefined
  for (const m of messages) {
    const at = m.time.created
    t.seq = Math.max(t.seq, at)
    t.ids.add(m.id)
    switch (m.type) {
      case "user": {
        t.lastPromptedAt = at
        t.lastPromptedSeq = at
        if (turn && turn.endedAt === undefined) {
          // Steered (or queued) into the running loop: same run, remember the extra instruction.
          turn.prompt = `${turn.prompt}\n[steer] ${m.text}`
          turn.messageIDs.push(m.id)
        } else {
          turn = { startSeq: at, startedAt: at, admittedAt: at, admittedSeq: at, prompt: m.text, finalText: "", steps: 0, cost: 0, messageIDs: [m.id] }
          t.turns.push(turn)
          if (t.turns.length > MAX_TURNS) t.turns.shift()
        }
        t.inLoop = true
        break
      }
      case "synthetic":
        if (turn && turn.endedAt === undefined) turn.messageIDs.push(m.id)
        break
      case "assistant": {
        const tok = m.tokens
        const step: Tokens = {
          input: num(tok?.input),
          output: num(tok?.output),
          reasoning: num(tok?.reasoning),
          cacheRead: num(tok?.cache?.read),
          cacheWrite: num(tok?.cache?.write),
        }
        let cost = num(m.cost)
        if (!cost && estimate) cost = estimate(m.model, step) ?? 0
        t.cost += cost
        t.stepCosts.push({ at: m.time.completed ?? at, cost })
        for (const k of Object.keys(step) as (keyof Tokens)[]) t.tokens[k] += step[k]
        // What the next step resends: this step's prompt and its answer. Reasoning is not carried
        // over between steps by most providers, so it does not count against the window.
        const used = step.input + step.cacheRead + step.cacheWrite + step.output
        if (used) t.context = used
        t.model = m.model
        t.agent = m.agent
        t.totalSteps++
        if (turn && turn.endedAt === undefined) {
          turn.steps++
          turn.cost += cost
          turn.messageIDs.push(m.id)
          const text = assistantText(m)
          if (text.trim()) {
            turn.finalText = text
            turn.finalMessageID = m.id
          }
        }
        break
      }
      case "compaction":
        if (m.status === "completed") {
          t.compactions++
          t.context = undefined
        }
        if (m.status !== "running") {
          t.cost += num(m.cost)
          t.stepCosts.push({ at, cost: num(m.cost) })
        }
        break
      case "idle":
        t.inLoop = false
        if (turn && turn.endedAt === undefined) {
          turn.endedAt = at
          if (m.outcome === "interrupted") {
            turn.interrupted = true
            turn.failure = m.error ? errorText(m.error) : "interrupted"
          } else if (m.outcome === "failed") turn.failure = m.error ? errorText(m.error) : "the turn failed"
        }
        break
    }
  }
  // The open step and its tools: the newest assistant message, while it has not completed.
  const last = messages[messages.length - 1]
  if (t.inLoop && last?.type === "assistant" && !last.time.completed) {
    t.stepOpen = true
    for (const c of last.content) {
      if (c.type === "tool" && (c.state.status === "streaming" || c.state.status === "running")) {
        t.openTools.set(c.id, { tool: c.name, input: c.state.status === "running" ? c.state.input : {} })
      }
    }
  }
  for (const item of inbox) {
    if (item.type !== "user") continue
    const at = item.time.created
    t.seq = Math.max(t.seq, at)
    t.admitted.set(item.id, { at, seq: at, text: item.payload.text, delivery: item.delivery })
  }
  return t
}
