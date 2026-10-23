import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, test } from "node:test"

const hookPath = path.resolve(import.meta.dirname, "delegate.mjs")

/** A fresh scratchpad for one test, removed when it ends. */
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "horde-hook-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Run the hook the way Claude Code does: the event in argv, its input as JSON on stdin. */
function run(event, input = {}) {
  const out = execFileSync(process.execPath, [hookPath, event], { input: JSON.stringify(input) }).toString()
  return out ? JSON.parse(out) : undefined
}

const context = (event, input) => run(event, input)?.hookSpecificOutput.additionalContext

/** One agent session in one fresh scratchpad, with the inputs found on every PostToolUse call. */
function session(scratchpad_dir) {
  return (tool_name, tool_input, prompt_id = "prompt-1", cwd) =>
    context("PostToolUse", { session_id: "session-1", scratchpad_dir, prompt_id, tool_name, tool_input, cwd })
}

function commit(dir, message) {
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" })
  git("add", ".")
  git("commit", "-m", message)
}

/** A temporary git repository with one committed file, removed when the test ends. */
function repo(t) {
  const dir = fs.realpathSync(scratch(t))
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" })
  git("init")
  git("config", "user.email", "t@t")
  git("config", "user.name", "t")
  git("config", "commit.gpgsign", "false")
  fs.writeFileSync(path.join(dir, "committed.txt"), "start")
  commit(dir, "initial")
  return dir
}

const edit = (file) => ["Edit", { file_path: file }]

const bash = (cwd) => ["Bash", { command: "true" }, "prompt-1", cwd]

