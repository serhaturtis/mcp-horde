import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, test } from "node:test"
import { formatTokens, formatUsd, truncate, truncateHead } from "@mcp-horde/core"
import type { FormInfo, SessionInboxInfo, SessionMessageInfo } from "@opencode/client"
import { extractJson, validate } from "../src/ask.js"
import { type Backend, isLoopback, shimTarget } from "../src/backend.js"
import { type Config, defaultMaxRunning, loadConfig } from "../src/config.js"
import {
  defaultQuestionPolicy,
  defined,
  dismissAnswer,
  Fleet,
  formAnswer,
  formatModel,
  type GateView,
  type Hooks,
  parseModel,
  waitedOut,
} from "../src/fleet.js"
import { questionAnswers, questionSchema } from "../src/hooks.js"
import { busyRefusal, gateProgress } from "../src/horde.js"
import { News } from "../src/news.js"
import { type AgentRecord, Store } from "../src/state.js"
import { price } from "../src/tools.js"
import { buildTrack, costSince, currentTurn, latestTool, stablePrefix, turnsSince } from "../src/tracker.js"
import {
  branchSlug,
  commitMsgHook,
  createWorktree,
  hasUncommitted,
  landSync,
  mergeWorktree,
  squashWorktree,
  syncWorktree,
  validateLink,
  type Worktree,
  workStart,
} from "../src/worktree.js"
import { pkg } from "./harness.js"
// Fixes from the support-module audit (hooks, tracker, worktree, backend, supervisor, ask, config).
import "./support-fixes.test.js"

let clock = 1000
type Msg = SessionMessageInfo
const user = (id: string, text: string): Msg => ({ id, type: "user", text, time: { created: ++clock } })
const idle = (id: string, outcome: "succeeded" | "failed" | "interrupted", error?: { type: string; message: string; status?: number }): Msg => ({
  id,
  type: "idle",
  outcome,
  ...(error ? { error } : {}),
  time: { created: ++clock },
})
const step = (
  id: string,
  o: {
    text?: string
    finish?: "stop" | "tool-calls"
    cost?: number
    tokens?: { input: number; output: number; reasoning?: number; cache?: { read: number; write: number } }
    tools?: { id: string; name: string; status: "running" | "completed" }[]
    open?: boolean
    model?: string
  } = {},
): Msg => {
  const created = ++clock
  return {
    id,
    type: "assistant",
    agent: "build",
    model: { id: o.model ?? "m", providerID: "p" },
    content: [
      ...(o.text ? [{ type: "text" as const, text: o.text }] : []),
      ...(o.tools ?? []).map((t) => ({
        type: "tool" as const,
        id: t.id,
        name: t.name,
        time: { created },
        state:
          t.status === "running"
            ? { status: "running" as const, input: { command: "ls" }, metadata: {} }
            : { status: "completed" as const, input: {}, content: [{ type: "text" as const, text: "ok" }] as [{ type: "text"; text: string }] },
      })),
    ],
    finish: o.open ? undefined : (o.finish ?? "stop"),
    cost: o.cost ?? 0,
    tokens: { reasoning: 0, cache: { read: 0, write: 0 }, ...(o.tokens ?? { input: 0, output: 0 }) },
    time: { created, ...(o.open ? {} : { completed: created }) },
  } as Msg
}

