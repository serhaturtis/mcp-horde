import { openProject, pack } from "@mcp-horde/context"
import { estimateTokens, fitSections, formatUsd, type Section, truncate } from "@mcp-horde/core"
import { type Attempt, type Board, current, LEASE_MS, type Note, type ReportCheck, type Task } from "./board.js"
import { workerCommand } from "./command.js"

const ago = (t: number, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - t) / 1000))
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`
}

const list = (items: string[], bullet = "- ") => items.map((i) => `${bullet}${i}`).join("\n")

/** Code context gets at most this share of a brief's budget (and whatever the rest leaves). */
const CONTEXT_SHARE = 0.6

/**
 * The prompt a worker gets: the task, what done means, where to work, what
 * others already learned, the exact commands to report with, and, given the
 * repository, code context (scoped files, named symbols, covering tests, the
 * project's conventions). Sections the worker cannot do without are required;
 * notes and code context fill the rest of the budget.
 */
export function renderBrief(board: Board, t: Task, a: Attempt, budgetTokens = 6000, repo?: string): string {
  const cmd = workerCommand(board.dir)
  const id = t.id
  const notes = (ns: Note[], title: string, caveat: string) =>
    ns.length ? `## ${title}\n${caveat}\n${list(ns.slice(0, 12).map((n) => `${n.text}${n.paths.length ? ` (${n.paths.join(", ")})` : ""}`))}` : ""
  const memory = board.memory({ paths: t.scope, query: `${t.title} ${t.goal}` })
  const findings = board.findings({ paths: t.scope }).filter((n) => n.source?.task !== id)
  const sections: Section[] = [
    { text: `# Task ${id}: ${t.title}\n\n${t.goal}`, required: true },
    {
      text: `## Done means\n${t.acceptance.length ? list(t.acceptance) : "- The goal above is met and the project's checks pass."}\nYour work may also be checked mechanically when you finish (tests, typecheck, lint, and a review of your diff). Do not skip, delete or weaken tests, and do not silence errors to make checks pass.`,
      required: true,
    },
    {
      text: t.scope.length
        ? `## Scope\nWork in: ${t.scope.join(", ")}\nBefore changing anything outside it, lock the paths (command below). If a lock is refused, another task owns them: do not edit them; say so in your report.`
        : "## Scope\nNo scope was set; keep your changes to what the goal needs.",
      required: true,
    },
    {
      text: [
        "## Reporting (required)",
        "Run these with your bash tool, exactly as written (only replace the quoted text). Do not add $, backticks, backslashes, ;, &, | or redirects: those commands are refused.",
        `- First:   ${cmd} task ${id} ${a.token}`,
        `- Progress (optional, renews your locks): ${cmd} progress ${id} ${a.token} "what you are doing"`,
        `- A fact other workers need: ${cmd} finding "the fact" --paths "src/x.ts" --task ${id} --token ${a.token}`,
        `- Before editing outside your scope: ${cmd} lock ${id} ${a.token} "path/one" "path/two"`,
        "- Last, when you are done:",
        `  ${cmd} report ${id} ${a.token} --summary "what you did and why" --changed "a.ts,b.ts" --tests "a.test.ts" --unverified "anything you did not run or check" --confidence high`,
        "  Use --confidence low, medium or high. Repeat --unverified, --decision or --question for more items. Put anything you did not actually run or verify under --unverified.",
      ].join("\n"),
      required: true,
    },
    { text: notes(memory, "Project notes", "From earlier tasks; they may be outdated.") },
    { text: notes(findings, "Findings from other workers", "Shared during this work; check before relying on them.") },
  ].filter((s) => s.text)
  const brief = fitSections(sections, budgetTokens * 4, "\n\n")
  if (!repo) return brief
  const left = Math.min(Math.floor(budgetTokens * CONTEXT_SHARE), budgetTokens - estimateTokens(brief) - 50)
  if (left < 300) return brief
  let context = ""
  try {
    context = pack(openProject(repo, { fresh: true }), {
      goal: `${t.title}\n${t.goal}\n${t.acceptance.join("\n")}`,
      scope: t.scope,
      budgetTokens: left,
    })
  } catch {
    // Code context is a help, never a reason to withhold the brief.
  }
  return context ? `${brief}\n\n${context}` : brief
}

function attemptLine(t: Task, now: number): string {
  const a = current(t)
  if (!a) return ""
  const who = a.agent ? `agent ${a.agent}, ` : ""
  const seen = a.seenAt ? `last seen ${ago(a.seenAt, now)}` : "worker not seen yet"
  return ` (${who}attempt ${a.n}, ${seen}${a.progress ? `: "${truncate(a.progress, 80)}"` : ""})`
}

