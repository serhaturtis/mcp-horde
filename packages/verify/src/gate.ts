import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { fitSections, formatDuration, git, gitRaw, globMatcher, type Section, splitZ, truncate } from "@mcp-horde/core"
import { type AuditResult, audit, diffBase, type Finding } from "./audit.js"
import { type Check, checkScripts, detectChecks, loadSettings, loadSettingsAt } from "./detect.js"
import type { Failure } from "./extract.js"
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
  /**
   * Where the gate's settings come from when `base` is set. `"base"` (the default) freezes the
   * rules at the start of the work; `"working"` is for a shared directory, whose horde.json the
   * human owns and may not have committed yet.
   */
  settingsFrom?: "base" | "working"
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
  /** "work": a task's rounds, which skip `when: "land"` checks; "land": the gate before landing, which runs them. */
  stage?: "work" | "land"
  /** Variables for every check, e.g. a task's HORDE_TASK and HORDE_WORKTREE. */
  env?: Record<string, string>
  /**
   * When checks fail, run the failing ones again at `commit`. A check whose failures all happen
   * there too is the commit's problem, not the work's. `checkout` must return a checkout with
   * dependencies ready; the gate calls it once per run, and always releases it.
   */
  baseline?: { commit: string; label: string; checkout: () => Promise<{ root: string; release: () => Promise<void> }> }
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

interface BaselineOutcome {
  pass: boolean
  /** Whether the baseline actually ran tests (not a missing runner, a timeout or a lost slot). */
  ran: boolean
  /** How many times each failure key occurred, see failureKey. */
  keys: Map<string, number>
}

interface BaselineRun {
  root: string
  timeoutMs: number
  logBase: string
  lockDir?: string
}

const baselineCache = new Map<string, { at: number; results: Promise<Map<string, BaselineOutcome>> }>()
const BASELINE_TTL = 15 * 60_000

/** A check's environment as the baseline key sees it: the task's variables point at the worktree being judged, not the commit. */
function baselineEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of Object.keys(env).sort()) if (k !== "HORDE_TASK" && k !== "HORDE_WORKTREE") out[k] = env[k]!
  return out
}

/**
 * Two gates asking about the same commit and the same checks get one checkout and one run: a
 * baseline is expensive, and its answer belongs to the commit, not to the caller.
 */