describe("tracker", () => {
  test("a simple turn: prompt, answer, idle marker", () => {
    const t = buildTrack([
      user("m1", "hi"),
      step("a1", { text: "hello", cost: 0.5, tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 3 } } }),
      idle("i1", "succeeded"),
    ])
    assert.equal(t.inLoop, false)
    const turn = currentTurn(t)!
    assert.equal(turn.prompt, "hi")
    assert.equal(turn.finalText, "hello")
    assert.equal(turn.steps, 1)
    assert.ok(turn.endedAt)
    assert.deepEqual(turn.messageIDs, ["m1", "a1"])
    assert.equal(t.cost, 0.5)
    assert.deepEqual(t.tokens, { input: 10, output: 5, reasoning: 1, cacheRead: 2, cacheWrite: 3 })
    assert.equal(t.model?.providerID, "p")
    assert.equal(t.agent, "build")
    assert.ok(t.ids.has("i1"))
  })

  test("tool steps keep the turn open until the idle marker; the last text is the answer", () => {
    const msgs = [
      user("m1", "do it"),
      step("a1", { text: "let me check", finish: "tool-calls", tools: [{ id: "c1", name: "shell", status: "completed" }] }),
      step("a2", { text: "done" }),
    ]
    const running = buildTrack(msgs)
    assert.equal(running.inLoop, true, "no idle marker yet")
    assert.equal(currentTurn(running)!.endedAt, undefined)
    const t = buildTrack([...msgs, idle("i1", "succeeded")])
    assert.equal(currentTurn(t)!.finalText, "done")
    assert.equal(currentTurn(t)!.steps, 2)
  })

  test("a prompt during a run joins it; one after the idle marker starts a new turn", () => {
    const t = buildTrack([user("m1", "first"), step("a1"), user("m2", "also this"), step("a2"), idle("i1", "succeeded")])
    assert.equal(t.turns.length, 1)
    assert.equal(currentTurn(t)!.prompt, "first\n[steer] also this")
    const before = t.seq
    const next = buildTrack([...t.messages, user("m3", "second")])
    assert.equal(next.turns.length, 2)
    assert.deepEqual(
      turnsSince(next, before).map((x) => x.prompt),
      ["second"],
    )
  })

  test("failures carry the provider's status; interrupts are marked", () => {
    const failed = buildTrack([user("m1", "x"), step("a1"), idle("i1", "failed", { type: "provider.invalid-request", message: "bad request", status: 400 })])
    assert.equal(currentTurn(failed)!.failure, "bad request (HTTP 400)")
    assert.equal(currentTurn(failed)!.interrupted, undefined)
    const stopped = buildTrack([user("m1", "x"), step("a1", { open: false }), idle("i1", "interrupted")])
    assert.equal(currentTurn(stopped)!.interrupted, true)
    assert.equal(currentTurn(stopped)!.failure, "interrupted")
  })

  test("the open step's running tools are tracked separately", () => {
    const t = buildTrack([
      user("m1", "x"),
      step("a1", {
        open: true,
        tools: [
          { id: "a", name: "read", status: "running" },
          { id: "b", name: "grep", status: "running" },
          { id: "c", name: "glob", status: "completed" },
        ],
      }),
    ])
    assert.equal(t.stepOpen, true)
    assert.deepEqual([...t.openTools.keys()], ["a", "b"])
    assert.equal(latestTool(t)?.tool, "grep")
    assert.equal(buildTrack([...t.messages.slice(0, 1), step("a1")]).openTools.size, 0, "a completed step has none")
  })

  test("prompts waiting in the inbox are admitted, not started", () => {
    const inbox = [{ id: "q1", sessionID: "s", type: "user", time: { created: 5000 }, payload: { text: "later" }, delivery: "queue" }] as SessionInboxInfo[]
    const t = buildTrack([user("m1", "x"), step("a1", { open: true })], inbox)
    assert.deepEqual([...t.admitted.keys()], ["q1"])
    assert.equal(t.admitted.get("q1")?.delivery, "queue")
    assert.equal(t.seq, 5000)
  })

  test("free steps are priced by the estimator; a reported cost wins; limits see cost by time", () => {
    const estimate = (m: { id: string }, tok: { input: number; output: number }) => (m.id === "paid" ? (tok.input + tok.output) / 100 : undefined)
    const first = [user("m1", "x"), step("a1", { model: "paid", tokens: { input: 10, output: 5 } }), idle("i1", "succeeded")]
    const since = clock + 1
    const t = buildTrack(
      [...first, user("m2", "y"), step("a2", { model: "paid", cost: 2, tokens: { input: 10, output: 5 } }), idle("i2", "succeeded")],
      [],
      estimate,
    )
    assert.equal(t.cost, 2.15)
    assert.equal(costSince(t, since), 2)
  })

  test("compactions reset the context; only what follows the last idle marker is re-read", () => {
    const msgs = [user("m1", "a"), step("a1", { tokens: { input: 100, output: 10, reasoning: 1000, cache: { read: 5, write: 0 } } }), idle("i1", "succeeded")]
    assert.equal(buildTrack(msgs).context, 115, "reasoning is not resent")
    const compacted = buildTrack([
      ...msgs,
      { id: "c1", type: "compaction", status: "completed", reason: "manual", summary: "s", time: { created: ++clock } } as Msg,
    ])
    assert.equal(compacted.compactions, 1)
    assert.equal(compacted.context, undefined)
    assert.equal(stablePrefix(compacted.messages), 3)
    assert.equal(stablePrefix([user("m1", "a")]), 0)
  })
})

