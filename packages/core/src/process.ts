import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const isWindows = process.platform === "win32"

/**
 * Note a server's start, and how it ends, in one log the horde's servers share
 * ($XDG_STATE_HOME/mcp-horde/servers.log): the signal it got, its stdin closing, an uncaught
 * exception with its stack, the exit code. A server that vanished from its client says why.
 * A native abort (V8 out of memory, a failed internal check) skips all of that: Node then writes a
 * report (report.*.json, with the error, the stack and heap statistics) next to the log, and the
 * log notes each new high of the heap. Nothing at all after "started", and no report: SIGKILL.
 * ponytail: the log only grows (a few lines per server start); rotate it if that ever matters.
 */
export function recordLifecycle(name: string, version: string): void {
  const file = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "mcp-horde", "servers.log")
  const note = (what: string) => {
    try {
      // Private to the user: the log names sessions and pids, and Node's fatal-error reports land beside it.
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      fs.appendFileSync(file, `${new Date().toISOString()} ${name} pid ${process.pid}: ${what}\n`, { mode: 0o600 })
      if (!isWindows && (fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600)
    } catch {
      // Logging must never be what breaks a server.
    }
  }
  note(`started (version ${version}, parent ${process.ppid})`)
  try {
    process.report.directory = path.dirname(file)
    process.report.reportOnFatalError = true
  } catch {
    // No report support: the log still says the rest.
  }
  let high = 0
  setInterval(() => {
    const m = process.memoryUsage()
    if (m.heapUsed < (high + 1) * 512e6) return
    high = Math.floor(m.heapUsed / 512e6)
    note(`heap ${Math.round(m.heapUsed / 1e6)} MB (new high), external ${Math.round(m.external / 1e6)} MB, rss ${Math.round(m.rss / 1e6)} MB`)
  }, 30_000).unref()
  process.on("uncaughtException", (err) => {
    note(`uncaught exception: ${err.stack ?? err.message}`)
    process.stderr.write(`[mcp-horde/${name}] ${err.stack ?? err.message}\n`)
    process.exit(1)
  })
  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
    ["SIGHUP", 129],
  ] as const) {
    process.on(signal, () => {
      note(`got ${signal}`)
      // The only listener: keep the default of exiting. A server with its own handler stops itself.
      if (process.listenerCount(signal) === 1) process.exit(code)
    })
  }
  process.stdin.once("close", () => note("stdin closed by the client"))
  process.once("exit", (code) => note(`exited with code ${code} after ${Math.round(process.uptime())}s`))
}

/** Stop a process and everything it started (`group`: it leads its own process group). */
export function killTree(pid: number, group: boolean, signal: NodeJS.Signals = "SIGTERM") {
  try {
    if (isWindows) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    else process.kill(group ? -pid : pid, signal)
  } catch {
    try {
      if (!isWindows && group) process.kill(pid, signal)
    } catch {
      // Already gone.
    }
  }
}

/** Whether HORDE_SCOPE asks for transient systemd user scopes (anything except off/0/false/no). */
export function scopeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.HORDE_SCOPE?.trim().toLowerCase()
  return !(value === "off" || value === "0" || value === "false" || value === "no")
}

/** The validated HORDE_MEMORY_HIGH value, or undefined when it is unset. */
export function memoryHigh(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.HORDE_MEMORY_HIGH?.trim()
  if (!value) return undefined
  if (!/^(?:\d+(?:[KMGT])?|\d+%)$/i.test(value)) {
    throw new Error(`HORDE_MEMORY_HIGH must be a size (digits with an optional K/M/G/T suffix) or a percentage, got "${value}"`)
  }
  return value
}

/** Probe once per process: the answer cannot change for the life of a server. */
let scopeProbe: boolean | undefined
type ScopeProbe = (env: NodeJS.ProcessEnv) => boolean

function probeSystemd(env: NodeJS.ProcessEnv): boolean {
  try {
    const res = spawnSync("systemd-run", ["--user", "--scope", "--quiet", "--", "true"], { env, stdio: "ignore", timeout: 5_000 })
    return res.status === 0
  } catch {
    return false
  }
}

/**
 * Whether a transient systemd user scope can be used here: Linux, not disabled, a user manager
 * reachable through XDG_RUNTIME_DIR, and systemd-run working. Missing pieces just mean no scope.
 */
export function scopeAvailable(env: NodeJS.ProcessEnv = process.env, platform = process.platform, probe?: ScopeProbe): boolean {
  if (platform !== "linux" || !scopeEnabled(env) || !env.XDG_RUNTIME_DIR) return false
  // A supplied probe is a test override and must not decide the cached answer for this process.
  if (probe) return probe(env)
  if (scopeProbe === undefined) scopeProbe = probeSystemd(env)
  return scopeProbe
}

export interface ScopeOptions {
  /** Transient unit name, e.g. horde-check-<pid>-<n>. */
  unit: string
  /** MemoryHigh= for the scope; defaults to HORDE_MEMORY_HIGH. */
  memoryHigh?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Override the availability check (tests, or a caller that already probed). */
  available?: boolean
  probe?: ScopeProbe
}

export interface ScopedCommand {
  command: string
  args: string[]
  /** True when the command runs through systemd-run. */
  scoped: boolean
}

/**
 * Build the command that runs in its own transient systemd user scope, or the command itself
 * when no user manager is reachable (macOS, containers, WSL without systemd) or HORDE_SCOPE=off.
 */
