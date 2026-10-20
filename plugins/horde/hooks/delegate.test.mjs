import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, test } from "node:test"

const hookPath = path.resolve(import.meta.dirname, "delegate.mjs")
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "horde-hook-"))

/** Run the hook the way Claude Code does: the event in argv, its input as JSON on stdin. */
function run(event, input = {}) {
  const out = execFileSync(process.execPath, [hookPath, event], { input: JSON.stringify(input) }).toString()
  return out ? JSON.parse(out) : undefined
}

const context = (event, input) => run(event, input)?.hookSpecificOutput.additionalContext

/** One agent session in one fresh scratchpad, with the inputs found on every PostToolUse call. */
function session(scratchpad_dir) {
  return (tool_name, tool_input, prompt_id = "prompt-1") =>
    context("PostToolUse", { session_id: "session-1", scratchpad_dir, prompt_id, tool_name, tool_input })
}

const edit = (file) => ["Edit", { file_path: file }]

describe("SessionStart", () => {
  test("tells the session about horde_do", () => {
    const out = run("SessionStart")
    assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart")
    assert.match(out.hookSpecificOutput.additionalContext, /horde_do/)
  })
})

describe("SubagentStart", () => {
  test("read-only subagents get nothing, others get the session text and the subagent sentence", () => {
    assert.equal(run("SubagentStart", { agent_type: "Explore" }), undefined)
    assert.equal(run("SubagentStart", { agent_type: "Plan" }), undefined)
    const about = context("SessionStart")
    const text = context("SubagentStart", { agent_type: "general-purpose" })
    assert.equal(run("SubagentStart", { agent_type: "general-purpose" }).hookSpecificOutput.hookEventName, "SubagentStart")
    assert.ok(text.startsWith(about), "the session text comes first")
    assert.match(text, /Subagents have the same tools: a worker is a cheaper model, not another Claude agent/)
  })
})

describe("PostToolUse", () => {
  test("the fourth distinct file edited under one prompt gets a note naming the four files", () => {
    const hook = session(tmp())
    const files = ["/repo/src/a.ts", "/repo/src/b.ts", "/repo/src/c.ts", "/repo/src/d.ts"]
    for (const file of files.slice(0, 3)) assert.equal(hook(...edit(file)), undefined, file)
    const note = hook(...edit(files[3]))
    assert.match(note, /edited 4 files by hand/)
    for (const file of files) assert.ok(note.includes(path.basename(file)), file)
    assert.equal(hook(...edit("/repo/src/e.ts")), undefined, "the note is printed once per prompt")
  })

  test("editing the same file twice counts once", () => {
    const hook = session(tmp())
    assert.equal(hook(...edit("/repo/src/a.ts")), undefined)
    assert.equal(hook(...edit("/repo/src/a.ts")), undefined)
    assert.equal(hook(...edit("/repo/src/b.ts")), undefined)
    assert.equal(hook(...edit("/repo/src/c.ts")), undefined)
    assert.match(hook(...edit("/repo/src/d.ts")), /edited 4 files by hand/)
  })

  test("a new prompt_id starts the count again", () => {
    const scratchpad_dir = tmp()
    const hook = session(scratchpad_dir)
    for (const file of ["a.ts", "b.ts", "c.ts"]) hook(...edit(`/repo/${file}`))
    assert.match(hook(...edit("/repo/d.ts")), /edited 4 files by hand/)
    for (const file of ["w.ts", "x.ts", "y.ts"]) assert.equal(hook(...edit(`/repo/${file}`), "prompt-2"), undefined, file)
    assert.match(hook(...edit("/repo/z.ts"), "prompt-2"), /edited 4 files by hand/)
  })

  test("a horde_do call earlier in the prompt stops the note", () => {
    const hook = session(tmp())
    assert.equal(hook("mcp__plugin_horde_opencode__horde_do", { goal: "delegate it" }), undefined)
    for (const file of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]) assert.equal(hook(...edit(`/repo/${file}`)), undefined, file)
  })
})