const write = (dir, file) => fs.writeFileSync(path.join(dir, file), file)

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
  test("the fourth distinct file edited under one prompt gets a note naming the four files", (t) => {
    const hook = session(scratch(t))
    const files = ["/repo/src/a.ts", "/repo/src/b.ts", "/repo/src/c.ts", "/repo/src/d.ts"]
    for (const file of files.slice(0, 3)) assert.equal(hook(...edit(file)), undefined, file)
    const note = hook(...edit(files[3]))
    assert.equal(
      note,
      "This prompt has edited 4 files by hand so far (a.ts, b.ts, c.ts, d.ts), so it is bigger than a quick change. " +
        "horde_do can take each piece not started yet, when it is separate and describable (a goal, done-criteria, the files it may change), " +
        "to a worker that runs in parallel with the piece in hand, with checks and a review before it lands.",
    )
    assert.equal(hook(...edit("/repo/src/e.ts")), undefined, "the note is printed once per piece")
  })

  test("editing the same file twice counts once", (t) => {
    const hook = session(scratch(t))
    assert.equal(hook(...edit("/repo/src/a.ts")), undefined)
    assert.equal(hook(...edit("/repo/src/a.ts")), undefined)
    assert.equal(hook(...edit("/repo/src/b.ts")), undefined)
    assert.equal(hook(...edit("/repo/src/c.ts")), undefined)
    assert.match(hook(...edit("/repo/src/d.ts")), /edited 4 files by hand/)
  })

  test("a new prompt_id starts the count again", (t) => {
    const scratchpad_dir = scratch(t)
    const hook = session(scratchpad_dir)
    for (const file of ["a.ts", "b.ts", "c.ts"]) hook(...edit(`/repo/${file}`))
    assert.match(hook(...edit("/repo/d.ts")), /edited 4 files by hand/)
    for (const file of ["w.ts", "x.ts", "y.ts"]) assert.equal(hook(...edit(`/repo/${file}`), "prompt-2"), undefined, file)
    assert.match(hook(...edit("/repo/z.ts"), "prompt-2"), /edited 4 files by hand/)
  })

  test("edits outside the repository do not count toward the note", (t) => {
    const dir = repo(t)
    const outside = scratch(t)
    const hook = session(scratch(t))
    const stray = ["a.md", "b.md", "c.md"]
    for (const name of stray) assert.equal(hook(...edit(path.join(outside, name)), "prompt-1", dir), undefined, name)
    assert.equal(hook(...edit(path.join(dir, "only.ts")), "prompt-1", dir), undefined, "one edit inside is not four")
    const files = ["only.ts", "a.ts", "b.ts", "c.ts"]
    for (const file of files.slice(1, 3)) assert.equal(hook(...edit(path.join(dir, file)), "prompt-1", dir), undefined, file)
    const note = hook(...edit(path.join(dir, files[3])), "prompt-1", dir)
    assert.match(note, /edited 4 files by hand/)
    for (const file of files) assert.ok(note.includes(file), file)
    for (const name of stray) assert.ok(!note.includes(name), name)
  })

  test("a path through a symlink into the repository still counts", (t) => {
    const dir = repo(t)
    const link = path.join(scratch(t), "link")
    fs.symlinkSync(dir, link)
    const hook = session(scratch(t))
    const files = ["a.ts", "b.ts", "c.ts", "d.ts"]
    for (const file of files.slice(0, 3)) {
      write(dir, file)
      assert.equal(hook(...edit(path.join(link, file)), "prompt-1", dir), undefined, file)
    }
    write(dir, files[3])
    assert.match(hook(...edit(path.join(link, files[3])), "prompt-1", dir), /edited 4 files by hand/)
  })

  test("a horde_do call earlier in the prompt stops the note", (t) => {
    const hook = session(scratch(t))
    assert.equal(hook("mcp__plugin_horde_opencode__horde_do", { goal: "delegate it" }), undefined)
    for (const file of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]) assert.equal(hook(...edit(`/repo/${file}`)), undefined, file)
  })

  test("files created through Bash produce the note on the fourth distinct file", (t) => {
    const dir = repo(t)
    const hook = session(scratch(t))
    assert.equal(hook(...bash(dir)), undefined, "the baseline starts clean")
    const files = ["a.ts", "b.ts", "c.ts", "d.ts"]
    for (const file of files.slice(0, 3)) {
      write(dir, file)
      assert.equal(hook(...bash(dir)), undefined, file)
    }
    write(dir, files[3])
    const note = hook(...bash(dir))
    assert.match(note, /edited 4 files by hand/)
    for (const file of files) assert.ok(note.includes(file), file)
    write(dir, "e.ts")
    assert.equal(hook(...bash(dir)), undefined, "the note is printed once per prompt")
  })

  test("a commit starts the next piece: four new Bash files produce the note again", (t) => {
    const dir = repo(t)
    const hook = session(scratch(t))
    assert.equal(hook(...bash(dir)), undefined, "the baseline starts clean")
    const first = ["a.ts", "b.ts", "c.ts", "d.ts"]
    for (const file of first.slice(0, 3)) {
      write(dir, file)
      assert.equal(hook(...bash(dir)), undefined, file)
    }
    write(dir, first[3])
    assert.match(hook(...bash(dir)), /edited 4 files by hand/)
    commit(dir, "piece one")
    assert.equal(hook(...bash(dir)), undefined, "the commit resets the count and the baseline")
    const next = ["w.ts", "x.ts", "y.ts", "z.ts"]
    for (const file of next.slice(0, 3)) {
      write(dir, file)
      assert.equal(hook(...bash(dir)), undefined, file)
    }
    write(dir, next[3])
    const note = hook(...bash(dir))
    assert.match(note, /edited 4 files by hand/)
    for (const file of next) assert.ok(note.includes(file), file)
    assert.ok(!note.includes("a.ts"), "the previous piece's files are not named")
  })

  test("a horde_do call before the commit keeps the next piece's note silent", (t) => {
    const dir = repo(t)
    const hook = session(scratch(t))
    assert.equal(hook(...bash(dir)), undefined, "the baseline starts clean")
    const first = ["a.ts", "b.ts", "c.ts", "d.ts"]
    for (const file of first.slice(0, 3)) {
      write(dir, file)
      assert.equal(hook(...bash(dir)), undefined, file)
    }
    write(dir, first[3])
    assert.match(hook(...bash(dir)), /edited 4 files by hand/)
    assert.equal(hook("mcp__plugin_horde_opencode__horde_do", { goal: "delegate it" }), undefined)
    commit(dir, "piece one")
    assert.equal(hook(...bash(dir)), undefined, "the commit resets the count")
    for (const file of ["w.ts", "x.ts", "y.ts", "z.ts"]) {
      write(dir, file)
      assert.equal(hook(...bash(dir)), undefined, file)
    }
  })

  test("without a commit the note stays once per prompt", (t) => {
    const dir = repo(t)
    const hook = session(scratch(t))
    assert.equal(hook(...bash(dir)), undefined, "the baseline starts clean")
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"]
    for (const file of files.slice(0, 3)) {
      write(dir, file)
      assert.equal(hook(...bash(dir)), undefined, file)
    }
    write(dir, files[3])
    assert.match(hook(...bash(dir)), /edited 4 files by hand/)
    for (const file of files.slice(4)) {
      write(dir, file)
      assert.equal(hook(...bash(dir)), undefined, file)
    }
  })

  test("a file already dirty before the prompt's first observation never counts", (t) => {
    const dir = repo(t)
    const hook = session(scratch(t))
    write(dir, "already.txt")
    assert.equal(hook(...bash(dir)), undefined, "the first observation sets the baseline")
    const files = ["a.ts", "b.ts", "c.ts", "d.ts"]
    for (const file of files.slice(0, 3)) {
      write(dir, file)
      assert.equal(hook(...bash(dir)), undefined, file)
    }
    write(dir, files[3])
    const note = hook(...bash(dir))
    assert.match(note, /edited 4 files by hand/)
    for (const file of files) assert.ok(note.includes(file), file)
    assert.ok(!note.includes("already.txt"))
  })

  test("a Bash call outside any git repository counts nothing", (t) => {
    const dir = scratch(t)
    const hook = session(scratch(t))
    for (const file of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]) {
      write(dir, file)
      assert.equal(hook(...bash(dir)), undefined, file)
    }
    assert.equal(hook(...bash(undefined)), undefined, "no cwd counts nothing")
  })

  test("a file edited through Edit and then changed through Bash counts once", (t) => {
    const dir = repo(t)
    const hook = session(scratch(t))
    assert.equal(hook(...bash(dir)), undefined, "the baseline starts clean")
    const file = path.join(dir, "a.ts")
    assert.equal(hook(...edit(file), "prompt-1", dir), undefined)
    write(dir, "a.ts")
    assert.equal(hook(...bash(dir)), undefined, "Bash does not count the file again")
    for (const name of ["b.ts", "c.ts"]) {
      write(dir, name)
      assert.equal(hook(...bash(dir)), undefined, name)
    }
    write(dir, "d.ts")
    const note = hook(...bash(dir))
    assert.match(note, /edited 4 files by hand/)
    assert.equal(note.match(/a\.ts/g)?.length, 1, "a.ts is named once")
  })
})
