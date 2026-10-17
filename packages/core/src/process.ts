import { spawn, spawnSync } from "node:child_process"

const isWindows = process.platform === "win32"

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
    const collect = (chunk: Buffer) => {
      const text = chunk.toString()
      total += text.length
      if (head.length < half) {
        const room = half - head.length
        head += text.slice(0, room)
        tail = (tail + text.slice(room)).slice(-half)
      } else tail = (tail + text).slice(-half)
      const lines = text.trimEnd().split("\n")
      lastLine = lines[lines.length - 1] ?? lastLine
    }
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    let stopped: RunResult["stopped"]
    const killAll = () => {
      if (child.exitCode !== null || child.pid === undefined) return
      killTree(child.pid, !isWindows, "SIGKILL")
    }
    const timer = setTimeout(
      () => {
        stopped = "timeout"
        killAll()
      },
      opts.timeoutMs ?? 10 * 60_000,
    )
    const onAbort = () => {
      stopped = "cancelled"
      killAll()
    }
    if (opts.signal?.aborted) onAbort()
    opts.signal?.addEventListener("abort", onAbort)
    const ticker = opts.onProgress ? setInterval(() => opts.onProgress?.(lastLine.slice(0, 200)), opts.progressMs ?? 5_000) : undefined
    const done = () => {
      clearTimeout(timer)
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
