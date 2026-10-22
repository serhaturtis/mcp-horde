// What the agent knows about the horde, put where it decides (docs/research/horde-implications.md).
//   SessionStart / SubagentStart: what the horde does and what it suits, as facts; the docs warn
//     that hook text framed as commands can trip prompt-injection defenses.
//   PostToolUse: once per prompt, when an agent has edited EDITS_BEFORE_NOTE files by hand without
//     delegating (Edit/Write paths, or files git reports changed after a Bash call), a note next to
//     that edit: the work has turned out bigger than a quick change.
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

/** Absolute paths of the files git reports changed in cwd, or none when cwd is missing or not a git repository. */
function changedFiles(cwd) {
  if (!cwd) return []
  // Both git calls share one 3 s budget so a slow repository cannot outlast the hook's 5 s timeout.
  const deadline = Date.now() + 3000
  try {
    const git = (...args) =>
      execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        timeout: Math.max(1, deadline - Date.now()),
        stdio: ["ignore", "pipe", "ignore"],
      })
    const root = git("rev-parse", "--show-toplevel").trim()
    const entries = git("status", "--porcelain", "-z", "--untracked-files=all").split("\0")
    const files = []
    // A rename or copy is followed by its previous path, which is not a changed file.
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      if (!entry) continue
      files.push(path.resolve(root, entry.slice(3)))
      if (entry.startsWith("R") || entry.startsWith("C")) i++
    }
    return files
  } catch {
    return []
  }
}

/** Counts the files edited since the prompt began; a horde_do call means the agent is delegating already. */
function postToolUse(input) {
  if (!input.session_id) return undefined
  const key = [input.session_id, input.agent_id]
    .filter(Boolean)
    .join("-")
    .replace(/[^\w-]/g, "_")
  const file = path.join(input.scratchpad_dir ?? os.tmpdir(), `horde-edits-${key}.json`)
  let state
  let changed
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"))
    if (saved.prompt === input.prompt_id) state = saved
  } catch {}
  if (!state) {
    // The prompt's first observation: files already changed then are not this prompt's hand edits.
    changed = changedFiles(input.cwd)
    state = { prompt: input.prompt_id, files: [], done: false, baseline: changed }
  } else if (!Array.isArray(state.baseline)) {
    state.baseline = changed = changedFiles(input.cwd)
  }
  const isBash = input.tool_name === "Bash"
  if (isBash) changed ??= changedFiles(input.cwd)
  const candidates = isBash
    ? changed.filter((f) => !state.baseline.includes(f))
    : [input.tool_input?.file_path ?? input.tool_input?.notebook_path].filter(Boolean)
  let note
  if (/horde_do$/.test(input.tool_name ?? "")) state.done = true
  else {
    state.files.push(...candidates.filter((f) => !state.files.includes(f)))
    if (!state.done && state.files.length >= EDITS_BEFORE_NOTE) {
      state.done = true
      const names = state.files.map((f) => path.basename(f)).join(", ")
      note = [
        `This prompt has edited ${state.files.length} files by hand so far (${names}), so it is bigger than a quick change.`,
        "horde_do can take a remaining piece that is separate and describable (a goal, done-criteria, the files it may change) to a worker that runs in parallel, with checks and a review before it lands.",
        "Finishing a change that is mostly done is quicker directly.",
      ].join(" ")
    }
  }
  try {
    fs.writeFileSync(file, JSON.stringify(state))
  } catch {}
  return note
}
