/**
 * Reduces an OpenCode v2 session's durable event history into the facts the
 * fleet needs: is a turn in progress, did it fail or get interrupted, what did
 * it answer, what did it cost. Replaying history makes this exact across
 * restarts, and incremental reads keep polling cheap.
 */

export interface Tokens {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export interface Turn {
  /** Seq of the `prompted` event that started this turn. */
  startSeq: number
  startedAt: number
  /** When the opening prompt was admitted (queued prompts are admitted before they start). */
  admittedAt: number
  /** History seq at which the opening prompt was admitted. */
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
  messageIDs?: string[]
}

export interface Track {
  /** Last durable sequence number applied. */
  seq: number
  /** Prompts admitted but not yet picked up by the agent loop. */
  admitted: Map<string, { at: number; seq: number; text: string }>
  /** A turn is open from `prompted` until a final step end, a failure or an interrupt. */
  inLoop: boolean
  stepOpen: boolean
  /** Tool calls in flight, by call id (models can call several in parallel). */
  openTools: Map<string, { tool: string; input: Record<string, unknown> }>
  turns: Turn[]
  totalSteps: number
  cost: number
  tokens: Tokens
  /** Recent step costs with their time, so limits can include child sessions. */
  stepCosts: { at: number; cost: number }[]
  lastEventAt: number
  lastPromptedAt: number
  lastPromptedSeq: number
  /** Context window in use after the latest step (its prompt plus its output), in tokens. */
  context?: number
  /** Compactions so far (each resets the context). */
  compactions: number
  /** Model and agent profile of the latest step (the session may not record them). */
  model?: { id: string; providerID: string; variant?: string }
  agent?: string
}

/** Prices a step from its token usage when OpenCode reports no cost (its v2 runner reports 0). */
export type CostEstimator = (model: { id: string; providerID: string }, tokens: Tokens) => number | undefined

export interface DurableEvent {
  type: string
  durable?: { seq: number }
  data?: Record<string, unknown>
}

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
    lastEventAt: 0,
    lastPromptedAt: 0,
    lastPromptedSeq: 0,
  }
}

const MAX_TURNS = 50
const MAX_STEP_COSTS = 500
/** OpenCode's own interrupt messages ("Tool execution interrupted", "Provider turn interrupted"). */
const INTERRUPTED = /\b(execution|turn) interrupted\b/i

export function isInterruptMessage(message: string): boolean {
  return INTERRUPTED.test(message)
}

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

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

