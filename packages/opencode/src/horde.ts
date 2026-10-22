/**
 * The simple path (docs/DESIGN.md §4.9): delegate, collect and land coding work in one call
 * each. Everything the full flow decided by hand is a default here, and every answer ends
 * with the calls that make sense next, so an agent needs nothing but these descriptions.
 */

import fs from "node:fs"
import path from "node:path"
import { Board } from "@mcp-horde/board"
import { formatDuration, formatUsd, git, indent, loadTiers, oneLine, truncate, truncateHead, writeJson } from "@mcp-horde/core"
import { type Check, detectChecks, loadSettingsAt } from "@mcp-horde/verify"
import type { ServerContext } from "@modelcontextprotocol/server"
import { z } from "zod"
import { extractJson, type JsonSchema, retryPrompt, schemaPrompt, validate } from "./ask.js"
import { type Fleet, formatModel, formText, type LandResult, SETTLED, type Snapshot } from "./fleet.js"
import type { AgentRecord, ReviewSummary } from "./state.js"
import { type Worktree, workStart } from "./worktree.js"

// biome-ignore lint/suspicious/noExplicitAny: the registration helper is generic over each tool's schema
type Tool = (name: string, description: string, shape: z.ZodRawShape, run: (args: any, fleet: Fleet, extra: ServerContext) => Promise<string>) => void

export interface HordeOptions {
  /** Default seconds a wait blocks for the connected client. */
  waitSeconds: () => number
  /** Progress notifications while a wait blocks, when the client asked for them. */
  progress: (extra: unknown) => ((snaps: Snapshot[], elapsedMs: number) => void) | undefined
}

// Instructions explain the tools, without superiority claims or "reach for it first", which make
// current models over-trigger (docs/research/vendor-guidance.md). The exclusions stay concrete:
// "more than a few edits" let agents call a feature slice small (docs/research/experiments.md).
export const HORDE_INSTRUCTIONS = `horde: hands coding tasks to cheaper worker models and returns them checked.
It suits any change that can be stated as a goal, done-criteria and the files it may change: a fix, a feature, tests, docs, a refactor, or several independent pieces in parallel. One- or two-line edits, questions, work that is still being investigated, and results needed right away are quicker done directly.
A task is a goal, done-criteria and the files it may change. Workers do not see the conversation, take minutes, and cost a fraction of a frontier model's tokens; subagents can use the same tools.
- horde_do {goal, done, scope} starts a worker in its own git worktree with the project's dependencies; when it finishes, the project's checks run and a reviewer judges each done-criterion against the diff, and failures go back to the worker.
- horde_investigate {question, want, focus} starts a read-only worker in its own worktree that answers with a JSON report of findings (each citing file:line); it never changes the branch.
- horde_wait returns outcomes: READY → horde_land, REPORT → nothing to land (an investigation), NEEDS YOU → horde_tell, FAILED → horde_tell or horde_drop.
- horde_land applies READY work to the branch only if the checks pass on top of it.
The opencode_* and board_* tools give finer control (steering mid-step, multi-task plans with dependencies, agents without a worktree or checks); most work needs only the horde_* tools.`

const timeout = z
  .number()
  .int()
  .min(1)
  .max(86_400)
  .describe("How long to block (default 25 min in Claude Code, 50 s elsewhere); on a timeout the workers keep going.")

/** The JSON a horde_investigate worker must answer with, checked with ask.ts's validate. */
const INVESTIGATE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
          file: { type: "string" },
          line: { type: "integer" },
          evidence: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["title", "severity", "evidence", "confidence"],
      },
    },
  },
  required: ["summary", "findings"],
}

const SEVERITY = ["critical", "high", "medium", "low", "info"] as const

type Finding = {
  title: string
  severity: (typeof SEVERITY)[number]
  file?: string
  line?: number
  evidence: string
  confidence: "high" | "medium" | "low"
  /** The mechanical citation check, when the finding cites a file and/or line. */
  cite?: string
}

/** How long the one retry for an invalid answer may block. */
const INVESTIGATE_RETRY_MS = 300_000

