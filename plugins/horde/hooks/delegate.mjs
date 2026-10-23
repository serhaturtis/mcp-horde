// What the agent knows about the horde, put where it decides (docs/research/horde-implications.md).
//   SessionStart / SubagentStart: what the horde does and what it suits, as facts; the docs warn
//     that hook text framed as commands can trip prompt-injection defenses.
//   PostToolUse: once per piece — a commit starts the next — when an agent has edited EDITS_BEFORE_NOTE
//     files by hand without delegating (Edit/Write paths inside the repository, or files git reports
//     changed after a Bash call), a note next to that edit: the work has turned out bigger than a
//     quick change.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const EDITS_BEFORE_NOTE = 4
// Built-in subagents that never edit: the horde is no use to them.
const READ_ONLY = new Set(["Explore", "Plan", "claude-code-guide", "statusline-setup"])

const ABOUT = [
  "This session has the horde plugin. horde_do hands a change, written as a goal, done-criteria and the files it may change, to a cheaper worker model in its own git worktree;",
  "the project's checks and a reviewer judge the work before horde_wait returns it, and horde_land applies it to the branch.",
  "A worker costs a fraction of this session's tokens and runs while the session does other things.",
  "It suits any change that can be written down that way: a fix, a feature, tests, docs, a refactor, or several independent pieces in parallel.",
  "horde_investigate does the same for work that changes nothing: an audit, a code review, a bug hunt, a question about how the code works; the worker answers with findings citing file:line, and the citations are checked before horde_wait returns them.",
  "When a change has a core only this session can design, the rest can still go to workers once that core exists: its tests, its docs, an investigation of the code it touches.",
  "One- or two-line edits, quick questions, changes still being worked out, and work you would only sit waiting for are quicker done directly.",
].join(" ")
const FOR_SUBAGENTS =
  "Subagents have the same tools: a worker is a cheaper model, not another Claude agent, so one piece of an assignment can go to a worker while the rest goes on here."

const event = process.argv[2]
const input = event === "SessionStart" ? {} : readInput()
const context = event === "SessionStart" ? ABOUT : event === "SubagentStart" ? subagentStart(input) : event === "PostToolUse" ? postToolUse(input) : undefined
if (context) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }))

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8"))
  } catch {
    return {}
  }
}

function subagentStart(input) {
  return READ_ONLY.has(input.agent_type) ? undefined : `${ABOUT} ${FOR_SUBAGENTS}`
}

/**
 * The repository HEAD in cwd, its worktree root, and a function returning the absolute paths git
 * reports changed there. Undefined when cwd is missing; a git call that fails leaves HEAD undefined,
 * so it never resets a piece.
 */
function gitState(cwd) {
  if (!cwd) return undefined
  // All git calls of one hook run share one 3 s budget so a slow repository cannot outlast its 5 s timeout.
  const deadline = Date.now() + 3000
  const git = (...args) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: Math.max(1, deadline - Date.now()),
      stdio: ["ignore", "pipe", "ignore"],
    })
  let head
  try {
    head = git("rev-parse", "HEAD").trim()
  } catch {}
  let top
  function root() {
    if (top === undefined) {
      try {
        top = git("rev-parse", "--show-toplevel").trim()
      } catch {
        top = cwd
      }
    }
    return top
  }
  let changed
  function files() {
    if (changed) return changed
    try {
      const dir = root()
      const entries = git("status", "--porcelain", "-z", "--untracked-files=all").split("\0")
      changed = []
      // A rename or copy is followed by its previous path, which is not a changed file.
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]
        if (!entry) continue
        changed.push(path.resolve(dir, entry.slice(3)))
        if (entry.startsWith("R") || entry.startsWith("C")) i++
      }
    } catch {
      changed = []
    }
    return changed
  }
  return { head, root, files }
}

/** The resolved path, through symlinks when the file exists. */
function realPath(file) {
  try {
    return fs.realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}

/** Whether a path lies in the git worktree that contains cwd; every path counts when cwd is absent. */
function inRepository(file, git) {
  if (!git) return true
  const rel = path.relative(realPath(git.root()), realPath(file))
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

/** Counts the files edited since the current piece began; a horde_do call means the agent is delegating already. */
function postToolUse(input) {
  if (!input.session_id) return undefined
  const key = [input.session_id, input.agent_id]
    .filter(Boolean)
    .join("-")
    .replace(/[^\w-]/g, "_")
  const file = path.join(input.scratchpad_dir ?? os.tmpdir(), `horde-edits-${key}.json`)
  let state
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"))
    if (saved.prompt === input.prompt_id) state = saved
  } catch {}
  const git = gitState(input.cwd)
  if (!state) {
    // The prompt's first observation: files already changed then are not this prompt's hand edits.
    state = { prompt: input.prompt_id, files: [], fired: false, delegated: false, baseline: git ? git.files() : [], head: git?.head }
  } else {
    if (git?.head && git.head !== state.head) {
      // A commit ended the piece: the next four hand edits start another one, but horde_do stays delegated.
      state.files = []
      state.fired = false
      state.baseline = git.files()
      state.head = git.head
    }
    if (!Array.isArray(state.baseline)) state.baseline = git ? git.files() : []
  }
  const isBash = input.tool_name === "Bash"
  const changed = isBash && git ? git.files() : []
  const candidates = isBash
    ? changed.filter((f) => !state.baseline.includes(f))
    : [input.tool_input?.file_path ?? input.tool_input?.notebook_path].filter((f) => f && inRepository(f, git))
  let note
  if (/horde_do$/.test(input.tool_name ?? "")) state.delegated = true
  else {
    state.files.push(...candidates.filter((f) => !state.files.includes(f)))
    if (!state.delegated && !state.fired && state.files.length >= EDITS_BEFORE_NOTE) {
      state.fired = true
      const names = state.files.map((f) => path.basename(f)).join(", ")
      note = [
        `This prompt has edited ${state.files.length} files by hand so far (${names}), so it is bigger than a quick change.`,
        "horde_do can take each piece not started yet, when it is separate and describable (a goal, done-criteria, the files it may change), to a worker that runs in parallel with the piece in hand, with checks and a review before it lands.",
      ].join(" ")
    }
  }
  try {
    fs.writeFileSync(file, JSON.stringify(state))
  } catch {}
  return note
}
