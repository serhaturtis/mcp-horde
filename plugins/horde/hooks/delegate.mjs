// What the agent knows about the horde, put where it decides (docs/research/horde-implications.md).
//   SessionStart / SubagentStart: what the horde does and what it suits, as facts; the docs warn
//     that hook text framed as commands can trip prompt-injection defenses.
//   PostToolUse: once per prompt, when an agent has edited EDITS_BEFORE_NOTE files by hand without
//     delegating, a note next to that edit: the work has turned out bigger than a quick change.
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
  "One- or two-line edits, questions, work that is still being investigated, and results needed right away are quicker done directly.",
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

/** Counts the files edited since the prompt began; a horde_do call means the agent is delegating already. */
function postToolUse(input) {
  if (!input.session_id) return undefined
  const key = [input.session_id, input.agent_id]
    .filter(Boolean)
    .join("-")
    .replace(/[^\w-]/g, "_")
  const file = path.join(input.scratchpad_dir ?? os.tmpdir(), `horde-edits-${key}.json`)
  let state = { prompt: input.prompt_id, files: [], done: false }
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"))
    if (saved.prompt === input.prompt_id) state = saved
  } catch {}
  const edited = input.tool_input?.file_path ?? input.tool_input?.notebook_path
  let note
  if (/horde_do$/.test(input.tool_name ?? "")) state.done = true
  else if (edited && !state.files.includes(edited)) {
    state.files.push(edited)
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
