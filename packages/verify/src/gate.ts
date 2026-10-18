import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { fitSections, formatDuration, git, gitRaw, type Section, splitZ, truncate } from "@mcp-horde/core"
import { type AuditResult, audit, diffBase, type Finding } from "./audit.js"
import { type Check, checkScripts, detectChecks, loadSettings, loadSettingsAt } from "./detect.js"
import { changedFiles, type Narrowing, planRelated } from "./related.js"
import { type CheckResult, logDirFor, runChecks } from "./run.js"

export interface GateOptions {
  /** Commit the work started from; the audit covers base → working tree. Without it, only checks run. */
  base?: string
  /** Names of checks to run (default: all detected or configured ones). */
  checks?: string[]
  /**
   * Scope globs for this run (a task's paths). They narrow horde.json's `verify.audit.allowed`:
   * a changed path must match both lists (each one that is set).
   */
  allowed?: string[]
  /** Skip the audit (e.g. outside a worktree, where the human's own edits would be audited too). */
  audit?: boolean
  /** Character budget for the rendered verdict. */
  budgetChars?: number
  signal?: AbortSignal
  onProgress?: (message: string) => void
  /** Where logs go (verify_logs reads them back). */
  stateDir?: string
  /** Re-run even if an identical tree was already judged. */
  fresh?: boolean
  /**
   * Run only the tests related to what changed since `base` (see planRelated), when that is
   * safe; other checks run as usual.
   */
  related?: boolean
  /** Like `related`, for these changed files (repository-relative) instead of the diff from base. */
  relatedTo?: string[]
}

export interface Verdict {
  pass: boolean
  directory: string
  checks: CheckResult[]
  audit?: AuditResult
  /** Failing checks and blocking findings, one line each. */
  blockers: string[]
  warnings: string[]
  durationMs: number
  /** The verdict came from the cache (same tree, same checks). */
  cached: boolean
  /** Compact text for the calling model, within the budget. */
  text: string
}

const cache = new Map<string, Omit<Verdict, "cached" | "text">>()
const CACHE_LIMIT = 50

/**
 * A key that changes whenever anything a check could see changes. Any git error means no key
 * (never cached): an empty diff standing in for one that failed would match a different tree.
 */
async function treeKey(directory: string, extra: unknown): Promise<string | undefined> {
  try {
    const root = await git(directory, "rev-parse", "--show-toplevel")
    const head = await git(root, "rev-parse", "--verify", "HEAD")
    const h = createHash("sha256").update(head).update("\0")
    h.update(await gitRaw(root, ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--binary", "HEAD"]))
    for (const p of splitZ(await gitRaw(root, ["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard", "-z"]))) {
      const st = await fs.stat(path.join(root, p)).catch(() => undefined)
      h.update(`\0${p}\0${st?.size ?? -1}\0${st?.mtimeMs ?? -1}`)
    }
    return h.update("\0").update(JSON.stringify(extra)).digest("hex")
  } catch {
    return undefined // not a git repository, no commit yet, or git failed: never cached
  }
}

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || env.USERPROFILE || "."
  return path.resolve(env.HORDE_VERIFY_STATE_DIR || path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), "mcp-horde", "verify"))
}