async function baselineKey(directory: string, commit: string, checks: Check[], env: Record<string, string>): Promise<string> {
  const root = await git(directory, "rev-parse", "--show-toplevel").catch(() => path.resolve(directory))
  const common = await git(directory, "rev-parse", "--path-format=absolute", "--git-common-dir").catch(() => root)
  const real = await fs.realpath(common).catch(() => common)
  const list = checks
    .map((c) => ({
      name: c.name,
      command: c.command,
      cwd: path.relative(root, c.cwd).replace(/\\/g, "/"),
      env: baselineEnv({ ...env, ...c.env }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return createHash("sha256").update(real).update("\0").update(commit).update("\0").update(JSON.stringify(list)).digest("hex")
}

/** What makes two failures the same one: test and file, or the first message line. Digits matter in
 *  test names and paths (test_limit_20 is not test_limit_10); they are masked only in free-text
 *  messages, where line numbers and timings vary. */
function failureKey(f: Failure): string {
  if (f.test || f.file) return `${f.test ?? ""}\0${f.file ?? ""}`
  const first = (f.message.split("\n").find((l) => l.trim()) ?? "").trim()
  return first.replace(/\d+/g, "#")
}

/** How many times each failure key occurs. */
function countKeys(failures: Failure[]): Map<string, number> {
  const keys = new Map<string, number>()
  for (const k of failures.map(failureKey)) keys.set(k, (keys.get(k) ?? 0) + 1)
  return keys
}

/** Split failures into the ones the baseline also has (known) and the new ones, matching per key. */
function splitFailures(failures: Failure[], baseCounts: Map<string, number>): { failures: Failure[]; known: number } {
  const left = new Map(baseCounts)
  const newFailures: Failure[] = []
  let known = 0
  for (const f of failures) {
    const k = failureKey(f)
    const n = left.get(k) ?? 0
    if (n > 0) {
      left.set(k, n - 1)
      known++
    } else newFailures.push(f)
  }
  return { failures: newFailures, known }
}

/** Runs the failing checks at the baseline commit, sharing an in-flight run with other gates. */
async function baselineOutcomes(opts: GateOptions, run: BaselineRun, checks: Check[]): Promise<Map<string, BaselineOutcome>> {
  const spec = opts.baseline!
  const env = opts.env ?? {}
  const key = await baselineKey(run.root, spec.commit, checks, env)
  const now = Date.now()
  const hit = baselineCache.get(key)
  if (hit && now - hit.at < BASELINE_TTL) return hit.results
  for (const [k, v] of baselineCache) if (now - v.at >= BASELINE_TTL) baselineCache.delete(k)
  const results = (async () => {
    const co = await spec.checkout()
    const logDir = logDirFor(run.logBase, co.root)
    try {
      const ran = await runChecks(
        // The same commands in the same place relative to the repository root, so harnesses see the baseline as they see the work.
        checks.map((c) => ({ ...c, cwd: path.resolve(co.root, path.relative(run.root, c.cwd)) })),
        {
          timeoutMs: run.timeoutMs,
          logDir,
          onProgress: opts.onProgress,
          env: { ...env, HORDE_TASK: `base-${spec.commit.slice(0, 8)}`, HORDE_WORKTREE: co.root },
          lockDir: run.lockDir,
        },
      )
      const out = new Map<string, BaselineOutcome>()
      for (const c of checks) {
        const r = ran.find((x) => x.name === c.name)
        if (!r) throw new Error(`the baseline run did not report ${c.name}`)
        out.set(c.name, {
          pass: r.pass,
          ran: !r.stopped && r.code !== null && r.code !== 127,
          keys: countKeys(r.extracted.failures),
        })
      }
      return out
    } finally {
      await fs.rm(logDir, { recursive: true, force: true })
      await co.release()
    }
  })()
  baselineCache.set(key, { at: now, results })
  // A failed checkout or run is not the commit's answer: let the next gate try again.
  results.catch(() => {
    if (baselineCache.get(key)?.results === results) baselineCache.delete(key)
  })
  return results
}

/** Re-runs the failing checks at the baseline and drops failures the baseline has too. */
async function compareBaseline(
  checks: CheckResult[],
  toRun: Check[],
  opts: GateOptions,
  run: BaselineRun,
): Promise<{ checks: CheckResult[]; warnings: string[] }> {
  const spec = opts.baseline
  // Only a check that ran tests and reported named failures can be rescued: a missing runner
  // (exit 127), a timeout, a lost slot, or a run with no extracted failures fails the same way
  // at the base without ever testing the work, so it is not compared.
  const failing = spec
    ? checks.filter(
        (c) =>
          !c.pass &&
          !c.stopped &&
          c.code !== null &&
          c.code !== 127 &&
          !c.extracted.truncated &&
          c.extracted.failures.length > 0 &&
          c.extracted.failures.every((f) => f.test || f.file),
      )
    : []
  if (!spec || !failing.length || opts.signal?.aborted) return { checks, warnings: [] }
  const runnable = failing.map((c) => toRun.find((x) => x.name === c.name)).filter((c): c is Check => !!c)
  try {
    const outcomes = await baselineOutcomes(opts, run, runnable)
    for (const c of failing) if (!outcomes.has(c.name)) throw new Error(`the baseline run did not report ${c.name}`)
    const warnings: string[] = []
    const compared = checks.map((c) => {
      if (!failing.includes(c)) return c
      const outcome = outcomes.get(c.name)!
      if (outcome.pass) return { ...c, baseline: { label: spec.label, pass: true, known: 0 } }
      // The baseline did not run tests either, so "fails the same way" says nothing about the work.
      if (!outcome.ran) return { ...c, baseline: { label: spec.label, pass: false, known: 0 } }
      // More failures than the runner listed: which ones are new cannot be told, so judge as before.
      const failed = c.extracted.counts?.failed ?? c.extracted.failures.length
      if (failed > c.extracted.failures.length) return { ...c, baseline: { label: spec.label, pass: false, known: 0 } }
      const { failures: newFailures, known } = splitFailures(c.extracted.failures, outcome.keys)
      if (!newFailures.length) {
        warnings.push(`${c.name}: fails at ${spec.label} too, with the same failures (not caused by this change)`)
        return { ...c, pass: true, baseline: { label: spec.label, pass: false, known } }
      }
      // Only the new failures are the change's to answer for.
      return {
        ...c,
        baseline: { label: spec.label, pass: false, known },
        extracted: { ...c.extracted, failures: newFailures },
      }
    })
    return { checks: compared, warnings }
  } catch (err) {
    return { checks, warnings: [`could not compare with ${spec.label}: ${(err as Error).message}`] }
  }
}

export async function gate(directory: string, opts: GateOptions = {}): Promise<Verdict> {
  const dir = path.resolve(directory)
  // The diff starts where HEAD meets base; the rules are base's, so the work cannot rewrite them.
  const base = opts.base ? await diffBase(await git(dir, "rev-parse", "--show-toplevel"), opts.base) : undefined
  // In a worktree the rules are base's, so the work cannot rewrite them. In a shared directory
  // the human's working horde.json is the configuration; the caller must say so explicitly.
  const settings = base && opts.settingsFrom !== "working" ? await loadSettingsAt(dir, base) : loadSettings(dir)
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
    stage: opts.stage ?? null,
    env: opts.env ?? null,
    baseline: opts.baseline?.commit ?? null,
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
  if (opts.stage === "work") for (const c of selected) if (c.when === "land") plans.set(c, { tests: [], skipped: "runs before landing (when: land)" })
  const toRun = selected.filter((c) => !plans.get(c)?.skipped).map((c) => ({ ...c, command: plans.get(c)?.command ?? c.command }))
  const stateDir = opts.stateDir ?? defaultStateDir()
  const logBase = path.join(stateDir, "logs")
  const root = await git(dir, "rev-parse", "--show-toplevel").catch(() => dir)
  const lockDir = toRun.some((c) => c.slots || c.exclusive) ? await lockDirFor(dir, stateDir) : undefined
  // The work is the files that existed before the checks ran: a check's own files (reports,
  // __pycache__, coverage) first appear as untracked during the run and are not the worker's.
  const preUntracked = doAudit ? await untracked(dir) : undefined
  const ran = await runChecks(toRun, {
    timeoutMs: settings.timeoutMs,
    signal: opts.signal,
    logDir: logDirFor(logBase, dir),
    onProgress: opts.onProgress,
    env: opts.env,
    lockDir,
  })
  let checks = selected.flatMap((c): CheckResult[] => {
    const plan = plans.get(c)
    if (plan?.skipped)
      return [
        { name: c.name, command: c.command, kind: c.kind, pass: true, code: 0, durationMs: 0, extracted: { runner: "generic", failures: [] }, related: plan },
      ]
    const r = ran.find((x) => x.name === c.name)
    return r ? [{ ...r, related: plan }] : []
  })
  const compared = await compareBaseline(checks, toRun, opts, { root, timeoutMs: settings.timeoutMs, logBase, lockDir })
  checks = compared.checks
  const auditResult = doAudit
    ? await audit(dir, {
        base: base!,
        allowed: settings.audit.allowed,
        scopes: [opts.allowed ?? []],
        block: settings.audit.block,
        warn: settings.audit.warn,
        ruleScripts: checkScripts(all),
        generated: settings.audit.generated,
      })
    : undefined
  // Files the checks wrote are not the work: drop them from the audit's account.
  if (auditResult && preUntracked) {
    const written = [...(await untracked(dir))].filter((p) => !preUntracked.has(p))
    if (written.length) {
      const set = new Set(written)
      auditResult.files = auditResult.files.filter((p) => !set.has(p))
      auditResult.findings = auditResult.findings.filter((f) => !f.file || !set.has(f.file))
    }
  }
  const blockers = [
    // Nothing ran, so nothing was judged: that is not a pass.
    ...(selected.length ? [] : [NO_CHECKS]),
    ...checks.filter((c) => !c.pass).map((c) => `${c.name}: ${summary(c)}`),
    ...(auditResult?.findings.filter((f) => f.severity === "block").map(findingLine) ?? []),
  ]
  const warnings = [...(auditResult?.findings.filter((f) => f.severity === "warn").map(findingLine) ?? []), ...compared.warnings]
  const generated = globMatcher(settings.audit.generated)
  untested = untested.filter((f) => !generated(f))
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

/** Locks for checks' slots: one directory per repository (its common git dir), shared by all its worktrees. */
export async function lockDirFor(dir: string, stateDir: string): Promise<string> {
  const common = await git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir").catch(() => dir)
  const real = await fs.realpath(common).catch(() => common)
  return path.join(stateDir, "locks", createHash("sha256").update(real).digest("hex").slice(0, 16))
}

function pick(all: Check[], names: string[]): Check[] {
  const unknown = names.filter((n) => !all.some((c) => c.name === n))
  if (unknown.length)
    throw new Error(`unknown check${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}; available: ${all.map((c) => c.name).join(", ") || "none"}`)
  return all.filter((c) => names.includes(c.name))
}

/** Untracked files, repository-relative: a check's reports and caches are new ones, not the work. */
async function untracked(dir: string): Promise<Set<string>> {
  const root = await git(dir, "rev-parse", "--show-toplevel")
  return new Set(splitZ(await gitRaw(root, ["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard", "-z"])))
}

function summary(c: CheckResult): string {
  if (c.stopped === "timeout") return "timed out"
  if (c.stopped === "cancelled") return "cancelled"
  const n = c.extracted.counts
  // Exit 0 with failures: a pipe or wrapper hid the runner's exit code.
  if (c.code === 0 && n?.failed) return `exited 0 although ${n.failed} test${n.failed === 1 ? "" : "s"} failed`
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
    const atBaseline = !!(c.pass && c.baseline && !c.baseline.pass)
    sections.push({
      text: atBaseline
        ? `! ${c.name} · fails at ${c.baseline!.label} too, same failures · ${formatDuration(c.durationMs)}${scope}`
        : `${c.pass ? "✓" : "✗"} ${c.name} · ${c.pass ? summaryPass(c) : summary(c)} · ${formatDuration(c.durationMs)}${scope}`,
      required: !c.pass || atBaseline,
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
    if (c.baseline && !c.baseline.pass && c.baseline.known > 0)
      sections.push({ text: `  (${c.baseline.known} more also fail at ${c.baseline.label})`, required: true })
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
  return n?.passed !== undefined ? `${n.passed} passed${n.failed ? `, ${n.failed} failed` : ""}${n.skipped ? `, ${n.skipped} skipped` : ""}` : "ok"
}
