import fs from "node:fs"
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

const quote = (w: string) => (/^[\w./:@%+=,-]+$/.test(w) ? w : `"${w}"`)

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
        if (body.includes("\n")) return undefined
        word += body
        i = end + 1
      } else if (c === '"') {
        const end = s.indexOf('"', i + 1)
        if (end < 0) return undefined
        const body = s.slice(i + 1, end)
        if (/[$`\\\n]/.test(body)) return undefined
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

/**
 * True when `command` is exactly the worker CLI (the argv prefix, then
 * `--state <dir>`, then a worker subcommand) with plain arguments. Used by the
 * agent runtime to auto-approve board commands without approving anything else.
 */
export function isTrustedCommand(command: string, argv = cliArgv()): boolean {
  const words = shellWords(command)
  if (!words || words.length < argv.length + 3) return false
  for (let k = 0; k < argv.length; k++) if (words[k] !== argv[k]) return false
  if (words[argv.length] !== "--state" || !words[argv.length + 1]) return false
  return (WORKER_COMMANDS as readonly string[]).includes(words[argv.length + 2]!)
}
