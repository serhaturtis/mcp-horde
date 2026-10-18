import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { runCommand } from "@mcp-horde/core"
import type { Check, CheckKind } from "./detect.js"
import { type Extracted, extract } from "./extract.js"
import type { Narrowing } from "./related.js"

export interface CheckResult {
  name: string
  command: string
  kind: CheckKind
  pass: boolean
  code: number | null
  stopped?: "timeout" | "cancelled"
  durationMs: number
  extracted: Extracted
  /** Full (capped) output of this run, for verify_logs. */
  logFile?: string
  /** How a related-tests run narrowed (or skipped) this check. */
  related?: Narrowing
}

export interface RunChecksOptions {
  timeoutMs: number
  signal?: AbortSignal
  /** Where to keep each check's full output. */
  logDir?: string
  onProgress?: (message: string) => void
  /** Stop after the first failing check (default: run them all, so the verdict is complete). */
  failFast?: boolean
}

/** Output kept per check: plenty for any extractor, bounded for pathological logs. */
const MAX_LOG_CHARS = 8 * 1024 * 1024

/**
 * Variables that make tools behave as in CI: no colour, no interactive
 * prompts, no watch mode. FORCE_COLOR is removed rather than set to 0,
 * because some tools (ruff, for one) treat any value as "force colour on".
 */
const CI_ENV = { CI: "1", NO_COLOR: "1", TERM: "dumb", PY_COLORS: "0", CARGO_TERM_COLOR: "never", GIT_TERMINAL_PROMPT: "0" }
/**
 * Inherited variables a check must not see. NODE_TEST_CONTEXT in particular:
 * node's test runner sets it in its children, and a `node --test` that
 * inherits it reports to a parent that is not listening and exits 0.
 */
const STRIP_ENV = ["FORCE_COLOR", "CLICOLOR_FORCE", "NODE_TEST_CONTEXT", "OPENCODE_SERVER_", "HORDE_"]

/** Per-directory log location, stable across runs (the latest run replaces the previous one). */
export function logDirFor(base: string, directory: string): string {
  const key = createHash("sha256").update(path.resolve(directory)).digest("hex").slice(0, 16)
  return path.join(base, key)
}

export function logFileFor(logDir: string, check: string): string {
  const safe = check.replace(/[^\w.-]+/g, "_")
  // A name the replacement changed gets a hash of the original, so test:unit and test_unit keep separate logs.
  return path.join(logDir, safe === check ? `${safe}.log` : `${safe}-${createHash("sha256").update(check).digest("hex").slice(0, 8)}.log`)
}

export async function runChecks(checks: Check[], opts: RunChecksOptions): Promise<CheckResult[]> {
  if (opts.logDir) fs.mkdirSync(opts.logDir, { recursive: true, mode: 0o700 })
  const results: CheckResult[] = []
  for (const check of checks) {
    if (opts.signal?.aborted) break
    opts.onProgress?.(`${check.name}: ${check.command}`)
    const r = await runCommand(check.command, {
      cwd: check.cwd,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      env: { ...CI_ENV, ...check.env },
      stripEnv: [...STRIP_ENV, ...(check.stripEnv ?? [])],
      maxChars: MAX_LOG_CHARS,
      onProgress: (line) => opts.onProgress?.(`${check.name}: ${line}`),
      progressMs: 10_000,
    }).catch((err: Error) => ({ code: null, stopped: undefined, output: `could not start: ${err.message}`, truncated: 0, durationMs: 0 }))
    const pass = r.code === 0 && !r.stopped
    let logFile: string | undefined
    if (opts.logDir) {
      logFile = logFileFor(opts.logDir, check.name)
      fs.writeFileSync(logFile, `$ ${check.command}\n# cwd ${check.cwd}\n# exit ${r.code ?? r.stopped ?? "signal"} after ${r.durationMs}ms\n\n${r.output}`, {
        mode: 0o600,
      })
    }
    const extracted: Extracted = pass ? { runner: "generic", failures: [] } : extract(r.output, check.command, check.cwd)
    // A failing check must say why, even when its runner reported no failures
    // (coverage thresholds, crashed reporters, timeouts): show the end of the output.
    if (!pass && !extracted.failures.length) {
      const tail = r.output
        .split("\n")
        .filter((l) => l.trim())
        .slice(-15)
        .join("\n")
      const why = r.stopped === "timeout" ? `timed out after ${Math.round(opts.timeoutMs / 1000)}s` : r.stopped === "cancelled" ? "cancelled" : `exit ${r.code}`
      extracted.failures.push({ message: tail ? `${why}; last output:\n${tail}` : `${why} with no output` })
    }
    if (pass) {
      // Passing runs still report their counts when the runner printed them.
      const counts = extract(r.output, check.command, check.cwd).counts
      if (counts) extracted.counts = counts
    }
    results.push({
      name: check.name,
      command: check.command,
      kind: check.kind,
      pass,
      code: r.code,
      stopped: r.stopped,
      durationMs: r.durationMs,
      extracted,
      logFile,
    })
    if (!pass && opts.failFast) break
  }
  return results
}