/** One screen for the orchestrator: what is running, what needs a decision, what is next. */
export function renderSummary(board: Board, budgetChars = 1500, now = Date.now()): string {
  const tasks = board.tasks()
  const by = (s: Task["status"]) => tasks.filter((t) => t.status === s)
  const ready = board.ready(tasks)
  const counts = (["done", "working", "claimed", "review", "open", "blocked", "failed"] as const)
    .map((s) => [s, by(s).length] as const)
    .filter(([, n]) => n)
    .map(([s, n]) => `${n} ${s}`)
  const cost = tasks.reduce((n, t) => n + t.cost, 0)
  const sections: Section[] = [
    {
      text: tasks.length
        ? `${tasks.length} task${tasks.length === 1 ? "" : "s"}: ${counts.join(", ")}${cost ? ` · ${formatUsd(cost)}` : ""}`
        : "The board is empty: plan tasks with board_plan.",
      required: true,
    },
  ]
  for (const t of by("review")) {
    const r = t.reports[t.reports.length - 1]
    const flags = r
      ? [
          `confidence ${r.confidence}`,
          r.unverifiedClaims.length && `${r.unverifiedClaims.length} unverified`,
          r.questions.length && `${r.questions.length} question(s)`,
        ]
      : []
    sections.push({
      text: `review  ${t.id} "${t.title}"${r ? `: ${truncate(r.summary, 160)} (${flags.filter(Boolean).join(", ")})` : ""}`,
      group: "review",
      omitted: (n) => `review  … ${n} more`,
    })
  }
  for (const t of [...by("working"), ...by("claimed")]) {
    const a = current(t)
    const stale = a && now - (a.seenAt ?? a.startedAt) > LEASE_MS
    sections.push({
      text: `${stale ? "STALE  " : "working"} ${t.id} "${t.title}"${attemptLine(t, now)}`,
      group: "working",
      omitted: (n) => `working … ${n} more`,
    })
  }
  for (const t of by("blocked"))
    sections.push({ text: `blocked ${t.id} "${t.title}" on ${t.blockedOn ?? "?"}`, group: "blocked", omitted: (n) => `blocked … ${n} more` })
  for (const t of by("failed")) sections.push({ text: `failed  ${t.id} "${t.title}"`, group: "failed", omitted: (n) => `failed … ${n} more` })
  if (ready.length) sections.push({ text: `next    ${ready.map((t) => `${t.id} "${truncate(t.title, 50)}"`).join(", ")}`, required: true })
  const waiting = by("open").filter((t) => !ready.includes(t))
  if (waiting.length) sections.push({ text: `waiting ${waiting.map((t) => `${t.id} (on ${t.deps.join(", ")})`).join(", ")}` })
  const locks = board.locks(now)
  if (locks.length) sections.push({ text: `locks   ${locks.map((l) => `${l.path} → ${l.task}`).join(", ")}` })
  return fitSections(sections, budgetChars)
}

export function renderTask(t: Task, detail: "brief" | "full" = "brief", now = Date.now(), check?: ReportCheck): string {
  const lines = [
    `${t.id} "${t.title}" — ${t.status}${t.blockedOn ? ` on ${t.blockedOn}` : ""} · tier ${t.tier}${t.cost ? ` · ${formatUsd(t.cost)}` : ""}${attemptLine(t, now)}`,
  ]
  if (t.deps.length) lines.push(`deps: ${t.deps.join(", ")}`)
  if (t.scope.length) lines.push(`scope: ${t.scope.join(", ")}`)
  const r = t.reports[t.reports.length - 1]
  if (detail === "full") {
    lines.push(`goal: ${t.goal}`)
    if (t.acceptance.length) lines.push(`acceptance:\n${list(t.acceptance, "  - ")}`)
    for (const a of t.attempts) {
      lines.push(
        `attempt ${a.n} (tier ${a.tier}${a.agent ? `, ${a.agent}` : ""}): ${a.outcome ?? (a.endedAt ? "ended" : "open")}${a.note ? ` — ${truncate(a.note, 200)}` : ""}`,
      )
    }
  }
  if (r) {
    lines.push(`report (attempt ${r.attempt}, confidence ${r.confidence}): ${detail === "full" ? r.summary : truncate(r.summary, 400)}`)
    const field = (name: string, items: string[]) => items.length && lines.push(`  ${name}: ${items.join(detail === "full" ? "; " : ", ")}`)
    field("changed", r.filesChanged)
    field("tests added", r.testsAdded)
    field("unverified", r.unverifiedClaims)
    field("questions", r.questions)
    if (detail === "full") field("decisions", r.decisions)
    if (check) {
      if (check.claimedNotChanged.length) lines.push(`  ⚠ claimed but not in the diff: ${check.claimedNotChanged.join(", ")}`)
      if (check.changedNotReported.length) lines.push(`  ⚠ in the diff but not in the report: ${check.changedNotReported.join(", ")}`)
      if (!check.claimedNotChanged.length && !check.changedNotReported.length)
        lines.push(`  ✓ the report matches the diff (${check.diff.length} file${check.diff.length === 1 ? "" : "s"})`)
    }
  }
  return lines.join("\n")
}

export function renderNotes(notes: Note[], empty: string): string {
  if (!notes.length) return empty
  return notes
    .slice(0, 30)
    .map(
      (n) =>
        `${n.id} ${n.text}${n.paths.length ? ` (${n.paths.join(", ")})` : ""}${n.source ? ` — from ${n.source.task}` : ""}${n.tags.length ? ` [${n.tags.join(", ")}]` : ""}`,
    )
    .join("\n")
}
