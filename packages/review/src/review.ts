import fs from "node:fs"
import path from "node:path"
import { type Board, current, type Task } from "@mcp-horde/board"
import { definitions, langOf } from "@mcp-horde/context"
import { git, gitRaw, splitZ, truncate } from "@mcp-horde/core"

/**
 * A review of a worker's change against its task's acceptance criteria. The gate proves
 * that the code builds and its tests pass; this asks whether it does what the task asked,
 * one criterion at a time, and makes the reviewing model cite diff lines for every
 * "met". Citations are checked mechanically: a "met" without a line that is really in the
 * diff becomes "unclear", so a confident but unfounded answer cannot pass as evidence.
 */

export interface ReviewInput {
  task: Task
  criteria: string[]
  /** The diff, rendered with new-file line numbers ("L42 +code"). */
  diff: string
  /** Lines of the new files the diff shows (added or context), by file: what may be cited. */
  shown: Map<string, Set<number>>
  /** Files the review could not show (too large, binary, or over the budget). */
  omitted: string[]
  /** Definitions the change touches, one line each ("src/a.ts: function foo (12-40)"). */
  touched: string[]
  workspace: { path: string; base: string }
}

export type Status = "met" | "not_met" | "unclear"

export interface Verdict {
  /** 1-based criterion number. */
  criterion: number
  text: string
  status: Status
  evidence: { file: string; line: number }[]
  note: string
}

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          criterion: { type: "integer", minimum: 1 },
          status: { enum: ["met", "not_met", "unclear"] },
          evidence: {
            type: "array",
            items: { type: "object", properties: { file: { type: "string" }, line: { type: "integer", minimum: 1 } }, required: ["file", "line"] },
          },
          note: { type: "string" },
        },
        required: ["criterion", "status", "evidence", "note"],
      },
    },
  },
  required: ["verdicts"],
} as const

const MAX_UNTRACKED = 200_000

/**
 * Everything a review needs: the task's criteria (its goal, when it has none) and the
 * attempt's change, from its workspace (or `override`) against the commit it started from.
 */
export async function collectReview(
  board: Board,
  id: string,
  opts: { maxDiffChars?: number; override?: { path: string; base: string } } = {},
): Promise<ReviewInput> {
  const task = board.task(id)
  const a = current(task)
  const workspace = opts.override ?? a?.workspace
  if (!workspace) throw new Error(`${id} has no workspace on record (spawn it with opencode_spawn { task }), or pass path and base`)
  if (!fs.existsSync(workspace.path)) throw new Error(`${id}'s workspace ${workspace.path} no longer exists`)
  const root = await git(workspace.path, "rev-parse", "--show-toplevel")
  const Q = ["-c", "core.quotePath=false", "-c", "diff.mnemonicPrefix=false", "-c", "diff.noprefix=false"]
  const raw = await gitRaw(root, [...Q, "diff", "--no-ext-diff", "--no-renames", "--no-color", "-U3", workspace.base])
  // New files the worker has not committed yet are part of its change too.
  const untracked = splitZ(await gitRaw(root, [...Q, "ls-files", "--others", "--exclude-standard", "-z"]))
  let extra = ""
  const skipped: string[] = []
  for (const f of untracked) {
    const abs = path.join(root, f)
    const st = fs.statSync(abs, { throwIfNoEntry: false })
    if (!st?.isFile() || st.size > MAX_UNTRACKED) {
      skipped.push(f)
      continue
    }
    const text = fs.readFileSync(abs, "utf8")
    if (text.includes("\0")) {
      skipped.push(f)
      continue
    }
    const lines = text.replace(/\n$/, "").split("\n")
    extra += `diff --git a/${f} b/${f}\nnew file\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`
  }
  const { diff, shown, omitted, changed } = renderDiff(raw + extra, opts.maxDiffChars ?? 60_000)
  const touched: string[] = []
  for (const [file, lines] of changed) {
    const lang = langOf(file)
    const abs = path.join(root, file)
    if (!lang || !fs.existsSync(abs)) continue
    for (const d of definitions(fs.readFileSync(abs, "utf8"), lang, file))
      if ([...lines].some((l) => l >= d.line && l <= d.end)) touched.push(`${file}: ${d.kind} ${d.name} (${d.line}-${d.end})`)
  }
  const criteria = task.acceptance.length ? task.acceptance : [`The goal is met: ${truncate(task.goal, 400)}`]
  return { task, criteria, diff, shown, omitted: [...new Set([...omitted, ...skipped])], touched: touched.slice(0, 60), workspace }
}