describe("helpers", () => {
  test("ask: JSON is found in replies and checked against a schema", () => {
    assert.deepEqual(extractJson('{"a": 1}').value, { a: 1 })
    assert.deepEqual(extractJson("Sure:\n```json\n[1, 2]\n```").value, [1, 2])
    assert.deepEqual(extractJson('The answer is {"ok": true}.').value, { ok: true })
    assert.equal(extractJson("no json here").error, "the reply is not JSON")
    const schema = {
      type: "object",
      properties: {
        verdict: { enum: ["a", "b"] },
        score: { type: "integer", minimum: 0, maximum: 10 },
        tags: { type: "array", items: { type: "string" }, maxItems: 2 },
      },
      required: ["verdict", "score"],
      additionalProperties: false,
    }
    assert.deepEqual(validate({ verdict: "a", score: 3, tags: ["x"] }, schema), [])
    assert.deepEqual(validate({ verdict: "c", score: 11, tags: ["x", 1, "z"], extra: 1 }, schema), [
      '$.verdict: must be one of ["a","b"]',
      "$.score: must be at most 10",
      "$.tags: allows at most 2 items",
      "$.tags[1]: expected string, got integer",
      "$.extra: not allowed",
    ])
    assert.deepEqual(validate({ verdict: "a" }, schema), ["$.score: required"])
    assert.deepEqual(validate("x", { type: "object" }), ["$: expected object, got string"])
    assert.deepEqual(validate(2.5, { type: "number" }), [])
  })

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
      id: "frm_q",
      sessionID: "s",
      title: "Questions",
      fields: [
        {
          key: "q0",
          type: "string",
          description: "Pick one",
          options: [
            { value: "A", label: "A", description: "first" },
            { value: "B", label: "B" },
          ],
          custom: false,
        },
        {
          key: "q1",
          type: "multiselect",
          description: "Pick many",
          options: [
            { value: "x, y", label: "x, y" },
            { value: "z", label: "z" },
          ],
        },
        { key: "q2", type: "string", description: "Free text" },
      ],
    } as unknown as FormInfo
    const { properties, required } = questionSchema(req)
    assert.deepEqual(required, ["q0", "q2_text"])
    assert.deepEqual((properties.q0 as { oneOf: unknown[] }).oneOf, [
      { const: "A", title: "A — first" },
      { const: "B", title: "B" },
    ])
    assert.equal(properties.q0_text, undefined, "no free text when custom answers are off")
    assert.equal((properties.q1 as { type: string }).type, "array")
    assert.ok(properties.q1_text)
    // Values with commas survive multi-select; free text wins over a choice.
    assert.deepEqual(questionAnswers(req, { q0: "B", q1: ["x, y", "z"], q1_text: "", q2_text: " mine " }), { q0: "B", q1: ["x, y", "z"], q2: "mine" })
    assert.deepEqual(questionAnswers(req, undefined), {})
    // The caller answers by label, per field; "dismiss" leaves the choice to the agent where it can.
    assert.deepEqual(formAnswer(req, [["B"], ["z"], ["free"]]), { q0: "B", q1: ["z"], q2: "free" })
    const dismissed = dismissAnswer(req)
    assert.equal(dismissed.q0, "A", "no custom answers: the first option")
    assert.match(String(dismissed.q2), /No preference/)
  })

  test("formatting", () => {
    assert.equal(truncate("abcdef", 100), "abcdef")
    assert.match(truncateHead("x".repeat(100), 10), /90 earlier chars omitted/)
    assert.equal(formatUsd(0), "$0")
    assert.equal(formatUsd(0.004), "$0.0040")
    assert.equal(formatTokens(15_200), "15.2k")
  })

  test("config parsing and validation", () => {
    const c = loadConfig({ HOME: "/home/u", HORDE_OPENCODE_DIRECTORY: "/work" } as NodeJS.ProcessEnv, { cores: 16 })
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

  test("the running-agent limit comes from the environment, else horde.json, else the core count", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "horde-limit-"))
    fs.mkdirSync(path.join(dir, ".git"))
    const at = (env: Record<string, string> = {}) => loadConfig({ HORDE_OPENCODE_DIRECTORY: dir, ...env } as NodeJS.ProcessEnv, { cores: 16 })
    assert.equal(at().maxRunning, 8)
    fs.writeFileSync(path.join(dir, "horde.json"), JSON.stringify({ opencode: { maxRunning: 3 } }))
    assert.deepEqual([at().maxRunning, at().maxRunningFrom], [3, "horde.json opencode.maxRunning"])
    assert.equal(at({ HORDE_OPENCODE_MAX_RUNNING: "0" }).maxRunning, 0, "the environment wins; 0 is unlimited")
    fs.writeFileSync(path.join(dir, "horde.json"), JSON.stringify({ opencode: { maxRunning: "lots" } }))
    assert.throws(() => at(), /"opencode\.maxRunning" must be a non-negative integer/)
    fs.writeFileSync(path.join(dir, "horde.json"), JSON.stringify({ opencode: 4 }))
    assert.throws(() => at(), /"opencode" must be an object/)
  })

  test("the default running limit is one task per two cores, between 2 and 8", () => {
    assert.deepEqual([1, 2, 4, 6, 8, 12, 16, 64].map(defaultMaxRunning), [2, 2, 2, 3, 4, 6, 8, 8])
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "horde-limit-cores-"))
    fs.mkdirSync(path.join(dir, ".git"))
    const at = (cores: number) => loadConfig({ HORDE_OPENCODE_DIRECTORY: dir } as NodeJS.ProcessEnv, { cores })
    assert.deepEqual([at(4).maxRunning, at(4).maxRunningFrom], [2, "default"])
    assert.equal(at(64).maxRunning, 8)
    fs.writeFileSync(path.join(dir, "horde.json"), JSON.stringify({ opencode: { maxRunning: 3 } }))
    assert.equal(at(4).maxRunning, 3, "an explicit horde.json limit wins over the cores")
  })

  test("the running-agent limit falls back to the user-level horde.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "horde-limit-user-"))
    fs.mkdirSync(path.join(dir, ".git"))
    const config = fs.mkdtempSync(path.join(os.tmpdir(), "horde-config-"))
    const userFile = path.join(config, "mcp-horde", "horde.json")
    fs.mkdirSync(path.dirname(userFile), { recursive: true })
    fs.writeFileSync(userFile, JSON.stringify({ opencode: { maxRunning: 5 }, tiers: ["deepseek/deepseek-flash"], workers: { setup: "echo ignored" } }))
    const xdg = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = config
    const at = (env: Record<string, string> = {}) => loadConfig({ HORDE_OPENCODE_DIRECTORY: dir, ...env } as NodeJS.ProcessEnv, { cores: 16 })
    try {
      assert.deepEqual([at().maxRunning, at().maxRunningFrom], [5, `${userFile} opencode.maxRunning`])
      fs.writeFileSync(path.join(dir, "horde.json"), JSON.stringify({ opencode: { maxRunning: 3 } }))
      assert.deepEqual([at().maxRunning, at().maxRunningFrom], [3, "horde.json opencode.maxRunning"], "the repository wins")
      assert.equal(at({ HORDE_OPENCODE_MAX_RUNNING: "1" }).maxRunning, 1, "the environment wins")
      fs.unlinkSync(path.join(dir, "horde.json"))
      fs.writeFileSync(userFile, "{ nope")
      assert.throws(
        () => at(),
        (err: Error) => err.message.includes(userFile) && /not valid JSON/.test(err.message),
      )
      fs.writeFileSync(userFile, JSON.stringify({ opencode: { maxRunning: "lots" } }))
      assert.throws(
        () => at(),
        (err: Error) => err.message.includes(userFile) && /"opencode\.maxRunning"/.test(err.message),
      )
      fs.writeFileSync(userFile, JSON.stringify({ tiers: ["deepseek/deepseek-flash"] }))
      assert.deepEqual([at().maxRunning, at().maxRunningFrom], [8, "default"], "keys other than opencode are ignored")
    } finally {
      if (xdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = xdg
    }
  })

  test("a loaded machine refuses a start, naming the load and the running tasks", () => {
    assert.equal(busyRefusal({ load: 8, cores: 16, running: [] }), undefined, "below the core count")
    const refusal = busyRefusal({ load: 20.4, cores: 16, running: ["t-aaaa", "t-bbbb"] })!
    assert.match(refusal, /1-minute load average is 20\.40 over 16 core\(s\)/)
    assert.match(refusal, /2 task\(s\) are running \(t-aaaa, t-bbbb\)/)
    assert.match(refusal, /"opencode": \{"maxRunning": N\} in horde\.json/)
    assert.match(busyRefusal({ load: 3, cores: 2, running: [] })!, /no task of this session is running/)
  })

  test("a running gate says which check is running, or the slot it waits for", () => {
    const now = Date.now()
    const running = (extra: Partial<GateView>): GateView => ({ state: "running", round: 2, maxRounds: 2, ...extra })
    assert.equal(gateProgress(running({ check: { name: "test", since: now - 200_000 } }), now), "gate round 2: test running for 3m20s")
    assert.equal(
      gateProgress(running({ waiting: { check: "test", slot: "check-test", holder: "t-1234", since: now - 240_000 } }), now),
      "gate round 2: waiting for the test slot held by t-1234 for 4m00s",
    )
    assert.equal(
      gateProgress(running({ waiting: { check: "test", slot: "check-test", holder: "pid 42", since: now - 60_000 } }), now),
      "gate round 2: waiting for the test slot held by pid 42 for 1m00s",
    )
    assert.equal(gateProgress({ state: "pass", round: 2, maxRounds: 2 }, now), undefined)
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

  test("a record whose worktree directory is gone is dropped", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "horde-state-gone-"))
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "horde-worktree-"))
    const store = new Store(dir)
    const record: AgentRecord = {
      id: "ses_gone",
      server: "local",
      directory: worktree,
      policy: "user",
      questions: "user",
      worktree: { path: worktree, root: worktree, branch: "horde/x", base: "0".repeat(40), repo: "/w" },
      limits: {},
      createdAt: 1,
      reportedSeq: 0,
    }
    store.put(record)
    assert.deepEqual(
      store.agents("local").map((r) => r.id),
      ["ses_gone"],
    )
    fs.rmSync(worktree, { recursive: true, force: true })
    assert.deepEqual(store.agents("local"), [], "a removed worktree leaves no stale agent")
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("a backend restart keeps the news file; a deliberate close removes it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "horde-news-restart-"))
    const store = new Store(dir)
    const news = new News(dir, "restart")
    const file = path.join(dir, "news", "restart.json")
    news.update([{ id: "t-1", title: "waits", kind: "finished" }], [])
    for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 10))
    assert.ok(fs.existsSync(file), "the news file was written")
    const backend = {
      client: {},
      info: { key: "local" },
      events: new EventEmitter(),
      streaming: false,
      dead: true,
    } as unknown as Backend
    const config: Config = {
      username: "opencode",
      allowInsecure: false,
      serverMode: "shared",
      bin: "opencode",
      directory: dir,
      defaultPermissions: "ask",
      maxRunning: 0,
      maxRunningFrom: "test",
      stateDir: dir,
      worktreeDir: path.join(dir, "worktrees"),
      channel: false,
      elicitTimeoutMs: 1_000,
    }
    const hooks: Hooks = {
      canElicit: () => false,
      askPermission: async () => undefined,
      askQuestion: async () => undefined,
      settled: () => {},
    }
    const fleet = new Fleet(backend, config, store, hooks, news)
    await fleet.close({ keepNews: true })
    assert.ok(fs.existsSync(file), "a restart keeps the outcome the hook still has to report")
    await fleet.close()
    assert.equal(fs.existsSync(file), false, "a deliberate shutdown removes it")
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

