#!/usr/bin/env node
import path from "node:path"
import { loadSyntax } from "@mcp-horde/context"
import { loadTiers, packageVersion, tierLabel } from "@mcp-horde/core"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { Board, defaultStateRoot } from "./board.js"
import { renderBrief, renderNotes, renderSummary, renderTask } from "./render.js"

const VERSION = packageVersion(import.meta.url)

process.on("unhandledRejection", (err) => {
  process.stderr.write(`[mcp-horde/board] unhandled rejection: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
})

const DEFAULT_DIR = path.resolve(process.env.HORDE_BOARD_DIRECTORY || process.cwd())
const STATE_ROOT = defaultStateRoot()

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] })
const fail = (err: unknown): CallToolResult => ({
  content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
})

export const INSTRUCTIONS = `board: the shared task graph for you (the orchestrator) and your workers.
1. board_plan small tasks, each with a goal, observable acceptance criteria, a scope (paths) and dependencies.
2. For each task from board_next: board_brief starts an attempt and returns the worker prompt (with its reporting commands); pass it unchanged as the prompt of opencode_spawn (with gate and isolation "worktree").
3. Workers file a structured report; the task moves to review. Read the report (board_task), not the transcript, then board_accept or board_fail (retry, optionally escalate to the next tier).
4. board_summary is the one status call you need. Findings and project memory flow into later briefs automatically.`

const server = new McpServer({ name: "board", version: VERSION }, { instructions: INSTRUCTIONS })

const tool = <S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  run: (args: z.infer<z.ZodObject<S>>, board: Board, repo: string) => Promise<string>,
  readOnly = false,
) => {
  server.registerTool(name, { description, inputSchema: shape, annotations: { openWorldHint: false, readOnlyHint: readOnly } }, (async (
    args: z.infer<z.ZodObject<S>> & { directory?: string },
  ) => {
    try {
      const repo = args.directory ? path.resolve(DEFAULT_DIR, args.directory) : DEFAULT_DIR
      const board = await Board.open(repo, STATE_ROOT)
      return ok(await run(args, board, repo))
    } catch (err) {
      return fail(err)
    }
  }) as never)
}

const directory = z
  .string()
  .optional()
  .describe("Repository the board belongs to (default: the server's directory). Every worktree of a repository shares one board.")
const id = z.string().describe("Task id, e.g. t-3fa2.")
const strings = z.array(z.string())

tool(
  "board_plan",
  "Add tasks to the board. Small tasks with observable acceptance criteria and a scope work best; deps may name other tasks of the same plan by title. Warns about scopes that overlap between tasks that could run in parallel.",
  {
    directory,
    tasks: z
      .array(
        z.object({
          title: z.string(),
          goal: z.string().describe("What and why, one paragraph: this is the core of the worker's prompt."),
          acceptance: strings.optional().describe("Observable criteria; the gate checks what it can, you check the rest."),
          scope: strings.optional().describe('Paths or globs the task may change, e.g. ["src/auth/**", "test/auth/**"].'),
          deps: strings.optional().describe("Task ids, or titles of tasks in this plan, that must be done first."),
          tier: z.number().int().min(0).optional().describe('Starting model tier: an index into horde.json "tiers" (default 0, the cheapest).'),
          parent: z.string().optional().describe("Grouping, e.g. the feature this belongs to."),
        }),
      )
      .min(1),
  },
  async (a, board) => {
    const r = await board.plan(a.tasks)
    return [...r.tasks.map((t) => `${t.id} "${t.title}"${t.deps.length ? ` (after ${t.deps.join(", ")})` : ""}`), ...r.warnings.map((w) => `⚠ ${w}`)].join("\n")
  },
)

tool(
  "board_next",
  "Tasks that are ready to start: open, with every dependency done.",
  { directory, limit: z.number().int().min(1).max(50).optional() },
  async (a, board, repo) => {
    const ready = board.ready().slice(0, a.limit ?? 10)
    const tiers = loadTiers(repo)
    return ready.length
      ? ready.map((t) => `${t.id} "${t.title}" · ${tierLabel(t.tier, tiers)}${t.scope.length ? ` · ${t.scope.join(", ")}` : ""}`).join("\n")
      : "Nothing is ready."
  },
  true,
)

tool(
  "board_brief",
  "Start an attempt on a task and return the worker's prompt: goal, done criteria, scope, relevant findings and project notes, the exact commands it reports with (including a token for this attempt), and code context (the scoped files, symbols the goal names, the tests that cover the scope, the project's conventions). Pass it unchanged to opencode_spawn. A new brief for the same task ends any previous attempt.",
  {
    directory,
    id,
    agent: z.string().optional().describe("Name of the agent that will work it (shown in summaries)."),
    budget_tokens: z.number().int().min(500).max(30_000).optional().describe("Size limit for the brief (default 6000)."),
  },
  async (a, board, repo) => {
    const { task, attempt } = await board.assign(a.id, a.agent)
    return renderBrief(board, task, attempt, a.budget_tokens, repo)
  },
)

tool(
  "board_accept",
  "Mark a task done (after its gate passed and its report holds up). Releases its locks; dependent tasks become ready.",
  {
    directory,
    id,
    note: z.string().optional(),
    cost: z
      .number()
      .min(0)
      .optional()
      .describe("Cost of this attempt in USD, for the totals. Agents spawned with opencode_spawn task record theirs automatically; pass it only to override."),
  },
  async (a, board) => {
    const t = await board.accept(a.id, { note: a.note, cost: a.cost })
    const unblocked = board.ready().filter((r) => r.deps.includes(t.id))
    return `${t.id} done.${unblocked.length ? ` Now ready: ${unblocked.map((r) => r.id).join(", ")}` : ""}`
  },
)

tool(
  "board_fail",
  'Close the current attempt as failed. By default the task is reopened for another attempt; escalate raises its tier, so its next spawn runs on the next, stronger model of horde.json "tiers" (past the last tier, it is yours to do); retry false gives the task up.',
  {
    directory,
    id,
    reason: z.string().describe("What went wrong; kept in the task's history."),
    escalate: z.boolean().optional(),
    retry: z.boolean().optional(),
    cost: z.number().min(0).optional(),
  },
  async (a, board, repo) => {
    const t = await board.fail(a.id, { reason: a.reason, escalate: a.escalate, retry: a.retry, cost: a.cost })
    return `${t.id} is ${t.status}${t.status === "open" ? `, now at ${tierLabel(t.tier, loadTiers(repo))}` : ""}.`
  },
)

tool(
  "board_block",
  "Park a task until something outside the board is resolved (a decision, an external fix). board_edit with status open unblocks it.",
  { directory, id, on: z.string().describe("What it waits for.") },
  async (a, board) => `${(await board.block(a.id, a.on)).id} blocked on ${a.on}.`,
)

tool(
  "board_edit",
  "Change a task's title, goal, acceptance, scope or tier, or reopen it (status open) after a block or failure.",
  {
    directory,
    id,
    title: z.string().optional(),
    goal: z.string().optional(),
    acceptance: strings.optional(),
    scope: strings.optional(),
    tier: z.number().int().min(0).optional(),
    status: z.enum(["open"]).optional(),
  },
  async (a, board) =>
    renderTask(await board.edit(a.id, { title: a.title, goal: a.goal, acceptance: a.acceptance, scope: a.scope, tier: a.tier, status: a.status })),
)

tool(
  "board_summary",
  "The board on one screen: counts, tasks in review with their report gist, running and stale attempts, blocked and failed tasks, what is ready next, held locks.",
  { directory, budget_chars: z.number().int().min(300).max(20_000).optional() },
  async (a, board) => renderSummary(board, a.budget_chars),
  true,
)

tool(
  "board_task",
  "One task: status, attempt, and the latest worker report (what changed, tests added, unverified claims, questions), checked against the attempt's actual diff when its worktree is known. detail full adds the goal, acceptance and every attempt.",
  { directory, id, detail: z.enum(["brief", "full"]).optional() },
  async (a, board, repo) => renderTask(board.task(a.id), a.detail, Date.now(), await board.checkReport(a.id), loadTiers(repo)),
  true,
)

tool(
  "board_findings",
  "Facts workers shared while working (filtered by paths or tags).",
  { directory, paths: strings.optional(), tags: strings.optional() },
  async (a, board) => renderNotes(board.findings({ paths: a.paths, tags: a.tags }), "No findings."),
  true,
)

tool(
  "board_remember",
  "Keep a project note for future tasks (conventions, gotchas, decisions). Relevant notes are included in later briefs.",
  {
    directory,
    text: z.string(),
    tags: strings.optional(),
    paths: strings.optional(),
    confidence: z.enum(["low", "medium", "high"]).optional(),
  },
  async (a, board) => `remembered as ${(await board.remember(a.text, { tags: a.tags, paths: a.paths, confidence: a.confidence })).id}`,
)

tool(
  "board_recall",
  "Search project notes by words, tags or paths.",
  { directory, query: z.string().optional(), tags: strings.optional(), paths: strings.optional() },
  async (a, board) => renderNotes(board.memory({ query: a.query, tags: a.tags, paths: a.paths }), "Nothing remembered about that."),
  true,
)

tool(
  "board_forget",
  "Drop a project note or finding that is wrong or outdated.",
  { directory, note: z.string().describe("Note id, e.g. n-1a2b3c4d.") },
  async (a, board) => {
    await board.forget(a.note)
    return `forgot ${a.note}`
  },
)

tool(
  "board_unlock",
  "Break a worker's lock on a path (e.g. its worker died). Locks also expire 30 minutes after the worker's last activity.",
  { directory, path: z.string() },
  async (a, board) => ((await board.unlock(a.path)) ? `unlocked ${a.path}` : `${a.path} was not locked`),
)

process.stdin.on("close", () => process.exit(0))
// Grammars for code context (briefs, related tests); without them line patterns answer.
await loadSyntax()
await server.connect(new StdioServerTransport())
