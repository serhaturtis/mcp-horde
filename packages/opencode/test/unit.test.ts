import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, test } from "node:test"
import { formatTokens, formatUsd, truncate, truncateHead } from "@mcp-horde/core"
import type { QuestionV2Request } from "@opencode-ai/sdk/v2"
import { isLoopback, shimTarget } from "../src/backend.js"
import { loadConfig } from "../src/config.js"
import { defaultQuestionPolicy, defined, formatModel, parseModel } from "../src/fleet.js"
import { questionAnswers, questionSchema } from "../src/hooks.js"
import { Store } from "../src/state.js"
import { price } from "../src/tools.js"
import { apply, costSince, currentTurn, type DurableEvent, emptyTrack, isInterruptMessage, latestTool, turnsSince } from "../src/tracker.js"
import { branchSlug, validateLink } from "../src/worktree.js"

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
    assert.equal(t.openTools.get("c1")?.tool, "bash")
    apply(t, ev("tool.success", { callID: "c1" }))
    assert.equal(t.openTools.size, 0)
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

  test("only OpenCode's own interrupt messages count as interrupts", () => {
    assert.ok(isInterruptMessage("Tool execution interrupted"))
    assert.ok(isInterruptMessage("Provider turn interrupted"))
    assert.ok(!isInterruptMessage("The operation was aborted"))
    assert.ok(!isInterruptMessage("curl: (56) Recv failure: interrupted system call"))

    // An ordinary tool error does not end the turn.
    const t = emptyTrack()
    apply(t, ev("prompted", { messageID: "m1", prompt: { text: "x" } }))
    apply(t, ev("step.started"))
    apply(t, ev("tool.called", { callID: "c1", tool: "bash", input: {} }))
    apply(t, ev("tool.failed", { callID: "c1", error: { message: "The operation was aborted" } }))
    assert.equal(t.inLoop, true)
    assert.equal(currentTurn(t)!.interrupted, undefined)
  })

  test("an interrupted tool closes the turn; the next prompt starts a new one", () => {
    const t = emptyTrack()
    apply(t, ev("prompted", { messageID: "m1", prompt: { text: "ask me" } }))
    apply(t, ev("step.started"))
    apply(t, ev("tool.called", { callID: "c1", tool: "question", input: {} }))
    apply(t, ev("tool.failed", { callID: "c1", error: { message: "Tool execution interrupted" } }))
    assert.equal(t.inLoop, false)
    assert.equal(t.stepOpen, false)
    assert.ok(currentTurn(t)!.endedAt)
    apply(t, ev("prompted", { messageID: "m2", prompt: { text: "go on" } }))
    assert.equal(t.turns.length, 2)
    assert.equal(currentTurn(t)!.prompt, "go on")
  })

  test("parallel tool calls are tracked separately", () => {
    const t = emptyTrack()
    apply(t, ev("prompted", { messageID: "m1", prompt: { text: "x" } }))
    apply(t, ev("step.started"))
    apply(t, ev("tool.called", { callID: "a", tool: "read", input: {} }))
    apply(t, ev("tool.called", { callID: "b", tool: "grep", input: {} }))
    assert.equal(latestTool(t)?.tool, "grep")
    apply(t, ev("tool.success", { callID: "b" }))
    assert.equal(latestTool(t)?.tool, "read")
    apply(t, ev("tool.success", { callID: "a" }))
    assert.equal(latestTool(t), undefined)
  })

  test("queued prompts keep their admission time and seq", () => {
    const t = emptyTrack()
    apply(t, ev("prompt.admitted", { messageID: "m1", prompt: { text: "queued" } }))
    const admittedSeq = t.seq
    const admittedAt = 1000 + admittedSeq
    apply(t, ev("prompted", { messageID: "m1", prompt: { text: "queued" } }))
    assert.equal(currentTurn(t)!.admittedSeq, admittedSeq)
    assert.equal(currentTurn(t)!.admittedAt, admittedAt)
    assert.equal(t.lastPromptedSeq, t.seq)
  })

  test("a failed step only marks an open turn; step costs are kept for limits", () => {
    const t = emptyTrack()
    apply(t, ev("prompted", { messageID: "m1", prompt: { text: "x" } }))
    apply(t, ev("step.started"))
    apply(t, ev("step.ended", { finish: "stop", cost: 1 }))
    apply(t, ev("step.failed", { error: { message: "late failure" } }))
    assert.equal(currentTurn(t)!.failure, undefined)
    const at = 1000 + t.seq
    apply(t, ev("prompted", { messageID: "m2", prompt: { text: "y" } }))
    apply(t, ev("step.started"))
    apply(t, ev("step.ended", { finish: "stop", cost: 2 }))
    assert.equal(costSince(t, at), 2)
    assert.equal(t.cost, 3)
  })

  test("steps OpenCode reports as free are priced by the estimator", () => {
    const t = emptyTrack()
    const estimate = (m: { id: string }, tok: { input: number; output: number }) => (m.id === "paid" ? (tok.input + tok.output) / 100 : undefined)
    apply(t, ev("prompted", { messageID: "m1", prompt: { text: "x" } }), estimate)
    apply(t, ev("step.started", { model: { id: "paid", providerID: "p" } }), estimate)
    apply(t, ev("step.ended", { finish: "stop", cost: 0, tokens: { input: 10, output: 5 } }), estimate)
    assert.equal(t.cost, 0.15)
    // A cost OpenCode does report wins.
    apply(t, ev("prompted", { messageID: "m2", prompt: { text: "y" } }), estimate)
    apply(t, ev("step.started", { model: { id: "paid", providerID: "p" } }), estimate)
    apply(t, ev("step.ended", { finish: "stop", cost: 2, tokens: { input: 10, output: 5 } }), estimate)
    assert.equal(t.cost, 2.15)
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
  test("model prices: base tier per million tokens, free, unknown", () => {
    const c = (input: number, output: number, tier?: { type: "context"; size: number }) => ({ input, output, tier, cache: { read: 0, write: 0 } })
    assert.equal(price({ cost: [c(0.27, 1.1)] }), "$0.27/$1.10 per M")
    assert.equal(price({ cost: [c(3, 15), c(6, 22.5, { type: "context", size: 200_000 })] }), "$3/$15 per M")
    assert.equal(price({ cost: [c(0, 0)] }), "free")
    assert.equal(price({ cost: [] }), "price unknown")
  })

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

  test("defined drops undefined keys (limit merges keep the other limits)", () => {
    const merged = { max_cost: 1, max_steps: 5, ...defined({ max_cost: undefined, max_minutes: 3 }) }
    assert.deepEqual(merged, { max_cost: 1, max_steps: 5, max_minutes: 3 })
  })

  test("loopback detection", () => {
    assert.ok(isLoopback("127.0.0.1"))
    assert.ok(isLoopback("localhost"))
    assert.ok(isLoopback("[::1]"))
    assert.ok(!isLoopback("127.example.com"))
    assert.ok(!isLoopback("10.0.0.1"))
  })

  test("npm .cmd shims resolve to the program, not node.exe", () => {
    const shim = [
      "@ECHO off",
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ")",
      '"%dp0%\\node_modules\\opencode-windows-x64\\bin\\opencode.exe" %*',
    ].join("\r\n")
    assert.equal(shimTarget(shim), "node_modules\\opencode-windows-x64\\bin\\opencode.exe")
    assert.equal(shimTarget('"%dp0%\\node.exe" "%dp0%\\x.js" %*'), undefined)
  })

  test("branch slugs are valid git ref components", () => {
    assert.equal(branchSlug("a..b"), "a-b")
    assert.equal(branchSlug(".hidden"), "hidden")
    assert.equal(branchSlug("x.lock"), "x")
    assert.equal(branchSlug("fix the bug!"), "fix-the-bug")
    assert.equal(branchSlug("..."), "agent")
    for (const name of ["a..b", ".x", "x.lock", "x.", "weird name/with:chars"]) {
      execFileSync("git", ["check-ref-format", `refs/heads/horde/${branchSlug(name)}`])
    }
  })

  test("link paths are validated", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "horde-link-"))
    execFileSync("git", ["init", "-q"], { cwd: repo })
    fs.writeFileSync(path.join(repo, "tracked.txt"), "x")
    execFileSync("git", ["add", "tracked.txt"], { cwd: repo })
    assert.equal(await validateLink(repo, "node_modules/"), "node_modules")
    assert.equal(await validateLink(repo, ".env"), ".env")
    for (const bad of ["..", "../other", "a/../b", ".", "", "/abs", "C:\\x"]) {
      await assert.rejects(validateLink(repo, bad), /plain relative path/, bad)
    }
    await assert.rejects(validateLink(repo, "tracked.txt"), /tracked by git/)
    fs.rmSync(repo, { recursive: true, force: true })
  })

  test("question dialogs: single, multi-select and custom answers", () => {
    const req = {
      id: "q",
      sessionID: "s",
      questions: [
        {
          question: "Pick one",
          header: "",
          options: [
            { label: "A", description: "first" },
            { label: "B", description: "" },
          ],
          custom: false,
        },
        {
          question: "Pick many",
          header: "",
          options: [
            { label: "x, y", description: "" },
            { label: "z", description: "" },
          ],
          multiple: true,
        },
        { question: "Free text", header: "", options: [] },
      ],
    } as unknown as QuestionV2Request
    const { properties, required } = questionSchema(req)
    assert.deepEqual(required, ["q0", "q2_text"])
    assert.deepEqual((properties.q0 as { oneOf: unknown[] }).oneOf, [
      { const: "A", title: "A — first" },
      { const: "B", title: "B" },
    ])
    assert.equal(properties.q0_text, undefined, "no free text when custom answers are off")
    assert.equal((properties.q1 as { type: string }).type, "array")
    assert.ok(properties.q1_text)
    // Labels with commas survive multi-select; free text wins over a choice.
    assert.deepEqual(questionAnswers(req, { q0: "B", q1: ["x, y", "z"], q1_text: "", q2_text: " mine " }), [["B"], ["x, y", "z"], ["mine"]])
    assert.deepEqual(questionAnswers(req, undefined), [[], [], []])
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
    assert.equal(c.directory, path.resolve("/work"))
    assert.throws(() => loadConfig({ HORDE_OPENCODE_PERMISSIONS: "maybe" } as NodeJS.ProcessEnv), /must be one of/)
    assert.throws(() => loadConfig({ HORDE_OPENCODE_SERVER: "cloud" } as NodeJS.ProcessEnv), /shared or private/)
    assert.throws(() => loadConfig({ HORDE_OPENCODE_MAX_RUNNING: "-1" } as NodeJS.ProcessEnv), /non-negative integer/)
    // Booleans are case-insensitive and strict.
    assert.equal(loadConfig({ HORDE_OPENCODE_CHANNEL: "TRUE" } as NodeJS.ProcessEnv).channel, true)
    assert.equal(loadConfig({ HORDE_OPENCODE_CHANNEL: "Off" } as NodeJS.ProcessEnv).channel, false)
    assert.throws(() => loadConfig({ HORDE_OPENCODE_CHANNEL: "maybe" } as NodeJS.ProcessEnv), /HORDE_OPENCODE_CHANNEL/)
    assert.equal(loadConfig({ HORDE_OPENCODE_DIALOG_TIMEOUT: "30" } as NodeJS.ProcessEnv).elicitTimeoutMs, 30_000)
  })
})