export async function gate(directory: string, opts: GateOptions = {}): Promise<Verdict> {
  const dir = path.resolve(directory)
  // The diff starts where HEAD meets base; the rules are base's, so the work cannot rewrite them.
  const base = opts.base ? await diffBase(await git(dir, "rev-parse", "--show-toplevel"), opts.base) : undefined
  const settings = base ? await loadSettingsAt(dir, base) : loadSettings(dir)
  const all = await detectChecks(dir, settings)
  const selected = opts.checks?.length ? pick(all, opts.checks) : all
  const doAudit = opts.audit !== false && !!base
  const budget = opts.budgetChars ?? 1500
  const relatedMode = !!opts.relatedTo || (!!opts.related && !!base)
  const key = await treeKey(dir, {
    checks: selected,
    base: doAudit || relatedMode ? base : null,
    allowed: opts.allowed ?? [],
    settings: { ...settings, checks: undefined },
    related: relatedMode ? (opts.relatedTo ?? true) : false,
  })
  const hit = key && !opts.fresh ? cache.get(key) : undefined
  if (hit) return { ...hit, cached: true, text: render(hit, budget, true) }

  const started = Date.now()
  let plans = new Map<Check, Narrowing>()
  let untested: string[] = []
  if (relatedMode) {
    const { root, files } = opts.relatedTo
      ? { root: await git(dir, "rev-parse", "--show-toplevel"), files: opts.relatedTo.map((f) => f.replace(/\\/g, "/")) }
      : await changedFiles(dir, base!)
    ;({ plans, untested } = planRelated(root, files, selected))
  }
  const toRun = selected.filter((c) => !plans.get(c)?.skipped).map((c) => ({ ...c, command: plans.get(c)?.command ?? c.command }))
  const ran = await runChecks(toRun, {
    timeoutMs: settings.timeoutMs,
    signal: opts.signal,
    logDir: logDirFor(path.join(opts.stateDir ?? defaultStateDir(), "logs"), dir),
    onProgress: opts.onProgress,
  })
  const checks = selected.flatMap((c): CheckResult[] => {
    const plan = plans.get(c)
    if (plan?.skipped)
      return [
        { name: c.name, command: c.command, kind: c.kind, pass: true, code: 0, durationMs: 0, extracted: { runner: "generic", failures: [] }, related: plan },
      ]
    const r = ran.find((x) => x.name === c.name)
    return r ? [{ ...r, related: plan }] : []
  })
  const auditResult = doAudit
    ? await audit(dir, {
        base: base!,
        allowed: settings.audit.allowed,
        scopes: [opts.allowed ?? []],
        block: settings.audit.block,
        warn: settings.audit.warn,
        ruleScripts: checkScripts(all),
      })
    : undefined
  const blockers = [
    // Nothing ran, so nothing was judged: that is not a pass.
    ...(selected.length ? [] : [NO_CHECKS]),
    ...checks.filter((c) => !c.pass).map((c) => `${c.name}: ${summary(c)}`),
    ...(auditResult?.findings.filter((f) => f.severity === "block").map(findingLine) ?? []),
  ]
  const warnings = auditResult?.findings.filter((f) => f.severity === "warn").map(findingLine) ?? []
  if (untested.length)
    warnings.push(`tests: no test covers ${untested.length} changed source file(s): ${untested.slice(0, 5).join(", ")}${untested.length > 5 ? ", …" : ""}`)
  const verdict = {
    pass: blockers.length === 0 && !opts.signal?.aborted,
    directory: dir,
    checks,
    audit: auditResult,
    blockers,
    warnings,
    durationMs: Date.now() - started,
  }
  // A cancelled run says nothing about the tree; never cache it.
  if (key && !opts.signal?.aborted) {
    cache.set(key, verdict)
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  }
  return { ...verdict, cached: false, text: render(verdict, budget, false) }
}

const NO_CHECKS = "no checks to run (configure verify.checks in horde.json)"

function pick(all: Check[], names: string[]): Check[] {
  const unknown = names.filter((n) => !all.some((c) => c.name === n))
  if (unknown.length)
    throw new Error(`unknown check${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}; available: ${all.map((c) => c.name).join(", ") || "none"}`)
  return all.filter((c) => names.includes(c.name))
}

function summary(c: CheckResult): string {
  if (c.stopped === "timeout") return "timed out"
  if (c.stopped === "cancelled") return "cancelled"
  const n = c.extracted.counts
  // A failing run with no failed tests failed outside them (a crash, a threshold, a load error).
  if (n?.failed) return [`${n.failed} failed`, n.passed !== undefined && `${n.passed} passed`, n.skipped && `${n.skipped} skipped`].filter(Boolean).join(", ")
  return [c.code === null ? "failed to run" : `exit ${c.code}`, n?.passed !== undefined && `${n.passed} passed`].filter(Boolean).join(", ")
}