export function scopeCommand(command: string[], opts: ScopeOptions): ScopedCommand {
  const env = opts.env ?? process.env
  const available = opts.available ?? scopeAvailable(env, opts.platform, opts.probe)
  if (!available || command.length === 0) return { command: command[0] ?? "", args: command.slice(1), scoped: false }
  const high = opts.memoryHigh ?? memoryHigh(env)
  const args = ["--user", "--scope", "--quiet", `--unit=${opts.unit}`]
  if (high) args.push(`--property=MemoryHigh=${high}`)
  args.push("--", ...command)
  return { command: "systemd-run", args, scoped: true }
}

export interface RunOptions {
  cwd: string
  /** Kill the whole process tree after this long (default 10 minutes). */
  timeoutMs?: number
  signal?: AbortSignal
  /** Extra environment variables. */
  env?: Record<string, string>
  /** Drop inherited variables whose names start with one of these (e.g. credentials). */
  stripEnv?: string[]
  /** Keep at most this many characters of output: the head and the tail, with a marker between. */
  maxChars?: number
  /** Called at most every `progressMs` with the latest output line while the command runs. */
  onProgress?: (lastLine: string) => void
  progressMs?: number
}

export interface RunResult {
  /** Exit code; null when the process was killed by a signal. */
  code: number | null
  /** Why it was stopped, when it was. */
  stopped?: "timeout" | "cancelled"
  /** stdout and stderr interleaved as they arrived, capped (see `truncated`). */
  output: string
  /** Characters dropped from the middle of the output. */
  truncated: number
  durationMs: number
}

/** Unique per horde process, so concurrent checks never share a transient unit. */
let checkSequence = 0

/**
 * Run a shell command in its own process group (Windows: its own tree), killed
 * as a whole on timeout or abort. On Linux with a systemd user manager it runs
 * in its own transient scope, so its memory and page cache do not count against
 * the session that started the horde. Never rejects for a failing command: the
 * result says what happened. Rejects only when the shell cannot be started.
 */
export function runCommand(command: string, opts: RunOptions): Promise<RunResult> {
  // Prefixes strip what the command would inherit, never what the caller passes on purpose.
  const env: Record<string, string | undefined> = { ...process.env }
  for (const prefix of opts.stripEnv ?? []) for (const k of Object.keys(env)) if (k.startsWith(prefix)) delete env[k]
  Object.assign(env, opts.env)
  const maxChars = opts.maxChars ?? 1_000_000
  const half = Math.floor(maxChars / 2)
  const started = Date.now()
  // The Claude Code session must not be the scope that owns the horde's builds: their page cache
  // (cargo target/, node_modules) otherwise makes its cgroup the one systemd-oomd kills.
  const scope = scopeCommand(["/bin/sh", "-c", command], {
    unit: `horde-check-${process.pid}-${++checkSequence}`,
    env: { ...process.env, ...opts.env },
  })
  return new Promise((resolve, reject) => {
    const child = scope.scoped
      ? spawn(scope.command, scope.args, { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true })
      : spawn(command, { cwd: opts.cwd, env, shell: true, stdio: ["ignore", "pipe", "pipe"], detached: !isWindows, windowsHide: true })
    // Head is kept verbatim; the tail is a rolling window. Both together never exceed maxChars.
    let head = ""
    let tail = ""
    let total = 0
    let lastLine = ""
    const collect = (text: string) => {
      total += text.length
      if (head.length < half) {
        const room = half - head.length
        head += text.slice(0, room)
        tail = (tail + text.slice(room)).slice(-half)
      } else tail = (tail + text).slice(-half)
      const lines = text.trimEnd().split("\n")
      lastLine = lines[lines.length - 1] ?? lastLine
    }
    // Decoded per stream, so a character split across chunks stays whole.
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    let stopped: RunResult["stopped"]
    // The whole group, even when the shell itself has exited: what it started in the
    // background can still hold the output pipes open, and "close" waits for them.
    const killAll = () => {
      if (child.pid !== undefined) killTree(child.pid, !isWindows, "SIGKILL")
    }
    // After a timeout or abort, give up on output a process outside the group still holds.
    const stopReading = () => {
      const t = setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
      }, 3_000)
      t.unref()
    }
    const timer = setTimeout(
      () => {
        stopped = "timeout"
        killAll()
        stopReading()
      },
      opts.timeoutMs ?? 10 * 60_000,
    )
    const onAbort = () => {
      stopped = "cancelled"
      killAll()
      stopReading()
    }
    if (opts.signal?.aborted) onAbort()
    opts.signal?.addEventListener("abort", onAbort)
    const ticker = opts.onProgress ? setInterval(() => opts.onProgress?.(lastLine.slice(0, 200)), opts.progressMs ?? 5_000) : undefined
    // A command that exits while its background children keep the pipes open is done:
    // after a grace period those children are stopped so the result can be read.
    let linger: NodeJS.Timeout | undefined
    // Something that left the group (setsid) can hold them even then: stop reading after
    // two more seconds, which lets "close" fire with what was collected.
    child.on("exit", () => {
      linger = setTimeout(() => {
        killAll()
        linger = setTimeout(() => {
          child.stdout.destroy()
          child.stderr.destroy()
        }, 2_000)
        linger.unref()
      }, 5_000)
      linger.unref()
    })
    const done = () => {
      clearTimeout(timer)
      clearTimeout(linger)
      if (ticker) clearInterval(ticker)
      opts.signal?.removeEventListener("abort", onAbort)
    }
    child.on("error", (e) => {
      done()
      reject(e)
    })
    // "close" fires after the output pipes drained, so the output is complete.
    child.on("close", (code) => {
      done()
      const kept = head.length + tail.length
      const truncated = Math.max(0, total - kept)
      const output = truncated ? `${head}\n[… ${truncated} chars omitted …]\n${tail}` : head + tail
      resolve({ code, stopped, output, truncated, durationMs: Date.now() - started })
    })
  })
}