export function apply(t: Track, e: DurableEvent, estimate?: CostEstimator): void {
  const seq = e.durable?.seq ?? t.seq
  if (seq <= t.seq && e.durable) return
  t.seq = Math.max(t.seq, seq)
  const d = e.data ?? {}
  const at = num(d.timestamp) || Date.now()
  t.lastEventAt = at
  const turn = currentTurn(t)

  switch (e.type) {
    case "session.next.prompt.admitted":
      t.admitted.set(str(d.messageID), { at, seq, text: str((d.prompt as { text?: unknown } | undefined)?.text) })
      break
    case "session.next.prompted": {
      const id = str(d.messageID)
      const admittedAt = t.admitted.get(id)?.at ?? at
      const admittedSeq = t.admitted.get(id)?.seq ?? seq
      t.admitted.delete(id)
      // Anything admitted before this prompt and still not picked up was superseded.
      for (const [k, v] of t.admitted) if (v.at < admittedAt) t.admitted.delete(k)
      t.lastPromptedAt = at
      t.lastPromptedSeq = seq
      const text = str((d.prompt as { text?: unknown } | undefined)?.text)
      const steering = t.inLoop && turn && !turn.endedAt && !turn.interrupted && !turn.failure
      if (steering) {
        // Steered into a running turn: same turn, remember the extra instruction.
        turn.prompt = `${turn.prompt}\n[steer] ${text}`
        if (id) turn.messageIDs?.push(id)
      } else {
        t.turns.push({ startSeq: seq, startedAt: at, admittedAt, admittedSeq, prompt: text, finalText: "", steps: 0, cost: 0, messageIDs: id ? [id] : [] })
        if (t.turns.length > MAX_TURNS) t.turns.shift()
      }
      t.inLoop = true
      break
    }
    case "session.next.step.started":
      t.stepOpen = true
      if (turn && typeof d.assistantMessageID === "string" && !turn.messageIDs?.includes(d.assistantMessageID)) turn.messageIDs?.push(d.assistantMessageID)
      if (d.model && typeof d.model === "object") t.model = d.model as Track["model"]
      if (typeof d.agent === "string") t.agent = d.agent
      t.totalSteps++
      if (turn) turn.steps++
      break
    case "session.next.step.ended": {
      t.stepOpen = false
      t.openTools.clear()
      const tok = (d.tokens ?? {}) as { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
      const step: Tokens = {
        input: num(tok.input),
        output: num(tok.output),
        reasoning: num(tok.reasoning),
        cacheRead: num(tok.cache?.read),
        cacheWrite: num(tok.cache?.write),
      }
      let cost = num(d.cost)
      if (!cost && estimate && t.model) cost = estimate(t.model, step) ?? 0
      t.cost += cost
      if (turn) turn.cost += cost
      t.stepCosts.push({ at, cost })
      if (t.stepCosts.length > MAX_STEP_COSTS) t.stepCosts.shift()
      for (const k of Object.keys(step) as (keyof Tokens)[]) t.tokens[k] += step[k]
      const used = step.input + step.cacheRead + step.cacheWrite + step.output + step.reasoning
      if (used) t.context = used
      // "tool-calls" means the loop continues with another step.
      if (str(d.finish) !== "tool-calls") endTurn(t, at)
      break
    }
    case "session.next.revert.committed": {
      // Everything after the boundary message is gone: drop the turns that started after it.
      const boundary = str(d.messageID)
      const keep = t.turns.findIndex((x) => x.messageIDs?.includes(boundary))
      t.turns.splice(keep + 1)
      t.inLoop = false
      t.stepOpen = false
      t.openTools.clear()
      break
    }
    case "session.next.compaction.ended":
      t.compactions++
      t.context = undefined
      break
    case "session.next.step.failed": {
      t.stepOpen = false
      t.openTools.clear()
      const message = str((d.error as { message?: unknown } | undefined)?.message) || "step failed"
      if (turn && !turn.endedAt) {
        turn.failure = message
        turn.interrupted = isInterruptMessage(message)
      }
      endTurn(t, at)
      break
    }
    case "session.next.tool.called":
      t.openTools.set(str(d.callID), { tool: str(d.tool), input: (d.input ?? {}) as Record<string, unknown> })
      break
    case "session.next.tool.success":
      t.openTools.delete(str(d.callID))
      break
    case "session.next.tool.failed": {
      t.openTools.delete(str(d.callID))
      const message = str((d.error as { message?: unknown } | undefined)?.message)
      // An interrupted tool halts the loop (OpenCode may not end the step), e.g. a rejected question.
      if (isInterruptMessage(message)) {
        if (turn && !turn.endedAt) {
          turn.interrupted = true
          turn.failure = message
        }
        t.stepOpen = false
        t.openTools.clear()
        endTurn(t, at)
      }
      break
    }
    case "session.next.text.ended": {
      if (!turn) break
      const id = str(d.assistantMessageID)
      const text = str(d.text)
      if (!text.trim()) break
      if (turn.finalMessageID === id) turn.finalText = `${turn.finalText}${text}`
      else {
        turn.finalMessageID = id
        turn.finalText = text
      }
      break
    }
  }
}

function endTurn(t: Track, at: number) {
  t.inLoop = false
  const turn = currentTurn(t)
  if (turn && !turn.endedAt) turn.endedAt = at
}

/** Turns that started after `seq` (exclusive), oldest first. */
export function turnsSince(t: Track, seq: number): Turn[] {
  return t.turns.filter((x) => x.startSeq > seq)
}
