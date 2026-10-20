/**
 * The simple path (docs/DESIGN.md §4.9): delegate, collect and land coding work in one call
 * each. Everything the full flow decided by hand is a default here, and every answer ends
 * with the calls that make sense next, so an agent needs nothing but these descriptions.
 */
import { Board } from "@mcp-horde/board"
import { formatDuration, formatUsd, git, indent, loadTiers, oneLine, truncate } from "@mcp-horde/core"
import { z } from "zod"
import { type Fleet, formatModel, formText, type LandResult, SETTLED, type Snapshot } from "./fleet.js"
import type { AgentRecord, ReviewSummary } from "./state.js"
import { workStart } from "./worktree.js"

// biome-ignore lint/suspicious/noExplicitAny: the registration helper is generic over each tool's schema
type Tool = (name: string, description: string, shape: z.ZodRawShape, run: (args: any, fleet: Fleet, extra: any) => Promise<string>) => void

export interface HordeOptions {
  /** Default seconds a wait blocks for the connected client. */
  waitSeconds: () => number
  /** Progress notifications while a wait blocks, when the client asked for them. */
  progress: (extra: unknown) => ((snaps: Snapshot[], elapsedMs: number) => void) | undefined
}

export const HORDE_INSTRUCTIONS = `horde: cheap, fast worker models that do coding work for you and hand it back checked.
Reach for it first whenever you are about to write a self-contained change yourself (a fix, a feature slice, tests, a refactor, docs): a worker costs a fraction of your tokens, keeps your context for the user, works while you do something else, and its work comes back tested and reviewed and lands without breaking the branch. It takes minutes, so start it and keep going. Do the work yourself only for a one-line edit, for something you need the result of to keep reasoning right now, or for a change you cannot describe in a paragraph.
- horde_do {goal, done, scope} starts a worker in its own git worktree; when it finishes, the project's checks run and a reviewer judges your done-criteria against the diff. Workers do not see your conversation.
- horde_wait returns outcomes: READY → horde_land, NEEDS YOU → horde_tell, FAILED → horde_tell or horde_drop.
Start several for independent work. The opencode_* and board_* tools give finer control (steering mid-step, multi-task plans with dependencies, agents without a worktree or checks); you rarely need them.`

const timeout = z
  .number()
  .int()
  .min(1)
  .max(86_400)
  .describe("How long to block (default 30 min in Claude Code, 50 s elsewhere); on a timeout the workers keep going.")

