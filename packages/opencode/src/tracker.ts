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
  prompt: string
  /** Text of the latest assistant message that produced text. */
  finalText: string
  finalMessageID?: string
  steps: number
  cost: number
  endedAt?: number
  failure?: string
  interrupted?: boolean
}

export interface Track {
  /** Last durable sequence number applied. */
  seq: number
  /** Prompts admitted but not yet picked up by the agent loop. */
  admitted: Map<string, { at: number; text: string }>
  /** A turn is open from `prompted` until a final step end or a failure. */
  inLoop: boolean
  stepOpen: boolean
  openTool?: { callID: string; tool: string; input: Record<string, unknown> }
  turns: Turn[]
  totalSteps: number
  cost: number
  tokens: Tokens
  lastEventAt: number
  lastPromptedAt: number
  /** Model and agent profile of the latest step (the session may not record them). */
  model?: { id: string; providerID: string; variant?: string }
  agent?: string
}

export function isInterrupted(message: string): boolean {
  return INTERRUPTED.test(message)
}

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
    turns: [],
    totalSteps: 0,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    lastEventAt: 0,
    lastPromptedAt: 0,
  }
}

const MAX_TURNS = 50
const INTERRUPTED = /interrupt|abort/i

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

export function currentTurn(t: Track): Turn | undefined {
  return t.turns[t.turns.length - 1]
}

export function apply(t: Track, e: DurableEvent): void {
  const seq = e.durable?.seq ?? t.seq
  if (seq <= t.seq && e.durable) return
  t.seq = Math.max(t.seq, seq)
  const d = e.data ?? {}
  const at = num(d.timestamp) || Date.now()
  t.lastEventAt = at
  const turn = currentTurn(t)

  switch (e.type) {
    case "session.next.prompt.admitted":
      t.admitted.set(str(d.messageID), { at, text: str((d.prompt as { text?: unknown } | undefined)?.text) })
      break
    case "session.next.prompted": {
      t.admitted.delete(str(d.messageID))
      t.lastPromptedAt = at
      const text = str((d.prompt as { text?: unknown } | undefined)?.text)
      if (t.inLoop && turn && !turn.endedAt) {
        // Steered into a running turn: same turn, remember the extra instruction.
        turn.prompt = `${turn.prompt}\n[steer] ${text}`
      } else {
        t.turns.push({ startSeq: seq, startedAt: at, prompt: text, finalText: "", steps: 0, cost: 0 })
        if (t.turns.length > MAX_TURNS) t.turns.shift()
      }
      t.inLoop = true
      break
    }
    case "session.next.step.started":
      t.stepOpen = true
      if (d.model && typeof d.model === "object") t.model = d.model as Track["model"]
      if (typeof d.agent === "string") t.agent = d.agent
      t.totalSteps++
      if (turn) turn.steps++
      break
    case "session.next.step.ended": {
      t.stepOpen = false
      t.openTool = undefined
      const cost = num(d.cost)
      t.cost += cost
      if (turn) turn.cost += cost
      const tok = (d.tokens ?? {}) as { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
      t.tokens.input += num(tok.input)
      t.tokens.output += num(tok.output)
      t.tokens.reasoning += num(tok.reasoning)
      t.tokens.cacheRead += num(tok.cache?.read)
      t.tokens.cacheWrite += num(tok.cache?.write)
      // "tool-calls" means the loop continues with another step.
      if (str(d.finish) !== "tool-calls" || turn?.interrupted) endTurn(t, at)
      break
    }
    case "session.next.step.failed": {
      t.stepOpen = false
      t.openTool = undefined
      const message = str((d.error as { message?: unknown } | undefined)?.message) || "step failed"
      if (turn) {
        turn.failure = message
        turn.interrupted = INTERRUPTED.test(message)
      }
      endTurn(t, at)
      break
    }
    case "session.next.tool.called":
      t.openTool = { callID: str(d.callID), tool: str(d.tool), input: (d.input ?? {}) as Record<string, unknown> }
      break
    case "session.next.tool.success":
      if (t.openTool?.callID === str(d.callID)) t.openTool = undefined
      break
    case "session.next.tool.failed": {
      if (t.openTool?.callID === str(d.callID)) t.openTool = undefined
      const message = str((d.error as { message?: unknown } | undefined)?.message)
      if (turn && INTERRUPTED.test(message)) {
        turn.interrupted = true
        turn.failure = message
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