test("waitedOut: a read that failed once is retried; one unreadable for a minute ends the wait", () => {
  const now = 1_000_000
  assert.equal(waitedOut(["a"], new Set(), new Map([["a", now]]), now), false, "the first failed read")
  assert.equal(waitedOut(["a"], new Set(), new Map([["a", now - 59_000]]), now), false)
  assert.equal(waitedOut(["a"], new Set(), new Map([["a", now - 60_000]]), now), true)
  assert.equal(waitedOut(["a", "b"], new Set(["b"]), new Map(), now), false, "a is still working")
  assert.equal(waitedOut(["a", "b"], new Set(["a", "b"]), new Map(), now), true)
})

describe("landing as one commit: squash and the repository's commit-msg hook", () => {
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd })
      .toString()
      .trim()
  const makeRepo = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "horde-squash-"))
    gitIn(dir, "init", "-q")
    fs.writeFileSync(path.join(dir, "a.txt"), "a\n")
    gitIn(dir, "add", "-A")
    gitIn(dir, "commit", "-qm", "base")
    const wt: Worktree = { path: dir, root: dir, branch: gitIn(dir, "symbolic-ref", "--short", "HEAD"), base: gitIn(dir, "rev-parse", "HEAD"), repo: dir }
    fs.writeFileSync(path.join(dir, "b.txt"), "b\n")
    gitIn(dir, "add", "-A")
    gitIn(dir, "commit", "-qm", "baseline")
    wt.baseline = gitIn(dir, "rev-parse", "HEAD")
    fs.writeFileSync(path.join(dir, "own.txt"), "own\n")
    gitIn(dir, "add", "-A")
    gitIn(dir, "commit", "-qm", "own one")
    fs.writeFileSync(path.join(dir, "more.txt"), "more\n")
    gitIn(dir, "add", "-A")
    gitIn(dir, "commit", "-qm", "own two")
    return wt
  }
  const hookIn = (dir: string, body: string) => {
    const hooks = fs.mkdtempSync(path.join(os.tmpdir(), "horde-hooks-"))
    const hook = path.join(hooks, "commit-msg")
    fs.writeFileSync(hook, body)
    if (process.platform !== "win32") fs.chmodSync(hook, 0o755)
    gitIn(dir, "config", "core.hooksPath", hooks)
    return hook
  }

  test("the agent's own commits become one; the carried-over baseline stays out", async () => {
    const wt = makeRepo()
    assert.deepEqual(await squashWorktree(wt, "feat: the task"), {})
    assert.equal(gitIn(wt.root, "log", "-1", "--format=%s"), "feat: the task")
    assert.equal(gitIn(wt.root, "rev-list", "--count", `${wt.baseline!}..HEAD`), "1", "exactly the squashed commit")
    assert.equal(gitIn(wt.root, "rev-list", "--count", `${wt.base}..HEAD`), "2", "the baseline is kept separate")
    assert.equal(gitIn(wt.root, "merge-base", "--is-ancestor", wt.baseline!, "HEAD"), "", "the baseline is still its parent")
    assert.equal(fs.readFileSync(path.join(wt.root, "own.txt"), "utf8"), "own\n")
    assert.equal(fs.readFileSync(path.join(wt.root, "more.txt"), "utf8"), "more\n")
  })

  test("the hook sees the changes staged, refuses a message it rejects, and its edits are kept", async () => {
    const wt = makeRepo()
    gitIn(wt.root, "rm", "-q", "a.txt")
    gitIn(wt.root, "commit", "-qm", "drop a")
    const hook = hookIn(
      wt.root,
      '#!/bin/sh\nif git diff --cached --name-status | grep -q "^D"; then\n  grep -q "^DELETE:" "$1" || { echo "commit-msg: removing a file needs a DELETE: line" >&2; exit 1; }\nfi\nprintf "\\nCo-authored-by: commit-msg hook\\n" >> "$1"\n',
    )
    assert.equal(await commitMsgHook(wt.root), hook)
    const before = gitIn(wt.root, "rev-parse", "HEAD")
    const refused = await squashWorktree(wt, "feat: drop a file")
    assert.match(refused.refused ?? "", /removing a file needs a DELETE: line/)
    assert.equal(gitIn(wt.root, "rev-parse", "HEAD"), before, "the branch is back where it was")
    assert.equal(gitIn(wt.root, "status", "--porcelain"), "", "and nothing else changed")
    assert.deepEqual(await squashWorktree(wt, "DELETE: drop the stale file"), {})
    assert.equal(gitIn(wt.root, "log", "-1", "--format=%s"), "DELETE: drop the stale file")
    assert.match(gitIn(wt.root, "log", "-1", "--format=%B"), /Co-authored-by: commit-msg hook/, "the hook's trailer is kept")
    assert.equal(gitIn(wt.root, "rev-list", "--count", `${wt.baseline!}..HEAD`), "1")
  })

  test("commitMsgHook honours core.hooksPath and only counts an executable hook", async () => {
    const wt = makeRepo()
    const hooks = fs.mkdtempSync(path.join(os.tmpdir(), "horde-hooks-"))
    const hook = path.join(hooks, "commit-msg")
    fs.writeFileSync(hook, "#!/bin/sh\n")
    gitIn(wt.root, "config", "core.hooksPath", hooks)
    assert.equal(await commitMsgHook(wt.root), process.platform === "win32" ? hook : undefined, "a non-executable hook is ignored")
    if (process.platform !== "win32") {
      fs.chmodSync(hook, 0o755)
      assert.equal(await commitMsgHook(wt.root), hook)
    }
    // A relative core.hooksPath is resolved against the checkout, as git does.
    const local = path.join(wt.root, "hooks-here")
    fs.mkdirSync(local)
    fs.writeFileSync(path.join(local, "commit-msg"), "#!/bin/sh\n")
    if (process.platform !== "win32") fs.chmodSync(path.join(local, "commit-msg"), 0o755)
    gitIn(wt.root, "config", "core.hooksPath", "hooks-here")
    assert.equal(await commitMsgHook(wt.root), path.join(local, "commit-msg"))
    // Without one, nothing to run.
    gitIn(wt.root, "config", "--unset", "core.hooksPath")
    assert.equal(await commitMsgHook(wt.root), undefined)
  })
})

