import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { loadConfig } from "../src/config.js"
import { defaultQuestionPolicy, formatModel, parseModel } from "../src/fleet.js"
import { formatTokens, formatUsd, truncate, truncateHead } from "../src/render.js"
import { apply, currentTurn, type DurableEvent, emptyTrack, turnsSince } from "../src/tracker.js"

let seq = 0
const ev = (type: string, data: Record<string, unknown> = {}): DurableEvent => ({
  type: `session.next.${type}`,
  durable: { seq: ++seq },
  data: { timestamp: 1000 + seq, sessionID: "ses_x", ...data },
})

describe("tracker", () => {
  test("a simple turn: prompt, text, end", () => {
    const t = emptyTrack()
    apply(t, ev("prompt.admitted", { messageID: "m1", prompt: { text: "hi" } }))
    assert.equal(t.admitted.size, 1)
    apply(t, ev("prompted", { messageID: "m1", prompt: { text: "hi" } }))
    assert.equal(t.admitted.size, 0)
    assert.equal(t.inLoop, true)
    apply(t, ev("step.started", { model: { id: "m", providerID: "p" }, agent: "build" }))
    apply(t, ev("text.ended", { assistantMessageID: "a1", text: "hello" }))
    apply(t, ev("step.ended", { finish: "stop", cost: 0.5, tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 3 } } }))
    assert.equal(t.inLoop, false)
    const turn = currentTurn(t)!
    assert.equal(turn.finalText, "hello")
    assert.equal(turn.steps, 1)
    assert.equal(t.cost, 0.5)
    assert.deepEqual(t.tokens, { input: 10, output: 5, reasoning: 1, cacheRead: 2, cacheWrite: 3 })
    assert.equal(t.model?.providerID, "p")
    assert.equal(t.agent, "build")
  })

  test("tool-calls keep the loop going; the last message's text is the answer", () => {
    const t = emptyTrack()
    apply(t, ev("prompted", { messageID: "m1", prompt: { text: "do it" } }))
    apply(t, ev("step.started"))
    apply(t, ev("text.ended", { assistantMessageID: "a1", text: "let me check" }))
    apply(t, ev("tool.called", { callID: "c1", tool: "bash", input: { command: "ls" } }))
    assert.equal(t.openTool?.tool, "bash")
    apply(t, ev("tool.success", { callID: "c1" }))
    assert.equal(t.openTool, undefined)
    apply(t, ev("step.ended", { finish: "tool-calls" }))
    assert.equal(t.inLoop, true)
    apply(t, ev("step.started"))
    apply(t, ev("text.ended", { assistantMessageID: "a2", text: "done" }))
    apply(t, ev("step.ended", { finish: "stop" }))
    assert.equal(currentTurn(t)!.finalText, "done")
    assert.equal(currentTurn(t)!.steps, 2)
  })

  test("a steer joins the running turn; a later prompt starts a new one", () => {
    const t = emptyTrack()
    apply(t, ev("prompted", { messageID: "m1", prompt: { text: "first" } }))
    apply(t, ev("step.started"))
    apply(t, ev("prompted", { messageID: "m2", prompt: { text: "also this" } }))
    assert.equal(t.turns.length, 1)
    assert.match(currentTurn(t)!.prompt, /\[steer\] also this/)
    apply(t, ev("step.ended", { finish: "stop" }))
    const before = t.seq
    apply(t, ev("prompted", { messageID: "m3", prompt: { text: "second" } }))
    assert.equal(t.turns.length, 2)
    assert.equal(turnsSince(t, before).length, 1)
  })

  test("failures and interrupts", () => {
    const t = emptyTrack()
    apply(t, ev("prompted", { messageID: "m1", prompt: { text: "x" } }))
    apply(t, ev("step.started"))
    apply(t, ev("step.failed", { error: { type: "unknown", message: "Provider request failed with HTTP 400" } }))
    assert.equal(t.inLoop, false)
    assert.equal(currentTurn(t)!.failure, "Provider request failed with HTTP 400")
    assert.equal(currentTurn(t)!.interrupted, false)

    apply(t, ev("prompted", { messageID: "m2", prompt: { text: "y" } }))
    apply(t, ev("step.started"))
    apply(t, ev("tool.called", { callID: "c1", tool: "question", input: {} }))
    apply(t, ev("tool.failed", { callID: "c1", error: { type: "unknown", message: "Tool execution interrupted" } }))
    assert.equal(currentTurn(t)!.interrupted, true)
  })

  test("replayed or out-of-order events are ignored", () => {
    const t = emptyTrack()
    const e = ev("prompted", { messageID: "m1", prompt: { text: "x" } })
    apply(t, e)
    apply(t, e)
    assert.equal(t.turns.length, 1)
  })
})

describe("helpers", () => {
  test("parseModel splits on the first slash only", () => {
    assert.deepEqual(parseModel("openrouter/deepseek/deepseek-chat", "high"), { providerID: "openrouter", id: "deepseek/deepseek-chat", variant: "high" })
    assert.throws(() => parseModel("nodash"), /provider\/model/)
    assert.throws(() => parseModel("trailing/"), /provider\/model/)
    assert.equal(formatModel({ providerID: "a", id: "b", variant: "default" }), "a/b")
    assert.equal(formatModel({ providerID: "a", id: "b", variant: "max" }), "a/b [max]")
  })

  test("question policy follows the permission policy", () => {
    assert.equal(defaultQuestionPolicy("user"), "user")
    assert.equal(defaultQuestionPolicy("ask"), "ask")
    assert.equal(defaultQuestionPolicy("allow"), "dismiss")
    assert.equal(defaultQuestionPolicy("deny"), "dismiss")
  })

  test("formatting", () => {
    assert.equal(truncate("abcdef", 100), "abcdef")
    assert.match(truncateHead("x".repeat(100), 10), /90 earlier chars omitted/)
    assert.equal(formatUsd(0), "$0")
    assert.equal(formatUsd(0.004), "$0.0040")
    assert.equal(formatTokens(15_200), "15.2k")
  })

  test("config parsing and validation", () => {
    const c = loadConfig({ HOME: "/home/u", HORDE_OPENCODE_DIRECTORY: "/work" } as NodeJS.ProcessEnv)
    assert.equal(c.serverMode, "shared")
    assert.equal(c.defaultPermissions, "user")
    assert.equal(c.maxRunning, 8)
    assert.equal(c.channel, false)
    assert.equal(c.directory, "/work")
    assert.throws(() => loadConfig({ HORDE_OPENCODE_PERMISSIONS: "maybe" } as NodeJS.ProcessEnv), /must be one of/)
    assert.throws(() => loadConfig({ HORDE_OPENCODE_SERVER: "cloud" } as NodeJS.ProcessEnv), /shared or private/)
    assert.throws(() => loadConfig({ HORDE_OPENCODE_MAX_RUNNING: "-1" } as NodeJS.ProcessEnv), /non-negative integer/)
  })
})
