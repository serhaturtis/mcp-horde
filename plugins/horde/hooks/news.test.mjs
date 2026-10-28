import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, test } from "node:test"

const hookPath = path.resolve(import.meta.dirname, "news.mjs")
const SESSION = "session-1"

/** A fresh state directory for one test, removed when it ends. */
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "horde-news-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A state directory whose news file holds `content`. */
function state(t, content) {
  const dir = scratch(t)
  fs.mkdirSync(path.join(dir, "news"), { recursive: true })
  fs.writeFileSync(path.join(dir, "news", `${SESSION}.json`), JSON.stringify(content))
  return dir
}

/** The server's per-session news, naming this test process as the live publisher. */
function news({ waiting = [], working = [], pid = process.pid, at = Date.now() } = {}) {
  return { pid, at, waiting, working }
}

/** Run the hook the way Claude Code does: the event in argv, its input as JSON on stdin. */
function run(event, dir, input = {}) {
  const env = { ...process.env, HORDE_OPENCODE_STATE_DIR: dir }
  const out = execFileSync(process.execPath, [hookPath, event], { input: JSON.stringify({ session_id: SESSION, ...input }), env }).toString()
  return out ? JSON.parse(out) : undefined
}

const context = (out) => out?.hookSpecificOutput.additionalContext

const twoWaiting = [
  { id: "t-9d8e", title: "Fix the parser", kind: "finished" },
  { id: "t-1ab2", title: "Review the docs", kind: "needs you" },
]

describe("UserPromptSubmit", () => {
  test("names the waiting outcomes, the horde_wait call and the workers still running", (t) => {
    const dir = state(t, news({ waiting: twoWaiting, working: [{ id: "t-77aa", title: "Still busy" }] }))
    const out = run("UserPromptSubmit", dir)
    assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit")
    assert.equal(
      context(out),
      '2 horde outcome(s) waiting: t-9d8e "Fix the parser" (finished), t-1ab2 "Review the docs" (needs you) → ' +
        'horde_wait {ids: ["t-9d8e", "t-1ab2"]} · 1 still working: t-77aa',
    )
  })

  test("reports workers without a waiting prefix", (t) => {
    const dir = state(t, news({ working: [{ id: "t-77aa", title: "Still busy" }] }))
    assert.equal(context(run("UserPromptSubmit", dir)), "1 still working: t-77aa")
  })

  test("is silent when nothing is waiting and nothing is working", (t) => {
    assert.equal(run("UserPromptSubmit", state(t, news())), undefined)
  })

  test("names at most six outcomes and cuts long titles", (t) => {
    const waiting = Array.from({ length: 7 }, (_, i) => ({ id: `t-${i + 1}`, title: i === 0 ? "x".repeat(80) : `title ${i + 1}`, kind: "finished" }))
    const text = context(run("UserPromptSubmit", state(t, news({ waiting }))))
    assert.ok(text.startsWith(`7 horde outcome(s) waiting: t-1 "${"x".repeat(60)}" (finished), `))
    assert.ok(text.includes(', t-6 "title 6" (finished) +1 more → horde_wait {ids: ["t-1", '))
    assert.ok(!text.includes('t-7 "title 7"'), "the seventh outcome is only counted")
    assert.ok(text.endsWith('"t-7"]}'), "the call still collects every id")
  })
})

describe("Stop", () => {
  test("blocks with the waiting ids and the collection note", (t) => {
    const dir = state(t, news({ waiting: twoWaiting }))
    const out = run("Stop", dir)
    assert.equal(out.decision, "block")
    assert.equal(
      out.reason,
      '2 horde outcome(s) waiting: t-9d8e "Fix the parser" (finished), t-1ab2 "Review the docs" (needs you) → ' +
        'horde_wait {ids: ["t-9d8e", "t-1ab2"]} Collect them with horde_wait before stopping (horde_drop what you no longer need).',
    )
  })

  test("is silent when the stop hook is already active", (t) => {
    assert.equal(run("Stop", state(t, news({ waiting: twoWaiting })), { stop_hook_active: true }), undefined)
  })

  test("is silent while a background horde_wait runs", (t) => {
    const dir = state(t, news({ waiting: twoWaiting }))
    assert.equal(run("Stop", dir, { background_tasks: [{ id: "task-1", tool: "mcp__plugin_horde_opencode__horde_wait" }] }), undefined)
  })

  test("still blocks when the background task is another tool", (t) => {
    const dir = state(t, news({ waiting: twoWaiting }))
    assert.equal(run("Stop", dir, { background_tasks: [{ id: "task-1", tool: "mcp__plugin_horde_opencode__horde_do" }] }).decision, "block")
  })

  test("never blocks on working alone", (t) => {
    assert.equal(run("Stop", state(t, news({ working: [{ id: "t-77aa", title: "Still busy" }] }))), undefined)
  })
})

describe("untrusted or absent news", () => {
  test("a dead pid is ignored", (t) => {
    const dir = state(t, news({ waiting: twoWaiting, pid: 999999999 }))
    assert.equal(run("UserPromptSubmit", dir), undefined)
    assert.equal(run("Stop", dir), undefined)
  })

  test("a missing file is ignored", (t) => {
    assert.equal(run("UserPromptSubmit", scratch(t)), undefined)
    assert.equal(run("Stop", scratch(t)), undefined)
  })

  test("news older than a day is ignored", (t) => {
    const dir = state(t, news({ waiting: twoWaiting, at: Date.now() - 25 * 60 * 60 * 1000 }))
    assert.equal(run("Stop", dir), undefined)
  })

  test("an unparsable file is ignored", (t) => {
    const dir = scratch(t)
    fs.mkdirSync(path.join(dir, "news"), { recursive: true })
    fs.writeFileSync(path.join(dir, "news", `${SESSION}.json`), "{not json")
    assert.equal(run("UserPromptSubmit", dir), undefined)
  })
})
