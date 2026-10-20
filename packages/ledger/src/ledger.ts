import fs from "node:fs"
import path from "node:path"
import { type Attempt, Board, type Task } from "@mcp-horde/board"
import { formatUsd, type Tier } from "@mcp-horde/core"

/**
 * What the boards already know about how attempts went, turned into decisions: which model
 * passes which kind of work, at what cost, and which tier a new task should start on.
 * Read-only over the boards, with one write path: `suggestTiers` with `apply` raises the
 * tier of untried tasks, through the board's own `edit` (under its lock, logged as an event).
 */

export type Kind = "test" | "fix" | "refactor" | "docs" | "build" | "feature"

/** One closed attempt: accepted or failed (abandoned attempts say nothing about the model). */
export interface Outcome {
  /** Board directory name (repository key). */
  repo: string
  task: string
  title: string
  kind: Kind
  /** Directories the task's scope covers, at most two levels deep ("src/api"). */
  areas: string[]
  tier: number
  model?: string
  variant?: string
  accepted: boolean
  /** Gate rounds the attempt used, when its agent had a gate. */
  rounds?: number
  cost: number
  at: number
}

const KINDS: [Kind, RegExp][] = [
  ["test", /\b(tests?|spec|coverage|e2e)\b/i],
  ["fix", /\b(fix|bug|crash|regression|broken|error|fails?)\b/i],
  ["refactor", /\b(refactor|rename|extract|move|split|clean ?up|simplify|restructure)\b/i],
  ["docs", /\b(docs?|readme|document(ation)?|comments?|changelog)\b/i],
  ["build", /\b(build|ci|config(ure|uration)?|deps?|dependenc(y|ies)|upgrade|bump|lint)\b/i],
]

/** What kind of work a task is, from its title (and goal when the title says nothing). */
export function kindOf(title: string, goal = ""): Kind {
  for (const text of [title, goal]) for (const [kind, re] of KINDS) if (re.test(text)) return kind
  return "feature"
}

