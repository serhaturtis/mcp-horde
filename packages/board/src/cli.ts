#!/usr/bin/env node
/**
 * The worker side of the board, run with an agent's bash tool:
 *   horde --state <board dir> <command> …
 * Only worker commands exist here; planning, accepting and failing tasks are
 * the orchestrator's (MCP tools). Output is short, for a model to read.
 *
 * For humans: `horde status [task id] [--repo <dir> | --state <board dir>]` shows the
 * board (read-only; not a worker command, so never approved automatically).
 */
import path from "node:path"
import { loadTiers } from "@mcp-horde/core"
import { Board, type Report } from "./board.js"
import { renderNotes, renderSummary, renderTask } from "./render.js"

type Flags = Record<string, string[]>

function parse(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = []
  const flags: Flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const value = argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? argv[++i]! : "true"
      flags[key] = [...(flags[key] ?? []), value]
    } else positional.push(a)
  }
  return { positional, flags }
}

const csv = (values?: string[]) =>
  (values ?? [])
    .flatMap((v) => v.split(","))
    .map((s) => s.trim())
    .filter(Boolean)
const USAGE =
  "usage: horde --state <dir> task|progress|report|finding|findings|recall|lock|unlock …\n       horde status [task id] [--repo <dir> | --state <dir>]"

/** The board at a glance, or one task in full: what a human checks while the horde works. */
async function status(args: string[], flags: Flags): Promise<string> {
  const repo = path.resolve(flags.repo?.[0] ?? process.cwd())
  const board = flags.state?.[0] ? new Board(flags.state[0]) : await Board.open(repo)
  const tiers = loadTiers(repo)
  if (args[0]) return renderTask(board.task(args[0]), "full", Date.now(), await board.checkReport(args[0]), tiers)
  return renderSummary(board, 6000)
}

async function main(argv: string[]): Promise<string> {
  const { positional, flags } = parse(argv)
  if (positional[0] === "status") return status(positional.slice(1), flags)
  const state = flags.state?.[0]
  if (!state) throw new Error(`missing --state <dir>\n${USAGE}`)
  const board = new Board(state)
  const [command, ...args] = positional
  const need = (n: number, what: string) => {
    if (args.length < n) throw new Error(`${command} needs ${what}`)
  }
  switch (command) {
    case "task": {
      need(2, "<task id> <token>")
      const t = await board.seen(args[0]!, args[1]!)
      return `${renderTask(t, "full")}\n\nReport with: report ${t.id} <token> --summary "…" when done.`
    }
    case "progress": {
      need(3, '<task id> <token> "note"')
      await board.seen(args[0]!, args[1]!, args.slice(2).join(" "))
      return "noted"
    }
    case "report": {
      need(2, "<task id> <token> --summary …")
      const summary = flags.summary?.join(" ")
      if (!summary) throw new Error('report needs --summary "what you did"')
      const confidence = flags.confidence?.[0] as Report["confidence"] | undefined
      if (confidence && !["low", "medium", "high"].includes(confidence)) throw new Error("--confidence must be low, medium or high")
      const t = await board.report(args[0]!, args[1]!, {
        summary,
        filesChanged: csv(flags.changed),
        testsAdded: csv(flags.tests),
        decisions: flags.decision ?? [],
        questions: flags.question ?? [],
        unverifiedClaims: flags.unverified ?? [],
        confidence,
      })
      return `report filed for ${t.id}; the orchestrator will review it. You can finish now.`
    }
    case "finding": {
      need(1, '"the fact"')
      const n = await board.finding(args.join(" "), { paths: csv(flags.paths), tags: csv(flags.tags), task: flags.task?.[0], token: flags.token?.[0] })
      return `shared as ${n.id}`
    }
    case "findings":
      return renderNotes(board.findings({ paths: csv(flags.paths), tags: csv(flags.tags) }), "no findings yet")
    case "recall":
      need(1, '"what to look for"')
      return renderNotes(board.memory({ query: args.join(" ") }), "nothing remembered about that")
    case "lock": {
      need(3, "<task id> <token> <paths…>")
      const r = await board.lock(args[0]!, args[1]!, args.slice(2))
      if (r.ok) return `locked ${args.slice(2).join(", ")}`
      throw new Error(`refused: ${r.conflicts.map((c) => `${c.path} is locked by ${c.task}`).join("; ")}. Do not edit these; mention it in your report.`)
    }
    case "unlock": {
      need(3, "<task id> <token> <paths…>")
      return `released ${await board.workerUnlock(args[0]!, args[1]!, args.slice(2))} lock(s)`
    }
    default:
      throw new Error(command ? `unknown command "${command}"\n${USAGE}` : USAGE)
  }
}

main(process.argv.slice(2)).then(
  (out) => {
    process.stdout.write(`${out}\n`)
  },
  (err: Error) => {
    process.stderr.write(`error: ${err.message}\n`)
    process.exitCode = 1
  },
)