describe("landing keeps the checked commits: fast-forward or cherry-pick", () => {
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd })
      .toString()
      .trim()
  const makeRepo = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "horde-land-"))
    gitIn(dir, "init", "-q")
    fs.writeFileSync(path.join(dir, "a.txt"), "a\n")
    gitIn(dir, "add", "-A")
    gitIn(dir, "commit", "-qm", "base")
    return dir
  }
  const makeWorktree = async (repo: string, includeUncommitted = false) => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "horde-land-wt-"))
    const { worktree } = await createWorktree(repo, "task", { rootDir, includeUncommitted })
    return worktree
  }

  test("commits sitting directly on your HEAD are fast-forwarded, keeping their hashes", async () => {
    const repo = makeRepo()
    const wt = await makeWorktree(repo)
    for (const [name, message] of [
      ["b.txt", "worker one"],
      ["c.txt", "worker two"],
    ] as const) {
      fs.writeFileSync(path.join(wt.root, name), `${name}\n`)
      gitIn(wt.root, "add", "-A")
      gitIn(wt.root, "commit", "-qm", message)
    }
    const workerHead = gitIn(wt.root, "rev-parse", "HEAD")
    await syncWorktree(wt, "task")
    assert.equal(gitIn(repo, "rev-parse", "HEAD"), wt.base, "nothing moved: the work starts on your HEAD")
    await mergeWorktree(wt, "task", "merge")
    assert.equal(gitIn(repo, "rev-parse", "HEAD"), workerHead, "the landed commit is exactly the checked one")
    assert.equal(gitIn(repo, "log", "-2", "--format=%s"), "worker two\nworker one")
  })

  test("a carried-over baseline commit still lands by cherry-pick", async () => {
    const repo = makeRepo()
    fs.writeFileSync(path.join(repo, "carried.txt"), "carried\n")
    const wt = await makeWorktree(repo, true)
    assert.ok(wt.baseline, "the uncommitted change was snapshotted as the baseline")
    fs.writeFileSync(path.join(wt.root, "b.txt"), "b\n")
    gitIn(wt.root, "add", "-A")
    gitIn(wt.root, "commit", "-qm", "worker one")
    const workerHead = gitIn(wt.root, "rev-parse", "HEAD")
    await mergeWorktree(wt, "task", "merge")
    assert.notEqual(gitIn(repo, "rev-parse", "HEAD"), workerHead, "replayed, so a new hash")
    assert.equal(gitIn(repo, "log", "-1", "--format=%s"), "worker one")
    assert.equal(fs.readFileSync(path.join(repo, "b.txt"), "utf8"), "b\n")
    assert.equal(gitIn(repo, "show", "--format=", "--name-only", "HEAD"), "b.txt", "the baseline stayed out")
  })

  test("uncommitted changes that collide refuse the fast-forward and leave the checkout alone", async () => {
    const repo = makeRepo()
    const wt = await makeWorktree(repo)
    fs.writeFileSync(path.join(wt.root, "b.txt"), "worker\n")
    gitIn(wt.root, "add", "-A")
    gitIn(wt.root, "commit", "-qm", "worker one")
    fs.writeFileSync(path.join(repo, "b.txt"), "mine\n")
    const head = gitIn(repo, "rev-parse", "HEAD")
    await assert.rejects(mergeWorktree(wt, "task", "merge"), /your checkout is unchanged/)
    assert.equal(gitIn(repo, "rev-parse", "HEAD"), head)
    assert.equal(fs.readFileSync(path.join(repo, "b.txt"), "utf8"), "mine\n")
    assert.equal(gitIn(repo, "status", "--porcelain"), "?? b.txt")
  })

  test("hasUncommitted sees untracked and tracked work", async () => {
    const repo = makeRepo()
    const wt = await makeWorktree(repo)
    assert.equal(await hasUncommitted(wt), false)
    fs.writeFileSync(path.join(wt.root, "new.txt"), "new\n")
    assert.equal(await hasUncommitted(wt), true)
    fs.writeFileSync(path.join(wt.root, "a.txt"), "changed\n")
    assert.equal(await hasUncommitted(wt), true)
  })
})

