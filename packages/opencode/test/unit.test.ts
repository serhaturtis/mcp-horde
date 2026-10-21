import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, test } from "node:test"
import { formatTokens, formatUsd, truncate, truncateHead } from "@mcp-horde/core"
import type { FormInfo, SessionInboxInfo, SessionMessageInfo } from "@opencode/client"
import { extractJson, validate } from "../src/ask.js"
import { isLoopback, shimTarget } from "../src/backend.js"
import { loadConfig } from "../src/config.js"
import { defaultQuestionPolicy, defined, dismissAnswer, formAnswer, formatModel, parseModel, waitedOut } from "../src/fleet.js"
import { questionAnswers, questionSchema } from "../src/hooks.js"
import { type AgentRecord, Store } from "../src/state.js"
import { price } from "../src/tools.js"
import { buildTrack, costSince, currentTurn, latestTool, stablePrefix, turnsSince } from "../src/tracker.js"
import { branchSlug, validateLink } from "../src/worktree.js"
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

  test("the running-agent limit comes from the environment, else horde.json, else 8", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "horde-limit-"))
    fs.mkdirSync(path.join(dir, ".git"))
    const at = (env: Record<string, string> = {}) => loadConfig({ HORDE_OPENCODE_DIRECTORY: dir, ...env } as NodeJS.ProcessEnv)
    assert.equal(at().maxRunning, 8)
    fs.writeFileSync(path.join(dir, "horde.json"), JSON.stringify({ opencode: { maxRunning: 3 } }))
    assert.deepEqual([at().maxRunning, at().maxRunningFrom], [3, "horde.json opencode.maxRunning"])
    assert.equal(at({ HORDE_OPENCODE_MAX_RUNNING: "0" }).maxRunning, 0, "the environment wins; 0 is unlimited")
    fs.writeFileSync(path.join(dir, "horde.json"), JSON.stringify({ opencode: { maxRunning: "lots" } }))
    assert.throws(() => at(), /"opencode\.maxRunning" must be a non-negative integer/)
    fs.writeFileSync(path.join(dir, "horde.json"), JSON.stringify({ opencode: 4 }))
    assert.throws(() => at(), /"opencode" must be an object/)
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
    const at = (env: Record<string, string> = {}) => loadConfig({ HORDE_OPENCODE_DIRECTORY: dir, ...env } as NodeJS.ProcessEnv)
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
