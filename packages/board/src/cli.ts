#!/usr/bin/env node
/**
 * The worker side of the board, run with an agent's shell tool:
 *   horde --state <board dir> <command> …
 * Only worker commands exist here; planning, accepting and failing tasks are
 * the orchestrator's (MCP tools). Output is short, for a model to read.
 *
 * For humans: `horde status [task id] [--repo <dir> | --state <board dir>]` shows the
 * board, and `horde watch` the same live in the terminal (both read-only; not worker
 * commands, so never approved automatically).
 */
import fs from "node:fs"
import path from "node:path"
import { branchSlug, defaultWorktreeDir, git, gitRaw, loadTiers, splitZ } from "@mcp-horde/core"
import { defaultStateDir, lockDirFor, logDirFor } from "@mcp-horde/verify"
import { Board, defaultStateRoot, projectOf, type Report } from "./board.js"
import { renderNotes, renderSummary, renderTask } from "./render.js"
import { printable, watch } from "./watch.js"

type Flags = Record<string, string[]>

/** Flags that stand alone (no value follows). */
const BOOLEAN_FLAGS = new Set(["yes"])

/** Flags that take a value: the next word is always the value, even when it starts with "--". */
const VALUE_FLAGS = new Set([
  "state",
  "repo",
  "interval",
  "summary",
  "changed",
  "tests",
  "unverified",
  "question",
  "decision",
  "confidence",
  "paths",
  "tags",
  "task",
  "token",
])

function parse(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = []
  const flags: Flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith("--")) {
      const eq = a.indexOf("=")
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2)
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = [...(flags[key] ?? []), eq > 0 ? a.slice(eq + 1) : "true"]
        continue
      }
      if (!VALUE_FLAGS.has(key)) throw new Error(`unknown flag --${key}`)
      if (eq < 0 && argv[i + 1] === undefined) throw new Error(`--${key} needs a value`)
      const value = eq > 0 ? a.slice(eq + 1) : argv[++i]!
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
  "usage: horde --state <dir> task|progress|report|finding|findings|recall|lock|unlock …\n       horde status [task id] | watch [--interval <seconds>]  [--repo <dir> | --state <dir>]\n       horde remove [--repo <dir>] [--yes]"

/** Refuse a --state directory that is not there: a typo would otherwise create an empty board at it. */
function knownState(state: string) {
  if (fs.existsSync(state)) return
  const root = path.dirname(state)
  const name = path.basename(state)
  const dash = name.lastIndexOf("-")
  const prefix = dash > 0 ? name.slice(0, dash + 1) : name
  const siblings = fs.existsSync(root)
    ? fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith(prefix))
        .map((d) => d.name)
        .sort()
    : []
  throw new Error(
    [
      `no board exists at ${state}`,
      ...(siblings.length ? [`boards in ${root}: ${siblings.join(", ")}`] : []),
      "copy the --state path from your brief exactly",
    ].join("\n"),
  )
}

/** The board a person asked for: --state, else the one of --repo or the current directory's repository. */
async function humanBoard(flags: Flags) {
  const repo = path.resolve(flags.repo?.[0] ?? process.cwd())
  const state = flags.state?.[0]
  if (state) knownState(state)
  return { board: state ? new Board(state) : await Board.open(repo), tiers: loadTiers(repo), repo }
}

/** The board at a glance, or one task in full: what a human checks while the horde works. */
async function status(args: string[], flags: Flags): Promise<string> {
  const { board, tiers } = await humanBoard(flags)
  if (args[0]) return renderTask(board.task(args[0]), "full", Date.now(), await board.checkReport(args[0]), tiers)
  return renderSummary(board, 6000)
}

