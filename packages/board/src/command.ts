import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * How workers reach the board: a CLI they run with their `bash` tool (OpenCode's
 * v2 runners offer no MCP tools yet). The brief gives the exact invocation, and
 * `isTrustedCommand` lets the agent runtime approve precisely that and nothing
 * chained onto it.
 */

/** Subcommands a worker may run. Orchestrator operations are not reachable from the CLI. */
export const WORKER_COMMANDS = ["task", "progress", "report", "finding", "findings", "recall", "lock", "unlock"] as const

/** Forward slashes everywhere: Node accepts them on Windows, and the trust check can then reject backslashes outright. */
const fwd = (p: string) => p.replace(/\\/g, "/")

/** argv prefix that runs the CLI: the built file, or the TypeScript source through tsx (development and tests). */
export function cliArgv(): string[] {
  const built = fileURLToPath(new URL("./cli.js", import.meta.url))
  if (fs.existsSync(built)) return [fwd(process.execPath), fwd(built)]
  const source = fileURLToPath(new URL("./cli.ts", import.meta.url))
  const tsx = fwd(fileURLToPath(import.meta.resolve("tsx")))
  return [fwd(process.execPath), "--conditions=source", "--import", `file://${tsx.startsWith("/") ? "" : "/"}${tsx}`, fwd(source)]
}

// Single quotes protect everything but a quote itself (POSIX shells). cmd.exe knows only double
// quotes, and a path with a single quote cannot be single-quoted for the trust check (which
// accepts no backslashes): those stay double-quoted.
const quote = (w: string) => (/^[\w./:@%+=,-]+$/.test(w) ? w : process.platform === "win32" || w.includes("'") ? `"${w}"` : `'${w}'`)

/** The command prefix a brief tells the worker to use, for a given board state directory. */
export function workerCommand(stateDir: string): string {
  return [...cliArgv(), "--state", fwd(stateDir)].map(quote).join(" ")
}

/**
 * Split a shell command into words, accepting only what cannot run anything
 * else: plain words, 'single-quoted' strings (anything but a quote) and
 * "double-quoted" strings without $, backticks or backslashes. Anything else
 * (;, &, |, <, >, $, `, \, newlines, globs, braces, unbalanced quotes) returns
 * undefined.
 */
export function shellWords(command: string): string[] | undefined {
  const words: string[] = []
  let i = 0
  const s = command.trim()
  while (i < s.length) {
    while (s[i] === " ") i++
    if (i >= s.length) break
    let word = ""
    let any = false
    while (i < s.length && s[i] !== " ") {
      const c = s[i]!
      if (c === "'") {
        const end = s.indexOf("'", i + 1)
        if (end < 0) return undefined
        const body = s.slice(i + 1, end)
        // Control characters (newlines, escape sequences) would reach people's terminals.
        if (CONTROL.test(body)) return undefined
        word += body
        i = end + 1
      } else if (c === '"') {
        const end = s.indexOf('"', i + 1)
        if (end < 0) return undefined
        const body = s.slice(i + 1, end)
        if (/[$`\\]/.test(body) || CONTROL.test(body)) return undefined
        word += body
        i = end + 1
      } else if (/[\w./:@%+=,-]/.test(c)) {
        word += c
        i++
      } else return undefined
      any = true
    }
    if (any) words.push(word)
  }
  return words
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL = /[\x00-\x1f\x7f]/

const samePath = (a: string, b: string) => {
  const norm = (p: string) => fwd(path.resolve(p)).replace(/\/+$/, "")
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b)
}

/**
 * True when `command` is exactly the worker CLI (the argv prefix, then
 * `--state <dir>`, then a worker subcommand) with plain arguments. Used by the
 * agent runtime to auto-approve board commands without approving anything else.
 * `state` is the board the worker belongs to: a command naming any other
 * directory is not trusted (it would create board files there, or read another
 * repository's notes).
 */
export function isTrustedCommand(command: string, opts: { state?: string; argv?: string[] } = {}): boolean {
  const argv = opts.argv ?? cliArgv()
  const words = shellWords(command)
  if (!words || words.length < argv.length + 3) return false
  for (let k = 0; k < argv.length; k++) if (words[k] !== argv[k]) return false
  const dir = words[argv.length + 1]
  if (words[argv.length] !== "--state" || !dir || dir.startsWith("-")) return false
  if (opts.state !== undefined && !samePath(dir, opts.state)) return false
  return (WORKER_COMMANDS as readonly string[]).includes(words[argv.length + 2]!)
}