export function registerHorde(tool: Tool, opts: HordeOptions) {
  tool(
    "horde_do",
    "Hand a coding task to a cheaper worker model and get it back checked. Use it for any change you can state as a goal, done-criteria and the files it may change: a fix, a feature, tests, docs, a refactor, or several independent pieces at once (one call each; they run in parallel). Do it directly instead when it is a one- or two-line edit, a question, work you are still investigating, or something you need the result of right away. The worker does not see this conversation, so describe the task the way you would to a new colleague: goal (what and why), done (how you will know it is finished), scope (the files it may change). It gets its own git worktree with the project's dependencies, and code context from the repository; when it finishes, the project's tests, typecheck and lint run, a reviewer model checks each done-criterion against the diff, and failures go back to the worker to fix (2 rounds). Returns at once with the task id; call horde_wait for the outcome, or pass wait: true to block until it is done (like a subagent).",
    {
      goal: z
        .string()
        .min(1)
        .describe(
          "What to do and why, in a paragraph. The worker sees only this and the repository. Mention the files or functions you already know about; it gets the repository's code context itself, so there is no need to explore for it first.",
        ),
      done: z
        .array(z.string())
        .optional()
        .describe(
          'Observable criteria for "finished", e.g. "POST /login answers 429 after 5 failed attempts in a minute", "existing tests pass". A reviewer checks each one against the diff and the checks\' results.',
        ),
      scope: z
        .array(z.string())
        .optional()
        .describe(
          'Files or globs the worker may change, e.g. ["src/auth/**", "test/auth/**"]. Edits elsewhere are refused (the outcome lists any it tried). Omit when unsure.',
        ),
      title: z.string().optional().describe("Short name (default: the goal's first sentence)."),
      model: z
        .string()
        .optional()
        .describe(
          '"provider/model" for the worker. Default: the cheapest tier of the repository\'s horde.json "tiers", else of the user-level ~/.config/mcp-horde/horde.json, else OpenCode\'s default model.',
        ),
      variant: z.string().optional().describe('Effort level the model offers, e.g. "low", "high", "max".'),
      directory: z.string().optional().describe("The repository (default: the server's directory)."),
      wait: z.boolean().optional().describe("Block until the outcome. Default false."),
      timeout_seconds: timeout.optional(),
    },
    async (a, fleet, extra) => {
      const repo = fleet.resolveDir(a.directory)
      // The checks judge the work: with none the gate can never pass, so say so before a worker spends anything.
      // Workers start from HEAD and their gates read HEAD's horde.json, so look there too.
      const checks = await detectChecks(repo, await loadSettingsAt(repo, "HEAD"))
      if (!checks.length) throw new Error(noChecks(repo, (await detectChecks(repo)).length > 0))
      const board = await Board.open(repo)
      const { tasks, warnings } = await board.plan([{ title: a.title ?? titleOf(a.goal), goal: a.goal, acceptance: a.done ?? [], scope: a.scope ?? [] }])
      const task = tasks[0]!
      const { snapshot, notes } = await fleet
        .spawn({
          prompt: "",
          task: task.id,
          model: a.model,
          variant: a.variant,
          directory: repo,
          // Questions are about intent: they are the caller's.
          questions: "ask",
          gate: { review: true, ...(task.scope.length ? { allowed: task.scope } : {}) },
          signal: extra.mcpReq.signal,
        })
        .catch(async (err: Error) => {
          // Nothing started: the plan entry must not linger as an open task.
          await board.fail(task.id, { reason: `could not start: ${err.message}`, retry: false }).catch(() => undefined)
          throw err
        })
      if (a.wait) return (await collect(fleet, [snapshot.id], "all", a.timeout_seconds ?? opts.waitSeconds(), extra, opts)).text
      const tiers = loadTiers(repo)
      const model = snapshot.model ? formatModel(snapshot.model) : "OpenCode's default model"
      const tier = tiers.length ? ` (tier ${board.task(task.id).tier} of ${tiers.length})` : ""
      const setup = notes.filter((n) => !/^working t-/.test(n)).map((n) => n.replace(/ from the main checkout$/, ""))
      return [
        `${task.id} working: "${task.title}" · ${model}${tier} · worktree ${snapshot.worktree?.branch ?? "(none)"}`,
        ...[setup.join(" · "), task.scope.length ? `scope: ${task.scope.join(", ")}` : "", plannedChecks(checks), ...warnings]
          .filter(Boolean)
          .map((l) => `  ${l}`),
        `→ horde_wait {ids: ["${task.id}"]} for the outcome`,
      ].join("\n")
    },
  )

  tool(
    "horde_investigate",
    'Hand a read-only investigation to a cheaper worker model and get it back as a checked report. Use it for audits, code reviews, bug hunts and "how does X work" questions that produce no change: the worker reads, builds and runs code in its own git worktree (never committing), then answers with a JSON report of findings, each citing file:line and the command that produced it. The citations are checked mechanically (a file that does not exist, or a line past its end, is marked), and an answer that is not valid JSON is asked for again once before it fails. Returns at once with the task id; call horde_wait for the REPORT, or pass wait: true to block until it is done.',
    {
      question: z
        .string()
        .min(1)
        .describe(
          "What to find out and why, with the context you have. The worker sees only this and the repository; it does not see this conversation. It reads, builds and runs code to answer, so describe what you need to know and why it matters.",
        ),
      want: z.array(z.string()).optional().describe('What the answer must contain, e.g. ["which code paths call X", "whether the race is real"].'),
      focus: z.array(z.string()).optional().describe("Paths or globs to start reading from; the worker is not limited to them."),
      title: z.string().optional().describe("Short name (default: the question's first sentence)."),
      model: z
        .string()
        .optional()
        .describe(
          '"provider/model" for the worker. Default: the cheapest tier of the repository\'s horde.json "tiers", else of the user-level ~/.config/mcp-horde/horde.json, else OpenCode\'s default model.',
        ),
      variant: z.string().optional().describe('Effort level the model offers, e.g. "low", "high", "max".'),
      directory: z.string().optional().describe("The repository (default: the server's directory)."),
      wait: z.boolean().optional().describe("Block until the outcome. Default false."),
      timeout_seconds: timeout.optional(),
    },
    async (a, fleet, extra) => {
      const repo = fleet.resolveDir(a.directory)
      const board = await Board.open(repo)
      const { tasks, warnings } = await board.plan([{ title: a.title ?? titleOf(a.question), goal: a.question, acceptance: [], scope: [] }])
      const task = tasks[0]!
      const { snapshot, notes } = await fleet
        .spawn({
          prompt: investigatePrompt(a.question, a.want ?? [], a.focus ?? []),
          task: task.id,
          model: a.model,
          variant: a.variant,
          directory: repo,
          // Questions are about intent: they are the caller's.
          questions: "ask",
          gate: false,
          investigate: true,
          signal: extra.mcpReq.signal,
        })
        .catch(async (err: Error) => {
          // Nothing started: the plan entry must not linger as an open task.
          await board.fail(task.id, { reason: `could not start: ${err.message}`, retry: false }).catch(() => undefined)
          throw err
        })
      if (a.wait) return (await collect(fleet, [snapshot.id], "all", a.timeout_seconds ?? opts.waitSeconds(), extra, opts)).text
      const tiers = loadTiers(repo)
      const model = snapshot.model ? formatModel(snapshot.model) : "OpenCode's default model"
      const tier = tiers.length ? ` (tier ${board.task(task.id).tier} of ${tiers.length})` : ""
      const setup = notes.filter((n) => !/^working t-/.test(n)).map((n) => n.replace(/ from the main checkout$/, ""))
      return [
        `${task.id} investigating: "${task.title}" · ${model}${tier} · worktree ${snapshot.worktree?.branch ?? "(none)"}`,
        ...[setup.join(" · "), ...warnings].filter(Boolean).map((l) => `  ${l}`),
        `→ horde_wait {ids: ["${task.id}"]} for the report`,
      ].join("\n")
    },
  )

  tool(
    "horde_wait",
    "Wait for delegated tasks. Returns every outcome that is ready, each once; if none is, it blocks until the first one (up to timeout_seconds). READY: checks passed and the work was reviewed (what changed, cost) → horde_land. REPORT: an investigation's findings, ordered by severity with each citation checked, and the path of the full report JSON → nothing to land. NEEDS YOU: the worker asks a question or for permission → horde_tell. FAILED: why, what the worker changed, and any edits refused outside its scope → horde_tell with a hint, or horde_drop. With no ids it waits for any task you started (changes and investigations); on a timeout it says what each worker is doing (they keep working). In a subagent the call blocks the whole time (Claude Code moves only main-conversation calls to the background), so start the subagent's other work before waiting.",
    {
      ids: z.array(z.string()).optional().describe("Task ids (t-…) from horde_do or horde_investigate. Default: every task you started."),
      timeout_seconds: timeout.optional(),
    },
    async (a, fleet, extra) => {
      const ids = a.ids?.length ? a.ids : (await fleet.list({})).snapshots.filter((s) => s.task).map((s) => s.id)
      if (!ids.length) return "No tasks. Start one with horde_do or horde_investigate."
      return (await collect(fleet, ids, "any", a.timeout_seconds ?? opts.waitSeconds(), extra, opts)).text
    },
  )

  tool(
    "horde_tell",
    "Reply to a worker: answer its question (message), allow or refuse what it asks permission for (approve true or false, with an optional message; a message alone refuses it and says what to do instead), or ask for changes to finished or failed work (message: it works again and is checked again, with fresh rounds). While it is working, a message steers it. model switches it to another model first, e.g. the stronger tier a FAILED outcome names. scope replaces the files it may change (approving a request never widens it); done replaces the task's done-criteria, which the reviewer judges each round. After a failed horde_land, tell it what to fix, then land again.",
    {
      id: z.string().describe("Task id (t-…)."),
      message: z.string().optional(),
      approve: z.boolean().optional(),
      model: z.string().optional().describe('"provider/model" to switch the worker to first.'),
      scope: z.array(z.string()).optional().describe("The files or globs it may change from now on (replaces the current scope)."),
      done: z
        .array(z.string())
        .optional()
        .describe("The task's done-criteria from now on: what the reviewer judges each round (replaces the current criteria)."),
    },
    async (a, fleet) => {
      const { snapshot: s } = await fleet.inspect(a.id)
      const told: string[] = []
      const criteria = a.done?.map((c: string, i: number) => `${i + 1}. ${c}`).join("\n") ?? ""
      const withCriteria = (text: string) => (criteria ? `${text}\n\nYour task's done-criteria changed; they are now:\n${criteria}` : text)
      if (a.done) {
        await fleet.setDone(a.id, a.done)
        told.push(`its done-criteria are now: ${a.done.map((c: string, i: number) => `${i + 1}. ${c}`).join(" ")}`)
      }
      if (a.scope) {
        await fleet.setScope(a.id, a.scope)
        told.push(`its scope is now ${a.scope.join(", ")}`)
      }
      const perm = s.pending.permissions[0]
      const question = s.pending.questions[0]
      if (perm && (a.approve !== undefined || a.message)) {
        await fleet.respond(a.id, perm.id, { decision: a.approve ? "once" : "reject", message: a.message ? withCriteria(a.message) : undefined })
        told.push(`${a.approve ? "allowed" : "refused"}: ${perm.action} ${perm.resources.join(" ; ")}`)
      } else if (perm && !a.scope && !a.done) {
        throw new Error(
          `${a.id} asks permission for ${perm.action} ${perm.resources.join(" ; ")}: pass approve true or false (with a message saying what to do instead)`,
        )
      } else if (question && a.message) {
        await fleet.respond(a.id, question.id, { answers: question.fields.map(() => [withCriteria(a.message!)]) })
        told.push("answered its question")
      } else if (question && !a.scope && !a.model && !a.done) {
        throw new Error(`${a.id} asks: ${formText(question)}. Pass message with your answer.`)
      } else if (a.message || a.model) {
        await fleet.message(a.id, withCriteria(a.message ?? "Continue with the task."), a.model ? { model: a.model } : {})
        told.push(
          `${a.model ? `switched it to ${a.model} and ` : ""}${SETTLED.has(s.state) && s.state !== "needs_input" ? "it works again; its checks run again when it finishes" : "steered it"}`,
        )
      } else if (a.scope || a.done) {
        // A rules change alone must re-judge the finished turn under the new rules, or the task
        // stays stuck: horde_wait would report nothing new.
        if (s.gate?.state === "fail" || (a.done && s.gate?.state === "pass")) {
          await fleet.regate(a.id)
          told.push(`re-checking the finished work under the new ${a.done ? "done-criteria" : "scope"}`)
        } else if (a.done && !SETTLED.has(s.state)) {
          await fleet.message(a.id, withCriteria("Continue with the task."))
          told.push("steered it with the new done-criteria")
        }
      } else {
        throw new Error("nothing to tell: pass message, approve, model, scope or done")
      }
      return `${a.id}: ${told.join("; ")}.\n→ horde_wait {ids: ["${a.id}"]}`
    },
  )

  tool(
    "horde_land",
    "Land a READY task. Its commits are brought onto your current branch's tip inside its worktree and the project's checks run there; only if they pass is your branch updated, with exactly those commits (fast-forwarded, keeping their hashes, when they sit directly on your tip). Your uncommitted changes stay as they are. A horde.json \"workers.land\" command, if set, runs in the worktree after the rebase, and any files it changes are committed and landed with the task. Then the task is marked done and its worktree and branch are removed. If the commits conflict with your branch or the checks fail, your branch is not touched: the answer shows why, and the worker, now on top of your branch, can fix it (horde_tell, then horde_land again). Pass message to land the task's commits as one commit with that message, judged first by the repository's commit-msg hook. In a repository with a commit-msg hook, work the worker left uncommitted is refused: horde_tell it to commit with git commit, or pass message.",
    {
      id: z.string().describe("Task id (t-…)."),
      message: z
        .string()
        .optional()
        .describe(
          "Optional: land the task's commits as one commit with this message, e.g. \"feat(auth): add token refresh\". The repository's commit-msg hook, if any, judges it before the checks run. Without it the commits land as they are; in a repository with a commit-msg hook, leftover uncommitted work must be committed first.",
        ),
    },
    async (a, fleet, extra) => {
      // A finished investigation has no agent any more (its worktree was discarded); its report file marks it.
      const report = reportPath(fleet, a.id)
      if (fs.existsSync(report))
        throw new Error(
          `${a.id} is a finished investigation (horde_investigate): it produced a report, never changes, so there is nothing to land. Its report is at ${report}.`,
        )
      return renderLanding(a.id, await fleet.land(a.id, extra.mcpReq.signal, a.message))
    },
  )

  tool(
    "horde_drop",
    "Give up on a task: stop its worker, record the attempt as failed (tier suggestions learn from it), and remove its worktree and branch (the answer names the last commit, in case you want it back). To try again differently, horde_do again with a clearer goal, or horde_tell {model} for a stronger model on the same work.",
    { id: z.string().describe("Task id (t-…)."), reason: z.string().optional() },
    async (a, fleet) => {
      const found = await fleet.inspect(a.id).catch(async (err: Error) => {
        // A task whose worker never started (a stale claim) has no agent to stop: close it on the board.
        const board = await Board.open(fleet.resolveDir())
        if (!/^t-/.test(a.id) || !board.tasks().some((t) => t.id === a.id)) throw err
        await board.fail(a.id, { reason: a.reason ?? "dropped by the orchestrator", retry: false })
        return undefined
      })
      if (!found) return `dropped ${a.id}: it had no worker, and the task is closed on the board as failed.`
      const { snapshot: s, record } = found
      if (s.state === "running" || s.state === "needs_input") await fleet.interrupt(a.id, "now", "dropped")
      const task = record.task
      const wt = record.worktree
      if (task) {
        const board = await Board.open(wt?.repo ?? record.directory)
        await board.fail(task.id, { reason: a.reason ?? "dropped by the orchestrator", retry: false }).catch(() => undefined)
      }
      await fleet.dispose(a.id, { worktree: "remove" })
      let kept = ""
      if (wt) {
        const tip = await git(wt.repo, "rev-parse", "--verify", `${wt.branch}^{commit}`).catch(() => "")
        if (
          tip &&
          (await git(wt.repo, "branch", "-D", wt.branch).then(
            () => true,
            () => false,
          ))
        )
          kept = ` (its last commit was ${tip.slice(0, 10)}: \`git branch ${wt.branch} ${tip.slice(0, 10)}\` brings it back)`
      }
      return `dropped ${task?.id ?? a.id}: the worker stopped, the attempt is recorded as failed, and its worktree and branch are removed${kept}.`
    },
  )
}

