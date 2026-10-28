// The horde's unread outcomes, put where the agent decides what to do next.
//   UserPromptSubmit: a session that starts a new prompt may still have outcomes waiting or workers
//     running from before, so the prompt carries the ids and the horde_wait call that collects them.
//   Stop: an agent that tries to stop with outcomes waiting is told to collect them first; a
//     background horde_wait already running will deliver them itself, so that case stays silent.
// The server publishes <stateDir>/news/<session_id>.json; a file that is missing, unreadable, stale
// or left behind by a dead server means there is nothing to say. The server keeps the session id it
// was spawned with, so after /clear the file is named for the old id: a missing file falls back to
// the newest live server that is a child of this Claude Code process.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const MAX_NAMED = 6
const TITLE_CHARS = 60
const STALE_MS = 24 * 60 * 60 * 1000
const COLLECT = " Collect them with horde_wait before stopping (horde_drop what you no longer need)."

try {
  const event = process.argv[2]
  const input = readInput()
  const news = readNews(input)
  if (news && event === "UserPromptSubmit") prompt(news)
  if (news && event === "Stop") stop(news, input)
} catch {}

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8"))
  } catch {
    return {}
  }
}

/** What the server last left for this session, or undefined when the file cannot be trusted. */
function readNews(input) {
  const session = input.session_id
  if (typeof session !== "string" || !session) return undefined
  // A session id names a file, so it must not reach outside the news directory.
  if (session !== path.basename(session) || session === "." || session === "..") return undefined
  const saved = readFile(path.join(stateDir(), "news", `${session}.json`)) ?? fallback()
  if (!saved) return undefined
  if (!Number.isInteger(saved.pid) || saved.pid <= 0 || !alive(saved.pid)) return undefined
  if (typeof saved.at !== "number" || Date.now() - saved.at > STALE_MS) return undefined
  return { waiting: entries(saved.waiting, true), working: entries(saved.working, false) }
}

function readFile(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"))
    return saved && typeof saved === "object" ? saved : undefined
  } catch {
    return undefined
  }
}

/**
 * The newest news file from a live server that is a child of this Claude Code process. The opencode
 * server keeps the CLAUDE_CODE_SESSION_ID it was spawned with, which /clear changes under the hook;
 * its parent is the Claude Code process the hook also runs under.
 */
function fallback() {
  const dir = path.join(stateDir(), "news")
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return undefined
  }
  const parent = process.ppid
  let newest
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    const saved = readFile(path.join(dir, name))
    if (!saved) continue
    if (!Number.isInteger(saved.pid) || saved.pid <= 0 || !alive(saved.pid)) continue
    if (parentPid(saved.pid) !== parent) continue
    if (typeof saved.at !== "number" || Date.now() - saved.at > STALE_MS) continue
    if (!newest || saved.at > newest.at) newest = saved
  }
  return newest
}

/** A process's parent pid, or undefined where this platform gives no way to read it. */
function parentPid(pid) {
  try {
    // /proc/<pid>/stat: the command may contain spaces and parentheses, so split after the last ')'.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])
    if (Number.isInteger(ppid) && ppid > 0) return ppid
  } catch {
    // No /proc here, so try ps below.
  }
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
    const ppid = Number(out)
    if (out && Number.isInteger(ppid) && ppid > 0) return ppid
  } catch {
    // Neither /proc nor ps: callers keep the old behaviour when the parent cannot be read.
  }
  return undefined
}

/** <stateDir> follows packages/opencode/src/config.ts: the env override, then XDG, then ~/.local/state. */
function stateDir() {
  if (process.env.HORDE_OPENCODE_STATE_DIR) return path.resolve(process.env.HORDE_OPENCODE_STATE_DIR)
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
  return path.resolve(path.join(stateHome, "mcp-horde", "opencode"))
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function entries(list, withKind) {
  if (!Array.isArray(list)) return []
  return list
    .filter((entry) => entry && typeof entry === "object" && typeof entry.id === "string" && entry.id)
    .map((entry) => ({
      id: entry.id,
      title: typeof entry.title === "string" ? entry.title : entry.id,
      kind: withKind && typeof entry.kind === "string" ? entry.kind : undefined,
    }))
}

/** The one line that names the waiting outcomes and the workers still running. */
function text(news) {
  const parts = []
  if (news.waiting.length) parts.push(waitingText(news.waiting))
  if (news.working.length) parts.push(workingText(news.working))
  return parts.join(" · ")
}

function waitingText(waiting) {
  const named = waiting
    .slice(0, MAX_NAMED)
    .map((entry) => `${entry.id} "${title(entry.title)}" (${entry.kind ?? "finished"})`)
    .join(", ")
  const more = waiting.length > MAX_NAMED ? ` +${waiting.length - MAX_NAMED} more` : ""
  const ids = waiting.map((entry) => `"${entry.id}"`).join(", ")
  return `${waiting.length} horde outcome(s) waiting: ${named}${more} → horde_wait {ids: [${ids}]}`
}

function workingText(working) {
  const named = working
    .slice(0, MAX_NAMED)
    .map((entry) => entry.id)
    .join(", ")
  const more = working.length > MAX_NAMED ? ` +${working.length - MAX_NAMED} more` : ""
  return `${working.length} still working: ${named}${more}`
}

function title(value) {
  return value.replace(/\s+/g, " ").trim().slice(0, TITLE_CHARS).replace(/"/g, "'")
}

function prompt(news) {
  const line = text(news)
  if (line) write({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: line } })
}

function stop(news, input) {
  if (!news.waiting.length || input.stop_hook_active === true) return
  if (waitingInBackground(input.background_tasks)) return
  write({ decision: "block", reason: text(news) + COLLECT })
}

/** A background horde_wait delivers the outcomes itself, so stopping is fine while it runs. */
function waitingInBackground(tasks) {
  return Array.isArray(tasks) && tasks.some((task) => task && typeof task === "object" && typeof task.tool === "string" && /horde_wait$/.test(task.tool))
}

function write(output) {
  process.stdout.write(JSON.stringify(output))
}