describe("landing rebases the task's own commits onto the tip, leaving the baseline out", () => {
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd })
      .toString()
      .trim()
  const makeRepo = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "horde-land-sync-"))
    gitIn(dir, "init", "-q")
    fs.writeFileSync(path.join(dir, "a.txt"), "a\n")
    gitIn(dir, "add", "-A")
    gitIn(dir, "commit", "-qm", "base")
    return dir
  }
  const makeWorktree = async (repo: string, includeUncommitted = false) => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "horde-land-sync-wt-"))
    const { worktree } = await createWorktree(repo, "task", { rootDir, includeUncommitted })
    return worktree
  }

  test("the carried-over baseline is left out even when the branch has not moved", async () => {
    const repo = makeRepo()
    fs.writeFileSync(path.join(repo, "carried.txt"), "carried\n")
    const wt = await makeWorktree(repo, true)
    assert.ok(wt.baseline, "the uncommitted change was snapshotted as the baseline")
    fs.writeFileSync(path.join(wt.root, "b.txt"), "b\n")
    gitIn(wt.root, "add", "-A")
    gitIn(wt.root, "commit", "-qm", "worker one")
    const synced = (await landSync(wt, "task")).worktree!
    assert.equal(synced.baseline, undefined)
    assert.equal(workStart(synced), wt.base, "the work now sits directly on the tip")
    assert.equal(gitIn(wt.root, "show", "--name-only", "--format=", "HEAD"), "b.txt", "the baseline stayed out of the landed tree")
  })

  test("a tip that is an ancestor of the base rebases the work onto that branch", async () => {
    const repo = makeRepo()
    fs.writeFileSync(path.join(repo, "b.txt"), "b\n")
    gitIn(repo, "add", "-A")
    gitIn(repo, "commit", "-qm", "second")
    const ancestor = gitIn(repo, "rev-parse", "HEAD~1")
    const wt = await makeWorktree(repo)
    fs.writeFileSync(path.join(wt.root, "c.txt"), "c\n")
    gitIn(wt.root, "add", "-A")
    gitIn(wt.root, "commit", "-qm", "worker one")
    // The user switches back to an older commit: an ancestor of the task's base.
    gitIn(repo, "reset", "--hard", ancestor)
    const synced = (await landSync(wt, "task")).worktree!
    assert.equal(synced.base, ancestor)
    assert.equal(gitIn(wt.root, "log", "-1", "--format=%s"), "worker one")
    assert.equal(gitIn(wt.root, "show", "--name-only", "--format=", "HEAD"), "c.txt")
    assert.ok(!fs.existsSync(path.join(wt.root, "b.txt")), "the older tip's tree does not have b.txt")
  })
})