/** What will judge the work, so nobody assumes a gate that is not there. */
function plannedChecks(checks: Check[]): string {
  const list = checks.map((c) => `${c.name} (${truncate(c.command, 40)}${c.when === "land" ? ", before landing only" : ""})`).join(", ")
  return `checked by: ${list} · the tests related to the change after each round, every check before landing`
}

function noChecks(repo: string, uncommitted: boolean): string {
  if (uncommitted)
    return `the checks in ${repo}/horde.json are not committed, so nothing was started: workers start from HEAD, and their gates run the checks HEAD's horde.json names. Commit it, then horde_do again.`
  return [
    `no checks found in ${repo}, so nothing was started: a task's work is judged by the project's checks, and with none its gate can never pass.`,
    "The horde's setup skill (/horde:setup) writes horde.json for this repository: the checks CI runs, what a new worktree needs, the resources checks share.",
    'By hand: horde.json at the repository root, e.g. {"verify": {"checks": {"test": "AUTH_PROVIDER=local go test -race ./...", "web": {"command": "npm test", "cwd": "web"}}}}; each command runs in a shell from the root (or its cwd). Commit it, then horde_do again; verify_detect shows what is found.',
  ].join("\n")
}

/** Wait, then one outcome block per task with news, a line per task still working. */
async function collect(fleet: Fleet, ids: string[], mode: "any" | "all", seconds: number, extra: ServerContext, opts: HordeOptions) {
  const r = await fleet.waitFor(ids, mode, seconds * 1000, { signal: extra.mcpReq.signal, onTick: opts.progress(extra) })
  const news = r.snapshots.filter((s) => r.news.has(s.id))
  const working = r.snapshots.filter((s) => !r.news.has(s.id) && !SETTLED.has(s.state))
  const parts: string[] = []
  for (const s of news) parts.push(await outcome(fleet, s.id).catch((err: Error) => `${s.name ?? s.id}: could not read its outcome: ${err.message}`))
  for (const s of working) parts.push(await outcome(fleet, s.id).catch(() => `${s.name ?? s.id} working`))
  if (r.timedOut && !news.length) parts.unshift(`Nothing finished within ${seconds}s; the workers keep going (horde_wait again):`)
  else if (!news.length && r.nothingToWaitFor && !r.errors.length) parts.unshift("Nothing new: every outcome was already reported.")
  if (r.errors.length) parts.push(`Could not read: ${r.errors.join("; ")}`)
  return { text: parts.join("\n\n") }
}

