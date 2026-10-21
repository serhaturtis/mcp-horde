import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { runCommand, withLock } from "@mcp-horde/core"
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
  /** How this check compared with the baseline commit, when one was given. */
  baseline?: { label: string; pass: boolean; known: number }
}

export interface RunChecksOptions {
  timeoutMs: number
  signal?: AbortSignal
  /** Where to keep each check's full output. */
  logDir?: string
  onProgress?: (message: string) => void
  /** Stop after the first failing check (default: run them all, so the verdict is complete). */
  failFast?: boolean
  /** Variables for every check, e.g. a task's HORDE_TASK and HORDE_WORKTREE. */
  env?: Record<string, string>
  /** Where checks with `slots` or `exclusive` take their locks: one directory per repository, shared by its worktrees. */
  lockDir?: string
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
    const r = await holding(check, opts, () =>
      runCommand(check.command, {
        cwd: check.cwd,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        env: { ...CI_ENV, ...opts.env, ...check.env },
        stripEnv: [...STRIP_ENV, ...(check.stripEnv ?? [])],
        maxChars: MAX_LOG_CHARS,
        onProgress: (line) => opts.onProgress?.(`${check.name}: ${line}`),
        progressMs: 10_000,
      }),
    ).catch((err: Error) => ({ code: null, stopped: undefined, output: `could not start: ${err.message}`, truncated: 0, durationMs: 0 }))
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

/** Runs `fn` holding the check's slot and its exclusive resource, when it names them. */
async function holding<T>(check: Check, opts: RunChecksOptions, fn: () => Promise<T>): Promise<T> {
  const needs = [
    ...(check.slots ? [{ name: `check-${check.name}`, count: check.slots }] : []),
    ...(check.exclusive ? [{ name: `resource-${check.exclusive}`, count: 1 }] : []),
  ]
  const dir = opts.lockDir
  if (!needs.length || !dir) return fn()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Slots first, then the resource: the same order everywhere, so two checks never wait on each other.
  return needs.reduceRight<() => Promise<T>>((inner, need) => () => slot(dir, need.name, need.count, check.name, opts, inner), fn)()
}

/** One of `count` slots named `name`, held while `fn` runs (core's withLock, so a dead holder frees it). */
async function slot<T>(dir: string, name: string, count: number, check: string, opts: RunChecksOptions, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs
  let said = false
  for (;;) {
    for (let i = 0; i < count; i++) {
      let started = false
      try {
        return await withLock(
          dir,
          `${name}.${i}`,
          () => {
            started = true
            return fn()
          },
          0,
        )
      } catch (err) {
        if (started || !/^timed out waiting for /.test((err as Error).message)) throw err
      }
    }
    if (opts.signal?.aborted) throw new Error(`cancelled while waiting for ${name}`)
    if (Date.now() > deadline) throw new Error(`waited ${Math.round(opts.timeoutMs / 1000)}s for ${name}: all ${count} of its slot(s) stayed taken`)
    if (!said) opts.onProgress?.(`${check}: waiting for ${name} (all ${count} slot${count > 1 ? "s" : ""} taken)`)
    said = true
    await new Promise((r) => setTimeout(r, 1000))
  }
}