function findingLine(f: Finding): string {
  return `${f.category}: ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""} ` : ""}${f.text}`
}

/**
 * The verdict as the calling model sees it: the outcome first, then each
 * failing check with its first failures, then audit findings. Sections are
 * trimmed in that priority order to the budget; counts always survive.
 */
export function render(v: Omit<Verdict, "cached" | "text">, budget: number, cached = false): string {
  const failed = v.checks.filter((c) => !c.pass)
  const blocking = v.audit?.findings.filter((f) => f.severity === "block") ?? []
  const noChecks = v.blockers.includes(NO_CHECKS)
  const parts = [
    failed.length && `${failed.length} check${failed.length > 1 ? "s" : ""} failed`,
    blocking.length && `${blocking.length} blocking finding${blocking.length > 1 ? "s" : ""}`,
    noChecks && "no checks to run",
    v.warnings.length && `${v.warnings.length} warning${v.warnings.length > 1 ? "s" : ""}`,
  ].filter(Boolean)
  const head = `${v.pass ? "PASS" : "FAIL"}${parts.length ? ` · ${parts.join(", ")}` : ""} · ${formatDuration(v.durationMs)}${cached ? " (cached: tree unchanged)" : ""}`
  const sections: Section[] = [{ text: head, required: true }]
  if (noChecks) sections.push({ text: `✗ ${NO_CHECKS}`, required: true })
  // One status line per check, failing ones first.
  for (const c of [...failed, ...v.checks.filter((x) => x.pass)]) {
    if (c.related?.skipped) {
      sections.push({ text: `- ${c.name} · skipped: ${c.related.skipped}` })
      continue
    }
    const scope = c.related
      ? c.related.command
        ? ` · related tests only (${c.related.tests.length} file${c.related.tests.length === 1 ? "" : "s"})`
        : ` · full suite: ${c.related.full}`
      : ""
    sections.push({
      text: `${c.pass ? "✓" : "✗"} ${c.name} · ${c.pass ? summaryPass(c) : summary(c)} · ${formatDuration(c.durationMs)}${scope}`,
      required: !c.pass,
    })
  }
  for (const c of failed) {
    for (const f of c.extracted.failures) {
      const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : (f.frame ?? "")
      const title = [f.test, where].filter(Boolean).join(" — ")
      const body = truncate(f.message, 400)
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n")
      sections.push({
        text: `  ✗ ${c.name}${title ? `: ${title}` : ""}\n${body}`,
        group: `failures:${c.name}`,
        omitted: (n) => `  … ${n} more failure${n > 1 ? "s" : ""} in ${c.name} not shown (verify_logs ${c.name})`,
      })
    }
  }
  for (const w of v.warnings.filter((x) => x.startsWith("tests: no test covers"))) sections.push({ text: `! ${w}` })
  if (v.audit) {
    const n = v.audit.files.length
    sections.push({
      text: `audit: ${n} file${n === 1 ? "" : "s"} changed, ${v.audit.commits} commit${v.audit.commits === 1 ? "" : "s"} since ${v.audit.base.slice(0, 8)}`,
    })
    for (const f of v.audit.findings.filter((x) => x.severity === "block")) {
      sections.push({ text: `  ✗ ${findingLine(f)}`, group: "audit:block", omitted: (k) => `  … ${k} more blocking finding${k > 1 ? "s" : ""}` })
    }
    for (const f of v.audit.findings.filter((x) => x.severity === "warn")) {
      sections.push({ text: `  ! ${findingLine(f)}`, group: "audit:warn", omitted: (k) => `  … ${k} more warning${k > 1 ? "s" : ""}` })
    }
  }
  return fitSections(sections, budget)
}

function summaryPass(c: CheckResult) {
  const n = c.extracted.counts
  return n?.passed !== undefined ? `${n.passed} passed${n.skipped ? `, ${n.skipped} skipped` : ""}` : "ok"
}