/** A task's outcome as a compact block that ends with the calls that make sense next. */
export async function outcome(fleet: Fleet, ref: string): Promise<string> {
  const { snapshot: s, record, refused } = await fleet.inspect(ref)
  const wt = record.worktree
  const repo = wt?.repo ?? record.directory
  const board = await Board.open(repo).catch(() => undefined)
  const task = record.task && board ? board.task(record.task.id) : undefined
  const id = task?.id ?? s.name ?? s.id
  const title = task?.title ?? s.title
  const verdict = record.gateState?.verdict
  const footer = await footerLine(s, record, repo, task?.tier)
  const say = (label: string, extra = "") => `${id} ${label} · "${title}"${extra}`
  const next = (...calls: string[]) => `→ ${calls.join(" · ")}`

  if (s.state === "needs_input") {
    const lines = [say("NEEDS YOU")]
    const calls: string[] = []
    for (const p of s.pending.permissions) {
      lines.push(`  ${p.action === "shell" ? `wants to run: ${p.resources.join(" ; ")}` : `wants permission to ${p.action}: ${p.resources.join(", ")}`}`)
      calls.push(`horde_tell {id: "${id}", approve: true}`, "or approve: false with a message saying what to do instead")
    }
    for (const q of s.pending.questions) {
      for (const f of q.fields) {
        const options = "options" in f ? (f.options ?? []).map((o) => o.label).join(" | ") : ""
        lines.push(`  asks: ${f.description ?? f.title ?? q.title}${options ? ` [${options}]` : ""}`)
      }
      calls.push(`horde_tell {id: "${id}", message: "<your answer>"}`)
    }
    return [...lines, next(...new Set(calls))].join("\n")
  }

  if (!SETTLED.has(s.state) || (s.gate && s.gate.state !== "pass" && s.gate.state !== "fail")) {
    const doing =
      s.gate?.state === "running"
        ? "its checks are running"
        : s.gate?.state === "retrying"
          ? `fixing what its checks found (round ${s.gate.round}/${s.gate.maxRounds})`
          : (s.activity ?? "working")
    return `${id} working · ${footer} · ${doing}`
  }

  if (record.investigate) return investigate(fleet, ref, s, record)

  const changes = wt ? await changeSummary(wt.root, workStart(wt)) : undefined
  const workerSaid = oneLine(task?.reports.at(-1)?.summary ?? s.lastTurn?.finalText ?? "")

  const passed = s.gate?.state === "pass" || (verdict?.pass && verdict.final)
  if (s.state === "idle" && passed) {
    const review = verdict?.review
    const report = task && board ? await board.checkReport(task.id).catch(() => undefined) : undefined
    const head = [
      verdict?.checks?.length ? checksLine(verdict.checks) : "checks ✓",
      review ? reviewLine(review) : "",
      report
        ? report.claimedNotChanged.length
          ? `⚠ the worker's report names ${report.claimedNotChanged.join(", ")}, which its diff does not touch`
          : report.listedNotChanged.length
            ? `⚠ listed under tests but unchanged (only run?): ${report.listedNotChanged.join(", ")}`
            : "report matches the diff"
        : "",
    ].filter(Boolean)
    const lines = [say("READY"), `  ${head.join(" · ")}`]
    for (const c of verdict?.checks ?? [])
      if (c.baseline && !c.baseline.pass) lines.push(`  ⚠ ${c.name} fails at ${c.baseline.label} too (not caused by this work)`)
    if (changes) lines.push(`  ${changes.line}`)
    if (changes && wt) lines.push(`  branch ${wt.branch} · diff: git -C ${wt.root} diff ${workStart(wt).slice(0, 10)}`)
    if (workerSaid) lines.push(`  worker: ${truncate(workerSaid, 240)}`)
    for (const c of review?.notMet ?? []) lines.push(`  not met: "${truncate(c.text, 160)}"${c.note ? ` (${truncate(c.note, 160)})` : ""}`)
    for (const c of review?.unclear ?? [])
      lines.push(
        `  unproven: "${truncate(c.text, 160)}" → horde_tell {id: "${id}", message: "Show that this holds, e.g. with a test: ${truncate(c.text, 120).replace(/"/g, "'")}"}`,
      )
    lines.push(`  ${footer}`)
    lines.push(next(`horde_land {id: "${id}"}`, `horde_tell {id: "${id}", message} for changes`, `horde_drop {id: "${id}"}`))
    return lines.join("\n")
  }

  // Failed: the checks after the last round, a review that could not run or found a
  // criterion unmet, a fix round that errored or was interrupted, or an unchecked finish.
  const reviewError = verdict?.review?.error
  const notMet = reviewError ? 0 : (verdict?.review?.notMet?.length ?? 0)
  const why = reviewError
    ? `review could not run: ${truncate(oneLine(reviewError), 200)}`
    : notMet
      ? `${notMet} ${notMet === 1 ? "criterion" : "criteria"} not met`
      : s.state === "error"
        ? `error: ${truncate(oneLine(s.error ?? "unknown"), 200)}`
        : s.state === "interrupted"
          ? `stopped: ${truncate(oneLine(s.error ?? "interrupted"), 200)}`
          : s.gate?.state === "fail"
            ? `checks failed after ${s.gate.round} round(s)`
            : "finished without a verdict"
  const lines = [say("FAILED", ` (${why})`)]
  if (s.gate?.state === "fail" && verdict?.text) lines.push(indent(truncate(verdict.text, 900), "  "))
  if (refused.length) lines.push(`  refused outside its scope: ${refused.slice(0, 6).join(", ")}`)
  if (changes) {
    lines.push(`  ${changes.line}`)
    if (changes.excerpt) lines.push(indent(changes.excerpt, "    "))
    lines.push(`  branch ${wt!.branch} · diff: git -C ${wt!.root} diff ${workStart(wt!).slice(0, 10)}`)
  }
  if (workerSaid) lines.push(`  worker: ${truncate(workerSaid, 240)}`)
  lines.push(`  ${footer}`)
  const stronger = nextTier(repo, task?.tier)
  const scopeBlamed = scopeFiles(verdict?.text)
  lines.push(
    next(
      ...(reviewError
        ? [`horde_tell {id: "${id}", message: "Run the review again"}`]
        : [`horde_tell {id: "${id}", message: "<a precise hint>"} (its checks run again)`]),
      ...(stronger ? [`horde_tell {id: "${id}", message, model: "${stronger}"}`] : []),
      ...(refused.length ? [`horde_tell {id: "${id}", scope: [...]} to let it edit more`] : []),
      ...(scopeBlamed.length ? [`horde_tell {id: "${id}", scope: [...]} to allow ${scopeBlamed.join(", ")}`] : []),
      `horde_drop {id: "${id}"}`,
    ),
  )
  return lines.join("\n")
}