/** The directories a scope covers: glob parts dropped, at most two levels, no file names. */
export function areasOf(scope: string[]): string[] {
  const out = new Set<string>()
  for (const s of scope) {
    const parts = s.replace(/\\/g, "/").replace(/^\.\//, "").split("/").filter(Boolean)
    const plain: string[] = []
    for (const p of parts) {
      if (/[*?[{]/.test(p)) break
      plain.push(p)
    }
    // A last part with an extension is a file: its directory is the area.
    if (plain.length && plain.length === parts.length && /\.[^/]+$/.test(plain[plain.length - 1]!)) plain.pop()
    if (plain.length) out.add(plain.slice(0, 2).join("/"))
  }
  return [...out]
}

const roundsOf = (a: Attempt) => {
  const m = /(\d+)\/\d+/.exec(a.activity?.gate ?? "")
  return m ? Number(m[1]) : undefined
}

/** Closed attempts of one board. */
export function outcomesOf(board: Board, repo = path.basename(board.dir)): Outcome[] {
  const out: Outcome[] = []
  for (const t of board.tasks()) {
    const kind = kindOf(t.title, t.goal)
    const areas = areasOf(t.scope)
    for (const a of t.attempts) {
      if (!a.endedAt || (a.outcome !== "accepted" && a.outcome !== "failed")) continue
      out.push({
        repo,
        task: t.id,
        title: t.title,
        kind,
        areas,
        tier: a.tier,
        model: a.model,
        variant: a.variant,
        accepted: a.outcome === "accepted",
        rounds: roundsOf(a),
        cost: a.cost ?? 0,
        at: a.endedAt,
      })
    }
  }
  return out
}

/** Every board under a state root (each repository has one). */
export function allBoards(stateRoot: string): Board[] {
  if (!fs.existsSync(stateRoot)) return []
  return fs
    .readdirSync(stateRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(stateRoot, d.name, "tasks")))
    .map((d) => new Board(path.join(stateRoot, d.name)))
}

// ------------------------------------------------------------------ statistics

export type GroupBy = "model" | "tier" | "kind" | "area" | "repo"

export interface Row {
  key: string
  attempts: number
  accepted: number
  /** Accepted / attempts. */
  passRate: number
  /** Mean gate rounds of accepted attempts that had a gate. */
  rounds?: number
  /** Everything spent on the group's attempts, divided by its accepted ones. */
  costPerAccepted?: number
  /** Pass rate of the latest attempts, when there are enough to compare with the rest. */
  recentRate?: number
}

const RECENT = 10

const keysOf = (o: Outcome, by: GroupBy): string[] => {
  switch (by) {
    case "model":
      return [o.model ? `${o.model}${o.variant ? ` [${o.variant}]` : ""}` : `tier ${o.tier} (model not recorded)`]
    case "tier":
      return [`tier ${o.tier}`]
    case "kind":
      return [o.kind]
    case "area":
      return o.areas.length ? o.areas : ["(no scope)"]
    case "repo":
      return [o.repo]
  }
}

export function stats(outcomes: Outcome[], by: GroupBy): Row[] {
  const groups = new Map<string, Outcome[]>()
  for (const o of outcomes) for (const k of keysOf(o, by)) groups.set(k, [...(groups.get(k) ?? []), o])
  return [...groups]
    .map(([key, os]) => {
      os.sort((a, b) => a.at - b.at)
      const accepted = os.filter((o) => o.accepted)
      const gated = accepted.filter((o) => o.rounds !== undefined)
      const cost = os.reduce((n, o) => n + o.cost, 0)
      const recent = os.slice(-RECENT)
      return {
        key,
        attempts: os.length,
        accepted: accepted.length,
        passRate: accepted.length / os.length,
        rounds: gated.length ? gated.reduce((n, o) => n + o.rounds!, 0) / gated.length : undefined,
        costPerAccepted: accepted.length && cost ? cost / accepted.length : undefined,
        recentRate: os.length >= RECENT + 5 ? recent.filter((o) => o.accepted).length / recent.length : undefined,
      }
    })
    .sort((a, b) => b.attempts - a.attempts || a.key.localeCompare(b.key))
}

const pct = (x: number) => `${Math.round(x * 100)}%`

export function renderStats(rows: Row[], by: GroupBy, scope: string): string {
  if (!rows.length) return `No closed attempts on ${scope} yet: the ledger learns from accepted and failed attempts.`
  const lines = rows.map((r) => {
    const parts = [
      `${r.accepted}/${r.attempts} accepted (${pct(r.passRate)})`,
      r.rounds !== undefined && `${r.rounds.toFixed(1)} gate rounds`,
      r.costPerAccepted !== undefined && `${formatUsd(r.costPerAccepted)} per accepted`,
    ].filter(Boolean)
    // A model that got worse lately (a provider update, a harder area) is worth knowing.
    const drift = r.recentRate !== undefined && r.recentRate < r.passRate - 0.2 ? ` · ⚠ last ${RECENT}: ${pct(r.recentRate)}` : ""
    return `${r.key}: ${parts.join(" · ")}${drift}`
  })
  return `By ${by}, ${scope}:\n${lines.join("\n")}`
}

// ------------------------------------------------------------------ suggestions

export interface Draft {
  title: string
  goal?: string
  scope?: string[]
}

export interface Suggestion {
  tier: number
  /** The tier's model in horde.json, when there is a list. */
  model?: string
  /** Why, from the evidence. */
  why: string
  /** Weighted number of similar attempts behind it. */
  evidence: number
}

/** Below this pass rate on similar work, with enough evidence, a tier is skipped. */
const BAD = 0.4
/** A tier is called good on similar work from this pass rate up. */
const GOOD = 0.7
/** Weighted similar attempts needed before the evidence counts. */
const ENOUGH = 2

/**
 * How alike two pieces of work are (0..1): the same area of the same repository counts most,
 * the same kind of work next. Another repository's work counts only by kind, and half.
 */
function similarity(o: Outcome, d: { kind: Kind; areas: string[]; repo?: string }): number {
  const kind = o.kind === d.kind ? 1 : 0
  if (d.repo && o.repo !== d.repo) return 0.5 * 0.4 * kind
  const area = d.areas.some((a) => o.areas.some((b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)))
    ? 1
    : d.areas.some((a) => o.areas.some((b) => a.split("/")[0] === b.split("/")[0]))
      ? 0.5
      : 0
  return 0.6 * area + 0.4 * kind
}

/**
 * The tier a task should start on: the cheapest one that similar work has not shown to fail.
 * Undefined when the evidence says nothing beyond the default (start at tier 0). An attempt
 * counts for the tier its model has in today's list (tiers get reordered and replaced), or
 * for its recorded tier when its model is no longer listed or was not recorded.
 */
export function suggest(draft: Draft, outcomes: Outcome[], tiers: Tier[], repo?: string): Suggestion | undefined {
  // No model list means there is no tier to suggest (and no tier 1 to fall back to).
  if (!tiers.length) return undefined
  const d = { kind: kindOf(draft.title, draft.goal), areas: areasOf(draft.scope ?? []), repo }
  const tierOf = (o: Outcome) => {
    const listed = o.model ? tiers.findIndex((t) => t.model === o.model && (t.variant ?? undefined) === (o.variant ?? undefined)) : -1
    const byModel = listed >= 0 ? listed : o.model ? tiers.findIndex((t) => t.model === o.model) : -1
    return byModel >= 0 ? byModel : o.tier
  }
  const by = new Map<number, { n: number; ok: number }>()
  for (const o of outcomes) {
    const w = similarity(o, d)
    if (w < 0.4 * 0.5) continue
    const k = tierOf(o)
    const e = by.get(k) ?? { n: 0, ok: 0 }
    e.n += w
    e.ok += o.accepted ? w : 0
    by.set(k, e)
  }
  const label = (t: number) => (tiers[t] ? `tier ${t} (${tiers[t]!.model}${tiers[t]!.variant ? ` ${tiers[t]!.variant}` : ""})` : `tier ${t}`)
  const rate = (e: { n: number; ok: number }) => `${Math.round(e.ok * 10) / 10} of ${Math.round(e.n * 10) / 10} similar attempts passed`
  const skipped: string[] = []
  const last = Math.max(tiers.length - 1, ...by.keys())
  for (let t = 0; t <= last; t++) {
    const e = by.get(t)
    if (e && e.n >= ENOUGH && e.ok / e.n < BAD) {
      skipped.push(`${label(t)}: ${rate(e)}`)
      continue
    }
    if (!skipped.length) return undefined // the default (tier 0) stands
    const good = e && e.n >= ENOUGH && e.ok / e.n >= GOOD ? `; on ${label(t)} ${rate(e)}` : e ? `; ${label(t)} has little evidence yet (${rate(e)})` : ""
    return {
      tier: t,
      model: tiers[t]?.model,
      why: `similar ${d.kind} work${d.areas.length ? ` in ${d.areas.join(", ")}` : ""} failed on ${skipped.join("; ")}${good}`,
      evidence: [...by.values()].reduce((n, x) => n + x.n, 0),
    }
  }
  // Every listed tier failed similar work: the last tier, the orchestrator, is the honest answer.
  return {
    tier: tiers.length || last + 1,
    why: `similar ${d.kind} work failed on every model tier (${skipped.join("; ")}): consider doing it yourself or splitting it`,
    evidence: [...by.values()].reduce((n, x) => n + x.n, 0),
  }
}

/** Open tasks that have not been tried yet: the ones a suggestion can still place. */
export const untried = (t: Task) => t.status === "open" && !t.attempts.length

/**
 * Suggest starting tiers for tasks; with `apply`, raise the tier of untried tasks whose
 * suggestion is above it (never lowers what the orchestrator set).
 */
export async function suggestTiers(
  board: Board,
  ids: string[] | undefined,
  outcomes: Outcome[],
  tiers: Tier[],
  opts: { apply?: boolean; repo?: string } = {},
): Promise<string> {
  const tasks = ids?.length ? ids.map((id) => board.task(id)) : board.tasks().filter(untried)
  if (!tasks.length) return "No untried open tasks to suggest tiers for."
  const lines: string[] = []
  for (const t of tasks) {
    const s = suggest({ title: t.title, goal: t.goal, scope: t.scope }, outcomes, tiers, opts.repo)
    if (!s) {
      lines.push(`${t.id} "${t.title}": tier ${t.tier} stands (no evidence against the cheaper tiers)`)
      continue
    }
    const target = s.model ? `tier ${s.tier} (${s.model})` : s.tier >= tiers.length && tiers.length ? `tier ${s.tier} (yours)` : `tier ${s.tier}`
    let applied = ""
    if (opts.apply && untried(t) && s.tier > t.tier) {
      await board.edit(t.id, { tier: s.tier })
      applied = " → set"
    } else if (opts.apply && s.tier <= t.tier) applied = " (already at or above it)"
    else if (opts.apply) applied = " (already tried: unchanged)"
    lines.push(`${t.id} "${t.title}": ${target}${applied}: ${s.why}`)
  }
  return lines.join("\n")
}