export function registerHorde(tool: Tool, opts: HordeOptions) {
  tool(
    "horde_do",
    "Delegate a piece of coding work to a cheap, fast worker model and get it back checked: the default for any self-contained change you would otherwise write yourself (not for a one-line edit, or something you need the result of right now). Describe it the way you would to a new colleague: goal (what and why), done (how you will know it is finished), scope (the files it may change). The worker gets its own git worktree with the project's dependencies, and code context from the repository; when it finishes, the project's tests, typecheck and lint run, a reviewer model checks each done-criterion against the diff, and failures go back to the worker to fix (2 rounds). Returns at once with the task id, so several can run in parallel; call horde_wait for the outcome, or pass wait: true to block until it is done (like a subagent).",
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
        .describe('"provider/model" for the worker. Default: the project\'s cheapest tier (horde.json "tiers"), else OpenCode\'s default model.'),
      variant: z.string().optional().describe('Effort level the model offers, e.g. "low", "high", "max".'),
      directory: z.string().optional().describe("The repository (default: the server's directory)."),
      wait: z.boolean().optional().describe("Block until the outcome. Default false."),
      timeout_seconds: timeout.optional(),
    },
    async (a, fleet, extra) => {
      const repo = fleet.resolveDir(a.directory)
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
          signal: extra.signal,
        })
        .catch(async (err: Error) => {
          // Nothing started: the plan entry must not linger as an open task.
          await board.fail(task.id, { reason: `could not start: ${err.message}`, retry: false }).catch(() => undefined)
          throw err
        })
      if (a.wait) return (await collect(fleet, [snapshot.id], "all", a.timeout_seconds ?? opts.waitSeconds(), extra, opts)).text
      const tiers = loadTiers(repo)
      const model = snapshot.model ? formatModel(snapshot.model) : "OpenCode's default model"
      const tier = tiers.length ? ` (tier ${task.tier} of ${tiers.length})` : ""
      const setup = notes.filter((n) => !/^working t-/.test(n)).map((n) => n.replace(/ from the main checkout$/, ""))
      return [
        `${task.id} working: "${task.title}" · ${model}${tier} · worktree ${snapshot.worktree?.branch ?? "(none)"}`,
        ...[setup.join(" · "), task.scope.length ? `scope: ${task.scope.join(", ")}` : "", ...warnings].filter(Boolean).map((l) => `  ${l}`),
        `→ horde_wait {ids: ["${task.id}"]} for the outcome`,
      ].join("\n")
    },
  )

  tool(
    "horde_wait",
    "Wait for delegated tasks. Returns every outcome that is ready, each once; if none is, it blocks until the first one (up to timeout_seconds). READY: checks passed and the work was reviewed (what changed, cost) → horde_land. NEEDS YOU: the worker asks a question or for permission → horde_tell. FAILED: why, what the worker changed, and any edits refused outside its scope → horde_tell with a hint, or horde_drop. With no ids it waits for any task you started; on a timeout it says what each worker is doing (they keep working).",
    {
      ids: z.array(z.string()).optional().describe("Task ids (t-…) from horde_do. Default: every task you started."),
      timeout_seconds: timeout.optional(),
    },
    async (a, fleet, extra) => {
      const ids = a.ids?.length ? a.ids : (await fleet.list({})).snapshots.filter((s) => s.task).map((s) => s.id)
      if (!ids.length) return "No tasks. Start one with horde_do."
      return (await collect(fleet, ids, "any", a.timeout_seconds ?? opts.waitSeconds(), extra, opts)).text
    },
  )

  tool(
    "horde_tell",
    "Reply to a worker: answer its question (message), allow or refuse what it asks permission for (approve true or false, with an optional message; a message alone refuses it and says what to do instead), or ask for changes to finished or failed work (message: it works again and is checked again, with fresh rounds). While it is working, a message steers it. model switches it to another model first, e.g. the stronger tier a FAILED outcome names. scope replaces the files it may change (approving a request never widens it). After a failed horde_land, tell it what to fix, then land again.",
    {
      id: z.string().describe("Task id (t-…)."),
      message: z.string().optional(),
      approve: z.boolean().optional(),
      model: z.string().optional().describe('"provider/model" to switch the worker to first.'),
      scope: z.array(z.string()).optional().describe("The files or globs it may change from now on (replaces the current scope)."),
    },
    async (a, fleet) => {
      const { snapshot: s } = await fleet.inspect(a.id)
      const done: string[] = []
      if (a.scope) {
        await fleet.setScope(a.id, a.scope)
        done.push(`its scope is now ${a.scope.join(", ")}`)
      }
      const perm = s.pending.permissions[0]
      const question = s.pending.questions[0]
      if (perm && (a.approve !== undefined || a.message)) {
        await fleet.respond(a.id, perm.id, { decision: a.approve ? "once" : "reject", message: a.message })
        done.push(`${a.approve ? "allowed" : "refused"}: ${perm.action} ${perm.resources.join(" ; ")}`)
      } else if (perm && !a.scope) {
        throw new Error(
          `${a.id} asks permission for ${perm.action} ${perm.resources.join(" ; ")}: pass approve true or false (with a message saying what to do instead)`,
        )
      } else if (question && a.message) {
        await fleet.respond(a.id, question.id, { answers: question.fields.map(() => [a.message!]) })
        done.push("answered its question")
      } else if (question && !a.scope && !a.model) {
        throw new Error(`${a.id} asks: ${formText(question)}. Pass message with your answer.`)
      } else if (a.message || a.model) {
        await fleet.message(a.id, a.message ?? "Continue with the task.", a.model ? { model: a.model } : {})
        done.push(
          `${a.model ? `switched it to ${a.model} and ` : ""}${SETTLED.has(s.state) && s.state !== "needs_input" ? "it works again; its checks run again when it finishes" : "steered it"}`,
        )
      } else if (!a.scope) {
        throw new Error("nothing to tell: pass message, approve, model or scope")
      }
      return `${a.id}: ${done.join("; ")}.\n→ horde_wait {ids: ["${a.id}"]}`
    },
  )

  tool(
    "horde_land",
    "Land a READY task. Its commits are replayed onto your current branch's tip inside its worktree and the project's checks run there; only if they pass is your branch updated, with exactly those commits. Your uncommitted changes stay as they are. Then the task is marked done and its worktree and branch are removed. If the commits conflict with your branch or the checks fail, your branch is not touched: the answer shows why, and the worker, now on top of your branch, can fix it (horde_tell, then horde_land again).",
    { id: z.string().describe("Task id (t-…).") },
    async (a, fleet, extra) => renderLanding(a.id, await fleet.land(a.id, extra.signal)),
  )

  tool(
    "horde_drop",
    "Give up on a task: stop its worker, record the attempt as failed (tier suggestions learn from it), and remove its worktree and branch (the answer names the last commit, in case you want it back). To try again differently, horde_do again with a clearer goal, or horde_tell {model} for a stronger model on the same work.",
    { id: z.string().describe("Task id (t-…)."), reason: z.string().optional() },
    async (a, fleet) => {
      const { snapshot: s, record } = await fleet.inspect(a.id)
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

/** Wait, then one outcome block per task with news, a line per task still working. */
async function collect(fleet: Fleet, ids: string[], mode: "any" | "all", seconds: number, extra: { signal?: AbortSignal }, opts: HordeOptions) {
  const r = await fleet.waitFor(ids, mode, seconds * 1000, { signal: extra.signal, onTick: opts.progress(extra) })
  const news = r.snapshots.filter((s) => r.news.has(s.id))
  const working = r.snapshots.filter((s) => !r.news.has(s.id) && !SETTLED.has(s.state))
  const parts: string[] = []
  for (const s of news) parts.push(await outcome(fleet, s.id).catch((err: Error) => `${s.name ?? s.id}: could not read its outcome: ${err.message}`))
  for (const s of working) parts.push(await outcome(fleet, s.id).catch(() => `${s.name ?? s.id} working`))
  if (r.timedOut && !news.length) parts.unshift(`Nothing finished within ${seconds}s; the workers keep going (horde_wait again):`)
  else if (!news.length && r.nothingToWaitFor) parts.unshift("Nothing new: every outcome was already reported.")
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
          : "report matches the diff"
        : "",
    ].filter(Boolean)
    const lines = [say("READY"), `  ${head.join(" · ")}`]
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

  // Failed: the checks after the last round, an error, an interrupt, or an unchecked finish.
  const why =
    s.gate?.state === "fail"
      ? `checks failed after ${s.gate.round} round(s)`
      : s.state === "error"
        ? `error: ${truncate(oneLine(s.error ?? "unknown"), 200)}`
        : s.state === "interrupted"
          ? `stopped: ${truncate(oneLine(s.error ?? "interrupted"), 200)}`
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
  lines.push(
    next(
      `horde_tell {id: "${id}", message: "<a precise hint>"} (its checks run again)`,
      ...(stronger ? [`horde_tell {id: "${id}", message, model: "${stronger}"}`] : []),
      ...(refused.length ? [`horde_tell {id: "${id}", scope: [...]} to let it edit more`] : []),
      `horde_drop {id: "${id}"}`,
    ),
  )
  return lines.join("\n")
}

function renderLanding(id: string, r: LandResult): string {
  if (r.landed) {
    const kept = r.branchKept ? ` (branch ${r.branchKept} kept: not all of its commits are on ${r.target})` : ""
    return `landed ${id} on ${r.target}: ${r.commits} commit(s) · ${checksLine(r.checks)} on ${r.target}'s tip before updating it · task done, worktree${r.branchKept ? "" : " and branch"} removed${kept}`
  }
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
