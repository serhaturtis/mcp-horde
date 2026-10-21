import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, test } from "node:test"
import { Board } from "@mcp-horde/board"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { areasOf, kindOf, outcomesOf, renderStats, stats, suggest, suggestTiers } from "../src/lib.js"

const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "horde-ledger-")))
const pkg = path.join(import.meta.dirname, "..")
const tiers = [{ model: "cheap/flash" }, { model: "mid/kimi" }, { model: "big/glm", variant: "high" }]

/** One finished attempt on a new task: worked by `model`, then accepted or failed. */
async function history(board: Board, title: string, scope: string[], model: string, accepted: boolean, cost = 0.1, tier = 0) {
  const t = (await board.plan([{ title, goal: title, scope, tier }])).tasks[0]!
  const { attempt } = await board.assign(t.id)
  await board.recordActivity(t.id, attempt.n, { cost, state: "idle", gate: accepted ? "pass 1/2" : "fail 2/2", model })
  if (accepted) await board.accept(t.id)
  else await board.fail(t.id, { reason: "gate failed twice", retry: false })
}

describe("ledger", () => {
  test("kinds and areas of work", () => {
    assert.equal(kindOf("Add tests for the parser"), "test")
    assert.equal(kindOf("Fix crash on empty input"), "fix")
    assert.equal(kindOf("Rename Foo to Bar"), "refactor")
    assert.equal(kindOf("Login rate limit", "Write the README section"), "docs")
    assert.equal(kindOf("Rate limiting for login"), "feature")
    assert.deepEqual(areasOf(["src/api/**", "src/api/login.ts", "test/api/deep/x/**", "README.md", "**"]), ["src/api", "test/api"])
  })

  test("statistics by model, with cost per accepted task and drift", async () => {
    const board = new Board(tmp())
    for (let i = 0; i < 4; i++) await history(board, `Add tests ${i}`, ["test/**"], "cheap/flash", true, 0.02)
    await history(board, "Refactor core", ["src/core/**"], "cheap/flash", false, 0.05)
    await history(board, "Refactor core again", ["src/core/**"], "mid/kimi", true, 0.4, 1)
    const outcomes = outcomesOf(board, "repo")
    assert.equal(outcomes.length, 6)
    assert.equal(outcomes[0]!.rounds, 1)
    const byModel = stats(outcomes, "model")
    assert.deepEqual(
      byModel.map((r) => [r.key, r.accepted, r.attempts]),
      [
        ["cheap/flash", 4, 5],
        ["mid/kimi", 1, 1],
      ],
    )
    assert.ok(Math.abs(byModel[0]!.costPerAccepted! - 0.13 / 4) < 1e-9, "failed attempts' cost counts against the accepted ones")
    const text = renderStats(byModel, "model", "repo")
    assert.match(text, /^By model, repo:\ncheap\/flash: 4\/5 accepted \(80%\) · 1\.0 gate rounds · \$0\.03 per accepted\nmid\/kimi: 1\/1/)
    assert.match(renderStats(stats(outcomes, "kind"), "kind", "repo"), /test: 4\/4[\s\S]*refactor: 1\/2/)
    // A model that got worse lately is flagged.
    const drifting = new Board(tmp())
    for (let i = 0; i < 10; i++) await history(drifting, `Feature ${i}`, ["src/**"], "cheap/flash", true)
    for (let i = 0; i < 8; i++) await history(drifting, `Feature late ${i}`, ["src/**"], "cheap/flash", i < 2)
    assert.match(renderStats(stats(outcomesOf(drifting), "model"), "model", "x"), /⚠ last 10: \d+%/)
  })

  test("the starting tier skips what similar work proved to fail, and only that", async () => {
    const board = new Board(tmp())
    await history(board, "Refactor the scheduler", ["src/core/sched/**"], "cheap/flash", false)
    await history(board, "Refactor the queue", ["src/core/queue.ts"], "cheap/flash", false)
    await history(board, "Refactor the pool", ["src/core/**"], "mid/kimi", true, 0.3, 1)
    await history(board, "Refactor the timer", ["src/core/**"], "mid/kimi", true, 0.3, 1)
    await history(board, "Add tests for api", ["test/api/**"], "cheap/flash", true)
    const outcomes = outcomesOf(board, "repo")
    assert.equal(suggest({ title: "Refactor the locks", scope: ["src/core/locks/**"] }, outcomes, [], "repo"), undefined, "no tiers listed: no tier to suggest")
    const s = suggest({ title: "Refactor the locks", scope: ["src/core/locks/**"] }, outcomes, tiers, "repo")
    assert.equal(s?.tier, 1)
    assert.equal(s?.model, "mid/kimi")
    assert.match(s!.why, /similar refactor work in src\/core failed on tier 0 \(cheap\/flash\): 0 of 2 similar attempts passed; on tier 1 \(mid\/kimi\) 2 of 2/)
    // Different work, or too little evidence: the default stands.
    assert.equal(suggest({ title: "Add tests for the cli", scope: ["test/cli/**"] }, outcomes, tiers, "repo"), undefined)
    assert.equal(suggest({ title: "Document the api", scope: ["docs/**"] }, outcomes, tiers, "repo"), undefined)
    // Another repository's history counts by kind only, at half weight.
    const elsewhere = suggest({ title: "Refactor the parser", scope: ["lib/**"] }, outcomesOf(board, "other"), tiers, "repo")
    assert.equal(elsewhere, undefined, "two failures elsewhere weigh less than the evidence threshold")
    // Tiers are matched by model, so reordering horde.json keeps the history meaningful.
    const reordered = [{ model: "mid/kimi" }, { model: "cheap/flash" }]
    assert.equal(suggest({ title: "Refactor the locks", scope: ["src/core/**"] }, outcomes, reordered, "repo"), undefined, "the good model is tier 0 now")
  })

  test("when every tier failed, the honest answer is the orchestrator", async () => {
    const board = new Board(tmp())
    for (const [m, t] of [
      ["cheap/flash", 0],
      ["cheap/flash", 0],
      ["mid/kimi", 1],
      ["mid/kimi", 1],
    ] as const)
      await history(board, "Fix the race in the cache", ["src/cache/**"], m, false, 0.1, t)
    const s = suggest({ title: "Fix the race in the store", scope: ["src/cache/**"] }, outcomesOf(board, "r"), tiers.slice(0, 2), "r")
    assert.equal(s?.tier, 2)
    assert.match(s!.why, /failed on every model tier/)
  })

  test("applying raises untried tasks only, never lowers", async () => {
    const board = new Board(tmp())
    await history(board, "Refactor a", ["src/core/**"], "cheap/flash", false)
    await history(board, "Refactor b", ["src/core/**"], "cheap/flash", false)
    const { tasks } = await board.plan([
      { title: "Refactor c", goal: "x", scope: ["src/core/**"] },
      { title: "Refactor d", goal: "x", scope: ["src/core/**"], tier: 2 },
      { title: "Write docs", goal: "x", scope: ["docs/**"] },
    ])
    const out = await suggestTiers(board, undefined, outcomesOf(board, "r"), tiers, { apply: true, repo: "r" })
    assert.match(out, new RegExp(`${tasks[0]!.id} "Refactor c": tier 1 \\(mid/kimi\\) → set`))
    assert.match(out, new RegExp(`${tasks[1]!.id} "Refactor d": tier 1 \\(mid/kimi\\) \\(already at or above it\\)`))
    assert.match(out, new RegExp(`${tasks[2]!.id} "Write docs": tier 0 stands`))
    assert.deepEqual(
      tasks.map((t) => board.task(t.id).tier),
      [1, 2, 0],
    )
  })

  test("MCP server over stdio", async () => {
    const root = tmp()
    const repo = path.join(root, "repo")
    fs.mkdirSync(repo)
    execFileSync("git", ["init", "-q"], { cwd: repo })
    fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify({ tiers: ["cheap/flash", "mid/kimi"] }))
    const state = path.join(root, "state")
    const board = await Board.open(repo, state)
    await history(board, "Refactor a", ["src/core/**"], "cheap/flash", false)
    await history(board, "Refactor b", ["src/core/**"], "cheap/flash", false)
    const client = new Client({ name: "test", version: "0" })
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--conditions=source", "--import", "tsx", path.join(pkg, "src", "index.ts")],
        cwd: pkg,
        env: { ...(process.env as Record<string, string>), HORDE_LEDGER_DIRECTORY: repo, HORDE_BOARD_STATE_DIR: state },
        stderr: "inherit",
      }),
    )
    try {
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
        assert.ok(!r.isError, r.content[0]!.text)
        return r.content[0]!.text
      }
      assert.match(await call("ledger_stats"), /cheap\/flash: 0\/2 accepted/)
      assert.match(await call("ledger_suggest", { draft: { title: "Refactor c", scope: ["src/core/x.ts"] } }), /^tier 1 \(mid\/kimi\): similar refactor work/)
      assert.match(await call("ledger_suggest", { draft: { title: "Add docs" } }), /^tier 0: no evidence/)
    } finally {
      await client.close()
    }
  })
})