function renderLanding(id: string, r: LandResult): string {
  if (r.landed) {
    const kept = r.branchKept ? ` (branch ${r.branchKept} kept: not all of its commits are on ${r.target})` : ""
    const lines = [
      `landed ${id} on ${r.target}: ${r.commits} commit(s) · ${checksLine(r.checks)} on ${r.target}'s tip before updating it · task done, worktree${r.branchKept ? "" : " and branch"} removed${kept}`,
    ]
    for (const c of r.checks) if (c.baseline && !c.baseline.pass) lines.push(`⚠ ${c.name} fails at ${c.baseline.label} too (not caused by this work)`)
    return lines.join("\n")
  }
  if (r.why === "leftovers")
    return [
      `not landed: ${id}'s worktree still has uncommitted changes, and this repository's commit-msg hook (${r.text}) judges every commit message.`,
      `→ horde_tell {id: "${id}", message: "Commit your remaining changes with git commit; this repository's commit-msg hook judges the message"} · horde_land {id: "${id}", message} (one commit with that message) · horde_drop {id: "${id}"}`,
    ].join("\n")
  if (r.why === "message")
    return [
      `not landed: ${id}'s commit message did not pass the repository's commit-msg hook${r.hook ? ` ${r.hook}` : ""}; ${r.target} is unchanged:`,
      indent(truncate(r.text, 1200), "  "),
      `→ fix the message, then horde_land {id: "${id}", message: "..."}`,
    ].join("\n")
  if (r.why === "land")
    return [
      `not landed: ${id}'s workers.land step failed on top of ${r.target} (the worktree was put back as it was):`,
      indent(truncate(r.text, 1200), "  "),
      `→ fix horde.json "workers.land", then horde_land {id: "${id}"} again · horde_drop {id: "${id}"}`,
    ].join("\n")
  if (r.why === "checks")
    return [
      `not landed: ${id}'s commits fail the checks on top of ${r.target}:`,
      indent(truncate(r.text, 1200), "  "),
      `${r.target} is unchanged; the worker is now on top of it.`,
      `→ horde_tell {id: "${id}", message: "<what to fix>"} (it is checked again; then horde_land again) · horde_drop {id: "${id}"}`,
    ].join("\n")
  if (r.why === "conflict") {
    const files = r.text.split("\n").filter((l) => l && !/:$/.test(l) && !/^(syncing|conflicting)/.test(l))
    return [
      `not landed: ${id}'s commits conflict with ${r.target}${files.length ? ` in ${files.join(", ")}` : ""}. ${r.target} is unchanged.`,
      `→ horde_tell {id: "${id}", message: "Rebase your branch onto ${r.target} and resolve the conflict${files.length ? ` in ${files.join(", ")}` : ""}"} · horde_drop {id: "${id}"}`,
    ].join("\n")
  }
  return `not landed: ${id}'s commits collide with your uncommitted changes:\n${indent(truncate(r.text, 800), "  ")}\nCommit or stash them, then horde_land {id: "${id}"} again.`
}