/** Everything the horde keeps for one repository: board, worktrees, horde/* branches, check logs and locks. */
async function remove(flags: Flags): Promise<string> {
  const dir = path.resolve(flags.repo?.[0] ?? process.cwd())
  const { root, key, legacyKey } = await projectOf(dir)
  const stateRoot = defaultStateRoot()
  const verifyRoot = defaultStateDir()
  const worktreeRoot = defaultWorktreeDir()

  const boards = [...new Set([key, ...(legacyKey ? [legacyKey] : [])])].map((k) => path.join(stateRoot, k)).filter((p) => fs.existsSync(p))

  // git lists every linked worktree of this repository, wherever its session filed it. Only those
  // under the horde's worktree root and on a horde branch are the horde's.
  const registered: { path: string; branch?: string }[] = []
  for (const line of (await git(root, "worktree", "list", "--porcelain")).split("\n")) {
    if (line.startsWith("worktree ")) registered.push({ path: line.slice("worktree ".length) })
    else if (line.startsWith("branch ") && registered.length) registered[registered.length - 1]!.branch = line.slice("branch ".length)
  }
  const within = (p: string) => {
    const rel = path.relative(worktreeRoot, p)
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  }
  const worktrees = registered.filter((w): w is { path: string; branch: string } => !!w.branch && w.branch.startsWith("refs/heads/horde/") && within(w.path))

  // Uncommitted work is unlanded too, and gone with the worktree. Linked dependency trees are not work.
  const dependency = /(^|\/)(node_modules|\.venv|venv)(\/|$)/
  const uncommitted = async (worktree: string) => {
    const entries = splitZ(await gitRaw(worktree, ["status", "--porcelain", "-z", "--untracked-files=all"]).catch(() => ""))
    const paths: string[] = []
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!
      paths.push(entry.slice(3))
      // A rename or copy reports its original path as the next entry.
      if ("RC".includes(entry[0]!)) paths.push(entries[++i] ?? "")
    }
    return [...new Set(paths.filter((p) => p && !dependency.test(p)))]
  }
  const dirty = await Promise.all(worktrees.map((w) => uncommitted(w.path)))

  // Branches the horde made: those of its tasks, and those checked out in its worktrees.
  const taskBranches = new Set<string>()
  for (const p of boards)
    for (const t of new Board(p).tasks()) {
      taskBranches.add(`horde/${branchSlug(t.id)}`)
      // A task started with an explicit name lives in a worktree whose folder is that name's slug.
      for (const a of t.attempts) {
        if (!a.workspace?.path || !within(a.workspace.path)) continue
        const slot = path.relative(worktreeRoot, a.workspace.path).split(path.sep)[1]
        if (slot) taskBranches.add(`horde/${branchSlug(slot)}`)
      }
    }
  const hordeBranches = new Set([...taskBranches, ...worktrees.map((w) => w.branch.slice("refs/heads/".length))])
  // Each branch's commits that never landed on the current one are work the user may still want.
  const branches = await Promise.all(
    (await git(root, "for-each-ref", "--format=%(refname:short)", "refs/heads/horde/"))
      .split("\n")
      .filter(Boolean)
      .map(async (name) => ({
        name,
        ours: hordeBranches.has(name),
        ahead: Number(await git(root, "rev-list", "--count", `HEAD..${name}`).catch(() => "0")),
      })),
  )
  const removedBranches = branches.filter((b) => b.ours)
  const keptBranches = branches.filter((b) => !b.ours)

  const logBase = path.join(verifyRoot, "logs")
  const logs = [...new Set([root, ...worktrees.map((w) => w.path)].map((d) => logDirFor(logBase, d)))].filter((p) => fs.existsSync(p))
  const locks = await lockDirFor(root, verifyRoot)
  const yes = flags.yes !== undefined && flags.yes.at(-1) !== "false"

  const rows = [
    `horde remove ${root}`,
    "",
    yes ? "Removed:" : "Would remove:",
    "  board",
    ...(boards.length ? boards.map((p) => `    ${p}`) : ["    (none)"]),
    "  worktrees",
    ...(worktrees.length
      ? worktrees.flatMap((w, i) => [
          `    ${w.path}`,
          ...(dirty[i]!.length
            ? [
                `      unlanded work (will be lost): uncommitted changes in ${dirty[i]!.length} file${dirty[i]!.length === 1 ? "" : "s"}`,
                ...dirty[i]!.map((p) => `        ${p}`),
              ]
            : []),
        ])
      : ["    (none)"]),
    "  branches",
    ...(removedBranches.length
      ? removedBranches.map((b) => `    ${b.name} (${b.ahead} commit${b.ahead === 1 ? "" : "s"} not on the current branch)`)
      : ["    (none)"]),
    ...(keptBranches.length ? ["  kept branches", ...keptBranches.map((b) => `    ${b.name} (kept: not a horde task or worktree)`)] : []),
    "  check logs",
    ...(logs.length ? logs.map((p) => `    ${p}`) : ["    (none)"]),
    "  locks",
    `    ${locks}${fs.existsSync(locks) ? "" : " (none)"}`,
    "",
  ]
  if (!yes) return [...rows, "Nothing removed. Run with --yes to remove it.", "horde.json is yours: git rm horde.json to drop the configuration."].join("\n")

  const failed: string[] = []
  for (const w of worktrees) await git(root, "worktree", "remove", "--force", w.path).catch((e: Error) => failed.push(e.message.split("\n")[0]!))
  for (const w of worktrees) fs.rmSync(w.path, { recursive: true, force: true })
  await git(root, "worktree", "prune").catch((e: Error) => failed.push(e.message.split("\n")[0]!))
  // Drop the repository's now-empty folder, never the shared root or another repository's.
  for (const w of worktrees) {
    for (let p = path.dirname(w.path); p !== worktreeRoot && within(p) && fs.existsSync(p) && !fs.readdirSync(p).length; p = path.dirname(p)) fs.rmdirSync(p)
  }
  for (const b of removedBranches) await git(root, "branch", "-D", b.name).catch((e: Error) => failed.push(e.message.split("\n")[0]!))
  for (const p of boards) fs.rmSync(p, { recursive: true, force: true })
  for (const p of logs) fs.rmSync(p, { recursive: true, force: true })
  fs.rmSync(locks, { recursive: true, force: true })
  return [
    ...rows,
    ...(failed.length ? ["could not remove:", ...failed.map((f) => `  ${f}`), ""] : []),
    "horde.json is yours: git rm horde.json to drop the configuration.",
  ].join("\n")
}

async function main(argv: string[]): Promise<string> {
  const { positional, flags } = parse(argv)
  if (positional[0] === "status") return printable(await status(positional.slice(1), flags))
  if (positional[0] === "remove") {
    if (positional.length > 1) throw new Error("remove takes no arguments")
    return remove(flags)
  }
  if (positional[0] === "watch") {
    const { board, tiers, repo } = await humanBoard(flags)
    const seconds = Number(flags.interval?.[0] ?? 1)
    if (!(seconds > 0)) throw new Error("--interval must be a positive number of seconds")
    await watch(board, { tiers, title: path.basename(repo), intervalMs: seconds * 1000 })
    return ""
  }
  const state = flags.state?.[0]
  if (!state) throw new Error(`missing --state <dir>\n${USAGE}`)
  knownState(state)
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
      // Findings reach other workers' briefs: they must say which attempt they come from.
      if (!flags.task?.[0] || !flags.token?.[0]) throw new Error("finding needs --task <task id> --token <token> (from your brief)")
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
    if (out) process.stdout.write(`${out}\n`)
  },
  (err: Error) => {
    process.stderr.write(`error: ${err.message}\n`)
    process.exitCode = 1
  },
)
