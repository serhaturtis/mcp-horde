/**
 * Runs `opencode serve` for a private-mode MCP server and stops it as soon as
 * the parent process disappears, even if the parent was SIGKILLed.
 *
 * usage: node supervisor.js <parentPid> <bin> ...args
 */
import { spawn, spawnSync } from "node:child_process"

const [parentArg, bin, ...args] = process.argv.slice(2)
const parent = Number(parentArg)
if (!parent || !bin) {
  console.error("usage: supervisor <parentPid> <bin> ...args")
  process.exit(2)
}

const isWindows = process.platform === "win32"
const child = spawn(bin, args, {
  cwd: process.env.HORDE_SUPERVISED_CWD || process.cwd(),
  stdio: ["ignore", "inherit", "inherit"],
  windowsHide: true,
  // A resolved .exe needs no shell; only fall back to one for .cmd/.bat shims.
  shell: isWindows && /\.(cmd|bat)$/i.test(bin),
  // Its own process group on POSIX, so stopping it also stops what it started (tool shells, LSPs, MCP servers).
  detached: !isWindows,
})

/** Signal OpenCode's whole process group (falls back to the process itself). */
const signalGroup = (signal: NodeJS.Signals) => {
  if (!child.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}

let stopping = false
const stop = () => {
  if (stopping || child.exitCode !== null) return
  stopping = true
  if (isWindows) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    return
  }
  signalGroup("SIGTERM")
  // Escalate if it does not shut down.
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signalGroup("SIGKILL")
  }, 5_000).unref()
}

child.on("exit", (code, signal) => {
  // Leftovers of the group (tools OpenCode started) must not outlive it.
  if (!isWindows && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {
      // nothing left
    }
  }
  const signals: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }
  process.exit(code ?? (signal ? 128 + (signals[signal] ?? 1) : 1))
})
child.on("error", (err) => {
  console.error(`failed to launch ${bin}: ${err.message}`)
  process.exit(1)
})
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, stop)

// Our stdin is a pipe from the MCP server: it closes on any parent death,
// including SIGKILL / TerminateProcess, on every platform.
process.stdin.on("end", stop)
process.stdin.on("close", stop)
process.stdin.on("error", stop)
process.stdin.resume()

setInterval(() => {
  try {
    process.kill(parent, 0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") stop()
  }
}, 1000).unref()