function checksLine(checks: { name: string; pass: boolean; summary?: string }[]): string {
  const all = checks.every((c) => c.pass)
  const named = checks.map((c) => `${all ? "" : c.pass ? "✓ " : "✗ "}${c.name}${c.summary && c.summary !== "ok" ? ` (${c.summary})` : ""}`)
  return `checks ${all ? "✓ " : ""}${named.join(", ")}`
}

/** Files an audit 'scope' finding blamed, from the rendered verdict ("✗ scope: b.txt adds …"). */
function scopeFiles(text?: string): string[] {
  if (!text) return []
  const files: string[] = []
  for (const line of text.split("\n")) {
    const m = /scope:\s+(\S+)\s+(adds|changes|deletes|moves)\b/.exec(line)
    if (m) files.push(m[1]!)
  }
  return [...new Set(files)]
}

function reviewLine(r: ReviewSummary): string {
  if (r.error) return `review could not run (${truncate(r.error, 120)})`
  const parts = [`${r.met} of ${r.total} criteria met`]
  if (r.notMet.length) parts.push(`${r.notMet.length} not met`)
  if (r.unclear.length) parts.push(`${r.unclear.length} unproven`)
  return `review: ${parts.join(", ")}`
}

/** "$0.03 · 4m · deepseek/deepseek-flash (tier 0; tier 1 is …)" */
async function footerLine(s: Snapshot, record: AgentRecord, repo: string, tier?: number): Promise<string> {
  const review = record.gateState?.verdict?.review?.cost ?? 0
  const model = s.model ? formatModel(s.model) : "default model"
  const tiers = safeTiers(repo)
  const tierNote = tier !== undefined && tiers.length ? ` (tier ${tier}${tiers[tier + 1] ? `; tier ${tier + 1} is ${tiers[tier + 1]!.model}` : ""})` : ""
  return `${formatUsd(s.cost + review)} · ${formatDuration(Date.now() - record.createdAt)} · ${model}${tierNote}`
}

