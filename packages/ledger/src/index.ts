#!/usr/bin/env node
import path from "node:path"
import { Board, defaultStateRoot } from "@mcp-horde/board"
import { loadTiers, packageVersion } from "@mcp-horde/core"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { allBoards, type Outcome, outcomesOf, renderStats, stats, suggest, suggestTiers } from "./ledger.js"

const VERSION = packageVersion(import.meta.url)

process.on("unhandledRejection", (err) => {
  process.stderr.write(`[mcp-horde/ledger] unhandled rejection: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
})

const DEFAULT_DIR = path.resolve(process.env.HORDE_LEDGER_DIRECTORY || process.env.HORDE_BOARD_DIRECTORY || process.cwd())
const STATE_ROOT = defaultStateRoot()

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] })
const fail = (err: unknown): CallToolResult => ({
  content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
})

export const INSTRUCTIONS = `ledger: what the boards' history says about your worker models (read-only, except applying tier suggestions).
- After board_plan: ledger_suggest {apply: true} starts each new task on the cheapest tier that similar work has not shown to fail (it never lowers a tier you set).
- ledger_stats: pass rate, gate rounds and cost per accepted task by model, tier, kind of work, area or repository; flags a model whose recent pass rate dropped.
It learns from accepted and failed attempts (task-bound spawns record their model), so it says little until a few tasks have closed.`

const server = new McpServer({ name: "ledger", version: VERSION }, { instructions: INSTRUCTIONS })

const directory = z.string().optional().describe("Repository whose board to use (default: the server's directory).")

/** Outcomes of this repository's board, plus every other board's when `all` (cross-repository evidence counts by kind only). */
async function load(dir: string | undefined, all: boolean) {
  const repoDir = dir ? path.resolve(DEFAULT_DIR, dir) : DEFAULT_DIR
  const board = await Board.open(repoDir, STATE_ROOT)
  const repo = path.basename(board.dir)
  const boards = all ? allBoards(STATE_ROOT) : [board]
  if (!boards.some((b) => path.basename(b.dir) === repo)) boards.push(board)
  const outcomes: Outcome[] = boards.flatMap((b) => outcomesOf(b))
  return { board, repo, repoDir, outcomes }
}

server.registerTool(
  "ledger_stats",
  {
    description:
      "How attempts went, grouped by model (default), tier, kind of work (test, fix, refactor, docs, build, feature), area (scope directories) or repository: accepted/attempts, mean gate rounds, cost per accepted task, and a warning when a model's latest attempts pass clearly less often than before.",
    inputSchema: {
      directory,
      by: z.enum(["model", "tier", "kind", "area", "repo"]).optional(),
      all_repos: z.boolean().optional().describe("Every repository's board, not just this one's (default false)."),
      since_days: z.number().positive().optional().describe("Only attempts closed in the last N days."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (a) => {
    try {
      const { outcomes, repo } = await load(a.directory, !!a.all_repos)
      const since = a.since_days ? Date.now() - a.since_days * 86_400_000 : 0
      const by = a.by ?? "model"
      const scope = `${a.all_repos ? "all repositories" : repo}${a.since_days ? `, last ${a.since_days} days` : ""}`
      return ok(
        renderStats(
          stats(
            outcomes.filter((o) => o.at >= since),
            by,
          ),
          by,
          scope,
        ),
      )
    } catch (err) {
      return fail(err)
    }
  },
)

server.registerTool(
  "ledger_suggest",
  {
    description:
      "The tier a task should start on: the cheapest one that similar work (same area of this repository, same kind of work; other repositories by kind) has not shown to fail, with the evidence. For board tasks (default: every open, untried task) or a draft not on the board yet. apply: true raises the tier of untried tasks to the suggestion (never lowers one).",
    inputSchema: {
      directory,
      ids: z.array(z.string()).optional().describe("Board task ids (default: open tasks with no attempt yet)."),
      draft: z
        .object({ title: z.string(), goal: z.string().optional(), scope: z.array(z.string()).optional() })
        .optional()
        .describe("A task you are about to plan, instead of board tasks."),
      apply: z.boolean().optional(),
      all_repos: z.boolean().optional().describe("Use every repository's history as well (default true)."),
    },
    annotations: { openWorldHint: false },
  },
  async (a) => {
    try {
      const { board, repo, repoDir, outcomes } = await load(a.directory, a.all_repos !== false)
      const tiers = loadTiers(repoDir)
      if (a.draft) {
        const s = suggest(a.draft, outcomes, tiers, repo)
        return ok(s ? `tier ${s.tier}${s.model ? ` (${s.model})` : ""}: ${s.why}` : "tier 0: no evidence against the cheapest tier for this kind of work.")
      }
      return ok(await suggestTiers(board, a.ids, outcomes, tiers, { apply: a.apply, repo }))
    } catch (err) {
      return fail(err)
    }
  },
)

await server.connect(new StdioServerTransport())
