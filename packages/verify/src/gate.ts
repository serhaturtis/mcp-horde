import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { fitSections, formatDuration, git, gitRaw, type Section, splitZ, truncate } from "@mcp-horde/core"
import { type AuditResult, audit, type Finding } from "./audit.js"
import { type Check, detectChecks, loadSettings } from "./detect.js"
import { type CheckResult, logDirFor, runChecks } from "./run.js"

export interface GateOptions {
  /** Commit the work started from; the audit covers base → working tree. Without it, only checks run. */
  base?: string
  /** Names of checks to run (default: all detected or configured ones). */
  checks?: string[]
  /** Scope globs for this run, added to horde.json's `verify.audit.allowed`. */
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

/** A key that changes whenever anything a check could see changes. */
async function treeKey(directory: string, extra: unknown): Promise<string | undefined> {
  try {
    const root = await git(directory, "rev-parse", "--show-toplevel")
    const head = await git(root, "rev-parse", "HEAD").catch(() => "none")
    const h = createHash("sha256").update(head).update("\0")
    h.update(await gitRaw(root, ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--binary", "HEAD"]).catch(() => ""))
    for (const p of splitZ(await gitRaw(root, ["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard", "-z"]))) {
      const st = await fs.stat(path.join(root, p)).catch(() => undefined)
      h.update(`\0${p}\0${st?.size ?? -1}\0${st?.mtimeMs ?? -1}`)
    }
    return h.update("\0").update(JSON.stringify(extra)).digest("hex")
  } catch {
    return undefined // not a git repository: never cached
  }
}

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || env.USERPROFILE || "."
  return path.resolve(env.HORDE_VERIFY_STATE_DIR || path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), "mcp-horde", "verify"))
}

export async function gate(directory: string, opts: GateOptions = {}): Promise<Verdict> {
  const dir = path.resolve(directory)
  const settings = loadSettings(dir)
  const all = await detectChecks(dir, settings)
  const selected = opts.checks?.length ? pick(all, opts.checks) : all
  const allowed = [...settings.audit.allowed, ...(opts.allowed ?? [])]
  const doAudit = opts.audit !== false && !!opts.base
  const budget = opts.budgetChars ?? 1500
  const key = await treeKey(dir, { checks: selected.map((c) => [c.name, c.command, c.cwd]), base: doAudit ? opts.base : null, allowed, a: settings.audit })
  const hit = key && !opts.fresh ? cache.get(key) : undefined
  if (hit) return { ...hit, cached: true, text: render(hit, budget, true) }

  const started = Date.now()
  const checks = await runChecks(selected, {
    timeoutMs: settings.timeoutMs,
    signal: opts.signal,
    logDir: logDirFor(path.join(opts.stateDir ?? defaultStateDir(), "logs"), dir),
    onProgress: opts.onProgress,
  })
  const auditResult = doAudit ? await audit(dir, { base: opts.base!, allowed, block: settings.audit.block, warn: settings.audit.warn }) : undefined
  const blockers = [
    ...checks.filter((c) => !c.pass).map((c) => `${c.name}: ${summary(c)}`),
    ...(auditResult?.findings.filter((f) => f.severity === "block").map(findingLine) ?? []),
  ]
  const warnings = auditResult?.findings.filter((f) => f.severity === "warn").map(findingLine) ?? []
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
  if (n) return [`${n.failed} failed`, n.passed !== undefined && `${n.passed} passed`, n.skipped && `${n.skipped} skipped`].filter(Boolean).join(", ")
  return `exit ${c.code}`
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
  const parts = [
    failed.length && `${failed.length} check${failed.length > 1 ? "s" : ""} failed`,
    blocking.length && `${blocking.length} blocking finding${blocking.length > 1 ? "s" : ""}`,
    v.warnings.length && `${v.warnings.length} warning${v.warnings.length > 1 ? "s" : ""}`,
  ].filter(Boolean)
  const head = `${v.pass ? "PASS" : "FAIL"}${parts.length ? ` · ${parts.join(", ")}` : ""} · ${formatDuration(v.durationMs)}${cached ? " (cached: tree unchanged)" : ""}`
  const sections: Section[] = [{ text: head, required: true }]
  if (!v.checks.length) sections.push({ text: "no checks found (configure verify.checks in horde.json)", required: true })
  // One status line per check, failing ones first.
  for (const c of [...failed, ...v.checks.filter((x) => x.pass)]) {
    sections.push({ text: `${c.pass ? "✓" : "✗"} ${c.name} · ${c.pass ? summaryPass(c) : summary(c)} · ${formatDuration(c.durationMs)}`, required: !c.pass })
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
