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

/** A lock file's holder: the task when it recorded one, else the process that took it. */
export interface CheckHolder {
  pid?: number
  host?: string
  task?: string
}

/**
 * What a check is doing right now: running, or waiting for a slot another run holds. `since` is
 * when that state began (for a wait, when this run first found the slot taken).
 */
export interface CheckState {
  check: string
  phase: "running" | "waiting"
  /** waiting: the lock name, e.g. "check-test". */
  slot?: string
  /** waiting: the lock file's holder. */
  holder?: CheckHolder
  since: number
}

export interface RunChecksOptions {
  timeoutMs: number
  signal?: AbortSignal
  /** Where to keep each check's full output. */
  logDir?: string
  onProgress?: (message: string) => void
  /** Called when a check starts running, and while it waits for a slot, so a caller can say why it is slow. */
  onCheck?: (state: CheckState) => void
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

/**
 * Inherited credentials a check must not see: the caller's keys are not the project's. Suffix
 * matching covers the many *_API_KEY/*_TOKEN/*_SECRET/*_PASSWORD names; the list covers keys
 * whose names do not end that way (AWS_SECRET_ACCESS_KEY). A check that needs one names it in
 * its horde.json `env`, which is applied after the strip.
 */
const SECRET_ENV = /_(?:API_KEY|TOKEN|SECRET|PASSWORD)$/
const KNOWN_SECRET_ENV = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "MOONSHOT_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
]

/** The inherited credential names to strip, both the known ones and whatever this process has. */
function secretEnvNames(): string[] {
  const names = new Set(KNOWN_SECRET_ENV)
  for (const name of Object.keys(process.env)) if (SECRET_ENV.test(name)) names.add(name)
  return [...names]
}

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
  const secrets = secretEnvNames()
  // Task variables (HORDE_TASK, HORDE_WORKTREE, …) reach checks on purpose, but no inherited
  // credential does: only the check's own env may set one.
  const sharedEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(opts.env ?? {})) if (!secrets.includes(k) && !SECRET_ENV.test(k)) sharedEnv[k] = v
  for (const check of checks) {
    if (opts.signal?.aborted) break
    opts.onProgress?.(`${check.name}: ${check.command}`)
    const r = await holding(check, opts, () =>
      runCommand(check.command, {
        cwd: check.cwd,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        env: { ...CI_ENV, ...sharedEnv, ...check.env },
        stripEnv: [...STRIP_ENV, ...secrets, ...(check.stripEnv ?? [])],
        maxChars: MAX_LOG_CHARS,
        onProgress: (line) => opts.onProgress?.(`${check.name}: ${line}`),
        progressMs: 10_000,
      }),
    ).catch((err: Error) => ({ code: null, stopped: undefined, output: `could not start: ${err.message}`, truncated: 0, durationMs: 0 }))
    const extracted: Extracted = extract(r.output, check.command, check.cwd)
    // Exit 0 is not enough: `… | tail`, a wrapper without `set -e`, or `…; echo done`
    // can hide the runner's exit code while its output still reports failures.
    // The counts the runner printed are the truth, not the pipeline's last exit code.
    const pass = r.code === 0 && !r.stopped && (extracted.counts?.failed ?? 0) === 0
    let logFile: string | undefined
    if (opts.logDir) {
      logFile = logFileFor(opts.logDir, check.name)
      fs.writeFileSync(logFile, `$ ${check.command}\n# cwd ${check.cwd}\n# exit ${r.code ?? r.stopped ?? "signal"} after ${r.durationMs}ms\n\n${r.output}`, {
        mode: 0o600,
      })
    }
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
  const run = () => {
    opts.onCheck?.({ check: check.name, phase: "running", since: Date.now() })
    return fn()
  }
  if (!needs.length || !dir) return run()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Slots first, then the resource: the same order everywhere, so two checks never wait on each other.
  return needs.reduceRight<() => Promise<T>>((inner, need) => () => slot(dir, need.name, need.count, check.name, opts, inner), run)()
}

/** The holder a lock file records, if it is still readable. */
function holderOf(file: string): CheckHolder | undefined {
  try {
    const h = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
    const holder: CheckHolder = {}
    if (typeof h.pid === "number") holder.pid = h.pid
    if (typeof h.host === "string") holder.host = h.host
    if (typeof h.task === "string") holder.task = h.task
    return holder
  } catch {
    return undefined
  }
}

/** One of `count` slots named `name`, held while `fn` runs (core's withLock, so a dead holder frees it). */
async function slot<T>(dir: string, name: string, count: number, check: string, opts: RunChecksOptions, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs
  let said = false
  let since: number | undefined
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
    since ??= Date.now()
    let holder: CheckHolder | undefined
    for (let i = 0; i < count && !holder; i++) holder = holderOf(`${path.join(dir, `${name}.${i}.lock`)}`)
    opts.onCheck?.({ check, phase: "waiting", slot: name, holder, since })
    if (!said) opts.onProgress?.(`${check}: waiting for ${name} (all ${count} slot${count > 1 ? "s" : ""} taken)`)
    said = true
    await new Promise((r) => setTimeout(r, 1000))
  }
}
