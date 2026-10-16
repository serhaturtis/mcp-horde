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

const child = spawn(bin, args, {
  cwd: process.env.HORDE_SUPERVISED_CWD || process.cwd(),
  stdio: "inherit",
  windowsHide: true,
  shell: process.platform === "win32",
})
const stop = () => {
  if (child.exitCode !== null) return
  // On Windows the binary runs behind a .cmd shim: kill the whole tree.
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
  else child.kill("SIGTERM")
}
child.on("exit", (code) => process.exit(code ?? 0))
child.on("error", (err) => {
  console.error(`failed to launch ${bin}: ${err.message}`)
  process.exit(1)
})
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, stop)

setInterval(() => {
  try {
    process.kill(parent, 0)
  } catch {
    stop()
  }
}, 1000).unref()
