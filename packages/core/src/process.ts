import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const isWindows = process.platform === "win32"

/**
 * Note a server's start, and how it ends, in one log the horde's servers share
 * ($XDG_STATE_HOME/mcp-horde/servers.log): the signal it got, its stdin closing, an uncaught
 * exception with its stack, the exit code. A server that vanished from its client says why;
 * nothing at all after "started" means it was killed outright (SIGKILL).
 * ponytail: the log only grows (a few lines per server start); rotate it if that ever matters.
 */
export function recordLifecycle(name: string, version: string): void {
  const file = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "mcp-horde", "servers.log")
  const note = (what: string) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, `${new Date().toISOString()} ${name} pid ${process.pid}: ${what}\n`)
    } catch {
      // Logging must never be what breaks a server.
    }
  }
  note(`started (version ${version}, parent ${process.ppid})`)
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

/**
 * Run a shell command in its own process group (Windows: its own tree), killed
 * as a whole on timeout or abort. Never rejects for a failing command: the
 * result says what happened. Rejects only when the shell cannot be started.
 */
export function runCommand(command: string, opts: RunOptions): Promise<RunResult> {
  const env: Record<string, string | undefined> = { ...process.env, ...opts.env }
  for (const prefix of opts.stripEnv ?? []) for (const k of Object.keys(env)) if (k.startsWith(prefix)) delete env[k]
  const maxChars = opts.maxChars ?? 1_000_000
  const half = Math.floor(maxChars / 2)
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd: opts.cwd, env, shell: true, stdio: ["ignore", "pipe", "pipe"], detached: !isWindows, windowsHide: true })
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