describe("createWorktree runs the setup at the worktree's repository root", () => {
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd })
      .toString()
      .trim()

  test("a setup from a subdirectory writes root-relative files at the root", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "horde-setup-"))
    gitIn(repo, "init", "-q")
    const sub = path.join(repo, "packages", "app")
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(path.join(sub, "a.txt"), "a\n")
    gitIn(repo, "add", "-A")
    gitIn(repo, "commit", "-qm", "base")
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "horde-setup-wt-"))
    const { worktree } = await createWorktree(sub, "setup", { rootDir, includeUncommitted: false, setup: "touch root-setup.txt" })
    assert.equal(worktree.path, path.join(worktree.root, "packages", "app"))
    assert.ok(fs.existsSync(path.join(worktree.root, "root-setup.txt")), "the setup ran at the worktree root")
    assert.ok(!fs.existsSync(path.join(worktree.path, "root-setup.txt")), "not in the session's subdirectory")
  })
})

describe("the private supervisor outlives a kill of its parent's process group", () => {
  const posixOnly = { skip: process.platform === "win32" ? "POSIX process groups" : false }
  const supervisorJs = path.join(pkg, "dist", "supervisor.js")
  const supervisorTs = path.join(pkg, "src", "supervisor.ts")

  // A parent like spawnPrivate: supervisor in its own group, stdin as a lifeline,
  // and an exit handler that stops it. The fake server is a node script that sleeps.
  const fixture = (dir: string) => {
    const pidFile = path.join(dir, "fake.pid")
    const fake = path.join(dir, "fake-server.mjs")
    fs.writeFileSync(fake, `import fs from "node:fs"\nfs.writeFileSync(process.env.FAKE_PID_FILE, String(process.pid))\nsetInterval(() => {}, 1000)\n`)
    const parent = path.join(dir, "parent.mjs")
    fs.writeFileSync(
      parent,
      `import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const [supervisorJs, supervisorTs, fake, pidFile, mode] = process.argv.slice(2)
const supervisor = fs.existsSync(supervisorJs) ? [supervisorJs] : [...process.execArgv, supervisorTs]
const proc = spawn(process.execPath, [...supervisor, String(process.pid), process.execPath, fake], {
  cwd: path.dirname(supervisorTs),
  env: { ...process.env, FAKE_PID_FILE: pidFile },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  detached: process.platform !== "win32",
})
const killChild = () => {
  if (proc.exitCode !== null) return
  try {
    process.kill(proc.pid, "SIGTERM")
  } catch {
    // already gone
  }
}
process.once("exit", killChild)
process.on("SIGTERM", () => process.exit(0))
const watch = setInterval(() => {
  if (!fs.existsSync(pidFile)) return
  clearInterval(watch)
  if (mode === "normal") process.exit(0)
}, 50)
setInterval(() => {}, 1000)
`,
    )
    return { pidFile, parent, fake }
  }

  const start = async (dir: string, mode: "group-kill" | "normal") => {
    const f = fixture(dir)
    const parent = spawn(process.execPath, ["--import", "tsx", f.parent, supervisorJs, supervisorTs, f.fake, f.pidFile, mode], {
      cwd: pkg,
      detached: true,
      stdio: ["ignore", "ignore", "inherit"],
    })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      parent.once("exit", (code, signal) => resolve({ code, signal })),
    )
    const deadline = Date.now() + 20_000
    while (!fs.existsSync(f.pidFile)) {
      if (Date.now() > deadline) throw new Error("the fake server never started")
      await new Promise((r) => setTimeout(r, 50))
    }
    return { parent, exited, fakePid: Number(fs.readFileSync(f.pidFile, "utf8")) }
  }

  const gone = async (pid: number, ms: number) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0)
      } catch {
        return true
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    return false
  }

  const cleanup = (parent: ReturnType<typeof spawn>, fakePid: number) => {
    try {
      if (parent.pid) process.kill(-parent.pid, "SIGKILL")
    } catch {
      // already gone
    }
    try {
      process.kill(fakePid, "SIGKILL")
    } catch {
      // already gone
    }
  }

  test("SIGKILL of the parent's group leaves it to stop the server", posixOnly, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "horde-supervisor-kill-"))
    const { parent, exited, fakePid } = await start(dir, "group-kill")
    try {
      process.kill(-parent.pid!, "SIGKILL")
      await exited
      assert.equal(await gone(fakePid, 5_000), true, "the fake server was stopped")
    } finally {
      cleanup(parent, fakePid)
    }
  })

  test("a normal parent exit stops the server without hanging", posixOnly, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "horde-supervisor-exit-"))
    const { parent, exited, fakePid } = await start(dir, "normal")
    try {
      assert.equal((await exited).code, 0, "the parent exited normally")
      assert.equal(await gone(fakePid, 5_000), true, "the fake server was stopped")
    } finally {
      cleanup(parent, fakePid)
    }
  })
})