function nextTier(repo: string, tier?: number): string | undefined {
  return tier === undefined ? undefined : safeTiers(repo)[tier + 1]?.model
}

function safeTiers(repo: string) {
  try {
    return loadTiers(repo)
  } catch {
    return []
  }
}

/** "changed 3 files (+86 −2): a.ts (new), b.ts, …", and the first changed lines for a failure. */
async function changeSummary(root: string, start: string): Promise<{ line: string; excerpt: string } | undefined> {
  const numstat = await git(root, "diff", "--numstat", start).catch(() => "")
  const untracked = (await git(root, "ls-files", "--others", "--exclude-standard").catch(() => "")).split("\n").filter(Boolean)
  const files: { file: string; add: number; del: number; isNew?: boolean }[] = numstat
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [add, del, ...rest] = l.split("\t")
      return { file: rest.join("\t"), add: Number(add) || 0, del: Number(del) || 0 }
    })
  for (const f of untracked) files.push({ file: f, add: 0, del: 0, isNew: true })
  if (!files.length) return { line: "changed nothing", excerpt: "" }
  const add = files.reduce((n, f) => n + f.add, 0)
  const del = files.reduce((n, f) => n + f.del, 0)
  const names = files.slice(0, 6).map((f) => `${f.file}${f.isNew ? " (new)" : ""}`)
  const line = `changed ${files.length} file(s) (+${add} −${del}): ${names.join(", ")}${files.length > 6 ? `, … ${files.length - 6} more` : ""}`
  const diff = await git(root, "-c", "core.quotePath=false", "diff", "-U0", "--no-color", start).catch(() => "")
  const excerpt: string[] = []
  for (const l of diff.split("\n")) {
    if (excerpt.length >= 12) break
    if (l.startsWith("+++ b/")) excerpt.push(l.slice(6))
    else if ((l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---")) excerpt.push(`${l[0]}${truncate(l.slice(1), 120)}`)
  }
  return { line, excerpt: excerpt.join("\n") }
}

/** The goal's first sentence, as a title. */
function titleOf(goal: string): string {
  const first = oneLine(goal).split(/(?<=[.!?])\s/)[0] ?? goal
  return truncate(first.replace(/[.!?]$/, ""), 80)
}

// ---------------------------------------------------------------- investigation

/** The worker's whole prompt: the rules it must obey, then the question and the JSON schema. */
function investigatePrompt(question: string, want: string[], focus: string[]): string {
  const lines = [
    "Investigate the question below. You work in your own git worktree; you may read, build and run code, and write temporary files inside the worktree, but never commit (no git commit, push or branch changes).",
    "Point XDG_STATE_HOME, XDG_DATA_HOME and XDG_CONFIG_HOME at a directory inside the worktree (for example $PWD/.xdg, created first) for anything that writes state, so nothing touches the machine outside it.",
    "For every finding, cite the file:line and the command you ran to see it.",
  ]
  if (focus.length) lines.push(`Start from: ${focus.join(", ")} (reading is not limited to these).`)
  lines.push("", `Question: ${question}`)
  if (want.length) lines.push("", "The answer must cover:", ...want.map((w) => `- ${w}`))
  return schemaPrompt(lines.join("\n"), INVESTIGATE_SCHEMA)
}

function finalTextOf(s: Snapshot): string {
  return (s.lastTurn?.finalText ?? "").trim()
}

function judge(text: string): { errors: string[]; value?: unknown } {
  const parsed = extractJson(text)
  if (parsed.error) return { errors: [parsed.error] }
  const errors = validate(parsed.value, INVESTIGATE_SCHEMA)
  return errors.length ? { errors } : { errors, value: parsed.value }
}

function severityRank(severity: string): number {
  return SEVERITY.indexOf(severity as (typeof SEVERITY)[number])
}

function orderBySeverity(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
}

/** The report JSON's home: the horde's state directory, so it can be read again. */
function reportPath(fleet: Fleet, id: string): string {
  return path.join(fleet.stateDir, "reports", `${id}.json`)
}

function resolveCitation(wt: Worktree, file: string): string | undefined {
  for (const base of [wt.path, wt.root]) {
    const abs = path.resolve(base, file)
    try {
      if (fs.statSync(abs).isFile()) return abs
    } catch {
      // try the next base
    }
  }
  return undefined
}

function countLines(file: string): number {
  const text = fs.readFileSync(file, "utf8").replace(/\n$/, "")
  return text === "" ? 0 : text.split("\n").length
}

/** Check each finding's file:line against the worktree, marking citations that do not hold. */
function checkCitations(findings: Finding[], wt: Worktree | undefined): Finding[] {
  return findings.map((f) => {
    if (!wt) return f
    if (!f.file) return f.line === undefined ? f : { ...f, cite: "⚠ citation failed: no file to check the line against" }
    const abs = resolveCitation(wt, f.file)
    if (!abs) return { ...f, cite: `⚠ citation failed: ${f.file} not found` }
    if (f.line === undefined) return f
    const lines = countLines(abs)
    if (f.line < 1 || f.line > lines) return { ...f, cite: `⚠ citation failed: line ${f.line} past end (${lines} line${lines === 1 ? "" : "s"})` }
    return { ...f, cite: "✓ cited" }
  })
}

/**
 * Settle a finished investigation: validate the JSON answer (one retry), check every citation,
 * write the report under the horde's state directory, mark the task done and discard its worktree.
 */
async function investigate(fleet: Fleet, ref: string, s: Snapshot, record: AgentRecord): Promise<string> {
  const wt = record.worktree
  const repo = wt?.repo ?? record.directory
  const board = await Board.open(repo).catch(() => undefined)
  const task = record.task && board ? board.task(record.task.id) : undefined
  const id = task?.id ?? s.name ?? s.id
  const title = task?.title ?? s.title
  const say = (label: string, extra = "") => `${id} ${label} · "${title}"${extra}`

  let snap = s
  let text = finalTextOf(snap)
  let result = judge(text)
  let failedReason: string | undefined
  if (result.errors.length) {
    try {
      await fleet.message(ref, retryPrompt(result.errors))
      const r = await fleet.waitFor([ref], "all", INVESTIGATE_RETRY_MS, { markReported: false })
      if (r.snapshots[0]) snap = r.snapshots[0]
      if (snap.state === "idle") {
        text = finalTextOf(snap)
        result = judge(text)
      } else {
        failedReason = snap.error ?? (r.timedOut ? "no answer within the retry window" : "the worker stopped before answering")
      }
    } catch (err) {
      failedReason = (err as Error).message
    }
  }

  const footer = await footerLine(snap, record, repo, task?.tier)
  if (result.errors.length || failedReason) {
    const tail = text || failedReason || ""
    return [
      say("FAILED", " (the answer never became valid JSON)"),
      tail ? `  answer: ${truncateHead(tail, 500)}` : "",
      `  ${footer}`,
      `→ horde_drop {id: "${id}"} · horde_investigate again with a clearer question`,
    ]
      .filter(Boolean)
      .join("\n")
  }

  const answer = result.value as { summary: string; findings: Finding[] }
  const findings = orderBySeverity(checkCitations(answer.findings, wt))
  const file = reportPath(fleet, id)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeJson(file, {
    task: id,
    title,
    summary: answer.summary,
    findings,
    model: snap.model ? formatModel(snap.model) : "default model",
    cost: snap.cost,
    seconds: Math.round((Date.now() - record.createdAt) / 1000),
    at: new Date().toISOString(),
  })
  if (task && board) await board.accept(task.id, { note: `investigation report: ${file}` }).catch(() => undefined)
  await fleet.dispose(ref, { worktree: "discard" }).catch(() => undefined)

  const lines = [say("REPORT"), `  ${oneLine(answer.summary)}`, `  findings (${findings.length}):`]
  for (const f of findings) {
    const where = f.file ? `${f.file}${f.line !== undefined ? `:${f.line}` : ""}` : "(no file)"
    lines.push(
      `  - [${f.severity}] ${truncate(f.title, 120)} — ${where} · ${f.confidence}${f.cite ? ` · ${f.cite}` : ""} — ${truncate(oneLine(f.evidence), 200)}`,
    )
  }
  lines.push(`  ${footer}`, `  full report: ${file}`)
  return lines.join("\n")
}