describe("API policy", () => {
  test("only compat.ts uses OpenCode's legacy API; everything else is v2", () => {
    const src = path.resolve(import.meta.dirname, "../src")
    const legacy = /\bclient\.(session|instance|global|config|project|app|file|find|tool|agent|provider|mcp|event|lsp|command|tui|path|auth|pty)\./
    for (const f of fs.readdirSync(src)) {
      if (!f.endsWith(".ts") || f === "compat.ts") continue
      const lines = fs.readFileSync(path.join(src, f), "utf8").split("\n")
      lines.forEach((line, i) => {
        assert.doesNotMatch(line, legacy, `${f}:${i + 1} uses the legacy API; add it to compat.ts with the v2 gap it covers`)
      })
    }
  })
})

describe("state store", () => {
  test("migrates the legacy state.json to per-agent files with a stable server key", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "horde-state-"))
    const base = { directory: "/w", policy: "user", questions: "user", limits: {}, createdAt: 1, reportedSeq: 3 }
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({
        server: { url: "http://127.0.0.1:4096", pid: 1, password: "p", startedAt: 1 },
        agents: {
          ses_a: { ...base, id: "ses_a", server: "http://127.0.0.1:4096", interruptedAt: 5 },
          ses_b: { ...base, id: "ses_b", server: "https://remote.example" },
        },
      }),
    )
    const store = new Store(dir)
    assert.ok(fs.existsSync(path.join(dir, "state.json.migrated")))
    assert.equal(store.server?.url, "http://127.0.0.1:4096")
    assert.deepEqual(
      store.agents("local").map((r) => r.id),
      ["ses_a"],
    )
    assert.equal((store.get("ses_a") as unknown as Record<string, unknown>).interruptedAt, undefined)
    assert.deepEqual(
      store.agents("https://remote.example").map((r) => r.id),
      ["ses_b"],
    )
    store.update("ses_a", { name: "n", reportedSeq: 4 })
    store.update("ses_a", { name: undefined })
    assert.equal(store.get("ses_a")?.name, undefined)
    assert.equal(store.get("ses_a")?.reportedSeq, 4)
    assert.throws(() => store.get("../escape"), /invalid session id/)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("locks serialize holders and take over a dead holder's lock", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "horde-lock-"))
    const store = new Store(dir)
    const order: string[] = []
    const hold = (tag: string) =>
      store.lock("x", async () => {
        order.push(`${tag}+`)
        await new Promise((r) => setTimeout(r, 50))
        order.push(`${tag}-`)
      })
    await Promise.all([hold("a"), hold("b")])
    assert.ok(order.join(" ") === "a+ a- b+ b-" || order.join(" ") === "b+ b- a+ a-", order.join(" "))
    assert.ok(!fs.existsSync(path.join(dir, "x.lock")), "released")

    // A lock left by a process that no longer exists is taken over at once.
    const dead = execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).toString()
    fs.writeFileSync(path.join(dir, "x.lock"), JSON.stringify({ pid: Number(dead), host: os.hostname(), token: "t" }))
    const started = Date.now()
    assert.equal(await store.lock("x", async () => "ok", 5_000), "ok")
    assert.ok(Date.now() - started < 3_000)

    // A live holder is waited for, not stolen from.
    fs.writeFileSync(path.join(dir, "x.lock"), JSON.stringify({ pid: process.pid, host: os.hostname(), token: "t" }))
    await assert.rejects(
      store.lock("x", async () => "stolen", 600),
      /timed out/,
    )
    assert.ok(fs.existsSync(path.join(dir, "x.lock")), "someone else's lock is left alone")
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