/** The diff with new-file line numbers, within a budget; which lines it shows, and which it changes. */
export function renderDiff(raw: string, maxChars: number) {
  const shown = new Map<string, Set<number>>()
  const changed = new Map<string, Set<number>>()
  const files: { file: string; text: string }[] = []
  let file: string | undefined
  let oldFile: string | undefined
  let out: string[] = []
  let newLine = 0
  let inHunk = false
  const flush = () => {
    if (file) files.push({ file, text: out.join("\n") })
    out = []
  }
  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush()
      file = undefined
      oldFile = undefined
      inHunk = false
      continue
    }
    // Headers only before a file's first hunk: a removed "-- x" line is not a header.
    if (!inHunk && line.startsWith("+++ ")) {
      if (line === "+++ /dev/null") {
        // A deleted file has no new side to cite; show it by name instead of dropping it.
        file = oldFile
        if (file) out.push(`=== ${file} (deleted)`)
      } else {
        file = line.slice(4).replace(/^b\//, "")
        if (file) out.push(`=== ${file}`)
      }
      continue
    }
    if (!inHunk && line.startsWith("--- ")) {
      if (line !== "--- /dev/null") oldFile = line.slice(4).replace(/^a\//, "")
      continue
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (h) {
      inHunk = true
      newLine = Number(h[1])
      out.push(`@@${h[2] ?? ""}`)
      continue
    }
    if (!inHunk) continue
    const mark = line[0]
    const body = line.slice(1)
    if (mark === "+" || mark === " ") {
      if (file) {
        if (!shown.has(file)) shown.set(file, new Set())
        shown.get(file)!.add(newLine)
        if (mark === "+") {
          if (!changed.has(file)) changed.set(file, new Set())
          changed.get(file)!.add(newLine)
        }
      }
      out.push(`L${newLine} ${mark === "+" ? "+" : " "}${body}`)
      newLine++
    } else if (mark === "-") out.push(`     -${body}`)
  }
  flush()
  // Smaller files first, so the budget shows as many whole files as it can.
  const kept: string[] = []
  const omitted: string[] = []
  let used = 0
  for (const f of [...files].sort((a, b) => a.text.length - b.text.length)) {
    if (used + f.text.length > maxChars) {
      omitted.push(f.file)
      shown.delete(f.file)
      continue
    }
    kept.push(f.text)
    used += f.text.length
  }
  return { diff: kept.join("\n\n"), shown, omitted, changed }
}

export function reviewPrompt(r: ReviewInput): string {
  return [
    `You review a change made for a task. Judge each acceptance criterion separately, only from the change below.`,
    "",
    `# Task: ${r.task.title}`,
    r.task.goal,
    "",
    "# Acceptance criteria",
    ...r.criteria.map((c, i) => `${i + 1}. ${c}`),
    "",
    "# How to answer",
    '- For every criterion give status "met", "not_met" or "unclear", evidence and a one-sentence note (under 200 characters).',
    '- "met" needs evidence: the lines of the change that do it, as {file, line} using the L<number> shown before each line. Cite the lines that matter most (at most 5).',
    '- "not_met" when the change does not do it or does it wrongly; say what is missing in the note and cite the closest lines if any.',
    '- "unclear" when the change alone cannot tell (it depends on code not shown, or a test that was not run).',
    "- Do not assume work that is not in the change. Tests passing is checked elsewhere; judge behaviour.",
    "",
    r.touched.length ? `# Definitions the change touches\n${r.touched.join("\n")}\n` : "",
    `# The change (L<n> is the line number in the new file; + added, - removed)`,
    r.diff || "(no changes)",
    r.omitted.length ? `\n(not shown in this review: ${r.omitted.join(", ")})` : "",
  ]
    .filter((x) => x !== "")
    .join("\n")
}

/** The model's answer, with every citation checked against the diff and a verdict for every criterion. */
export function checkVerdicts(r: ReviewInput, json: unknown): Verdict[] {
  const given = ((json as { verdicts?: unknown[] })?.verdicts ?? []) as {
    criterion: number
    status: Status
    evidence?: { file: string; line: number }[]
    note?: string
  }[]
  return r.criteria.map((text, i) => {
    const v = given.find((g) => g.criterion === i + 1)
    if (!v) return { criterion: i + 1, text, status: "unclear" as const, evidence: [], note: "the reviewer gave no verdict for this criterion" }
    const norm = (f: string) => f.replace(/\\/g, "/").replace(/^(\.\/|b\/)/, "")
    const real = (v.evidence ?? []).map((e) => ({ file: norm(e.file), line: e.line })).filter((e) => r.shown.get(e.file)?.has(e.line))
    const dropped = (v.evidence ?? []).length - real.length
    let status = v.status
    let note = truncate(v.note ?? "", 300)
    if (status === "met" && !real.length) {
      status = "unclear"
      note = `${note} (said met, but cited no line of the change)`.trim()
    } else if (dropped) note = `${note} (${dropped} citation(s) not in the change were dropped)`.trim()
    return { criterion: i + 1, text, status, evidence: real.slice(0, 5), note }
  })
}

const MARK: Record<Status, string> = { met: "✓", not_met: "✗", unclear: "?" }

/** Evidence as compact ranges: "src/a.ts:40-42, test/a.test.ts:7". */
function cite(evidence: Verdict["evidence"]): string {
  const by = new Map<string, number[]>()
  for (const e of evidence) by.set(e.file, [...(by.get(e.file) ?? []), e.line])
  return [...by]
    .map(([f, ls]) => {
      const sorted = [...new Set(ls)].sort((a, b) => a - b)
      const ranges: string[] = []
      for (let i = 0; i < sorted.length; ) {
        let j = i
        while (j + 1 < sorted.length && sorted[j + 1]! - sorted[j]! <= 3) j++
        ranges.push(sorted[i] === sorted[j] ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`)
        i = j + 1
      }
      return `${f}:${ranges.join(",")}`
    })
    .join(", ")
}

export function renderVerdicts(r: ReviewInput, verdicts: Verdict[], model: string): string {
  const met = verdicts.filter((v) => v.status === "met").length
  const not = verdicts.filter((v) => v.status === "not_met").length
  const head = `review ${r.task.id} "${r.task.title}" by ${model}: ${met}/${verdicts.length} met${not ? `, ${not} not met` : ""}`
  const lines = verdicts.map((v) => {
    const where = v.evidence.length ? ` — ${cite(v.evidence)}` : ""
    return `${MARK[v.status]} ${v.criterion}. ${truncate(v.text, 120)}${where}${v.note ? `\n    ${v.note}` : ""}`
  })
  const tail = r.omitted.length ? `\n(not reviewed: ${r.omitted.join(", ")})` : ""
  return `${head}\n${lines.join("\n")}${tail}`
}

/** Where two reviewers disagree, criterion by criterion. */
export function disagreements(a: { model: string; verdicts: Verdict[] }, b: { model: string; verdicts: Verdict[] }): string[] {
  return a.verdicts
    .map((v, i) => [v, b.verdicts[i]!] as const)
    .filter(([x, y]) => x.status !== y.status)
    .map(([x, y]) => `criterion ${x.criterion}: ${a.model} says ${x.status}, ${b.model} says ${y.status}`)
}
