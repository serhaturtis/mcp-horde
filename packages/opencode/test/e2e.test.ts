/**
 * End-to-end tests against a real model. Skipped unless HORDE_E2E_MODEL is set:
 *
 *   HORDE_E2E_MODEL=free npm run test:e2e                                          # OpenCode's free models, no account
 *   DEEPSEEK_API_KEY=… HORDE_E2E_MODEL=deepseek/deepseek-flash npm run test:e2e
 *   ANTHROPIC_API_KEY=… HORDE_E2E_MODEL=anthropic/claude-haiku-4-5 HORDE_E2E_VARIANT=high npm run test:e2e
 *
 * Every run uses an isolated OpenCode home, so it never touches your sessions, database or
 * config: a named model's provider key comes from the environment (the variable OpenCode reads
 * for that provider). With "free", the suite lists OpenCode's free models, keeps the first one
 * that answers a ping, and runs everything on it. A named model spends a few cents of tokens.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { Board } from "@mcp-horde/board"
import { connect, git, type Harness } from "./harness.js"

const wanted = process.env.HORDE_E2E_MODEL
const variant = process.env.HORDE_E2E_VARIANT
const free = wanted === "free"

let h: Harness
let tmp: string
let model: string

function newRepo(name: string, files: Record<string, string> = {}) {
  const repo = path.join(tmp, name)
  fs.mkdirSync(repo, { recursive: true })
  for (const [f, text] of Object.entries({ "README.md": `# ${name}\n`, ...files })) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true })
    fs.writeFileSync(path.join(repo, f), text)
  }
  git(repo, "init", "-q")
  git(repo, "config", "core.autocrlf", "false")
  git(repo, "add", ".")
  git(repo, "commit", "-qm", "init")
  return repo
}

/** The first free model that answers a ping; every candidate's outcome is logged. */
async function pickFreeModel(): Promise<string> {
  const listed = await h.call("opencode_models", { provider: "opencode", include_unsupported: true })
  console.log(`OpenCode's catalog:\n${listed}`)
  const candidates = [...listed.matchAll(/^(opencode\/\S+) — .* · free · (?!.*UNSUPPORTED)/gm)].map((m) => m[1]!)
  assert.ok(candidates.length, "no free OpenCode model the horde can use")
  for (const [i, m] of candidates.entries()) {
    const name = `ping-${i}`
    try {
      const out = await h.call("opencode_spawn", { name, model: m, prompt: "Reply with exactly one word: PONG", wait: true, timeout_seconds: 120 })
      const ok = /PONG/i.test(out) && !/ERROR|FAILED/.test(out)
      console.log(`${m}: ${ok ? "answers" : `no usable answer:\n${out.slice(0, 600)}`}`)
      if (ok) return m
    } catch (err) {
      console.log(`${m}: ${(err as Error).message.slice(0, 300)}`)
    } finally {
      await h.call("opencode_dispose", { id: name }).catch(() => undefined)
    }
  }
  throw new Error(`none of the free models answered: ${candidates.join(", ")}`)
}

describe("real model end to end", { skip: !wanted && "set HORDE_E2E_MODEL=free or provider/model to run", timeout: 1_800_000 }, () => {
  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "horde-e2e-")))
    const home = newRepo("home")
    // An isolated OpenCode home: the user's sessions and database are never touched.
    h = await connect({
      XDG_DATA_HOME: path.join(tmp, "xdg-data"),
      XDG_STATE_HOME: path.join(tmp, "xdg-state"),
      XDG_CACHE_HOME: path.join(tmp, "xdg-cache"),
      XDG_CONFIG_HOME: path.join(tmp, "xdg-config"),
      HORDE_OPENCODE_DIRECTORY: home,
      HORDE_OPENCODE_STATE_DIR: path.join(tmp, "state"),
      HORDE_OPENCODE_WORKTREE_DIR: path.join(tmp, "worktrees"),
      HORDE_OPENCODE_SERVER: "private",
      HORDE_OPENCODE_MAX_RUNNING: "4",
      HORDE_BOARD_STATE_DIR: path.join(tmp, "board"),
    })
    model = free ? await pickFreeModel() : wanted!
    console.log(`model under test: ${model}${variant ? ` (${variant})` : ""}`)
  })

  after(async () => {
    await h?.call("opencode_server", { action: "stop" }).catch(() => undefined)
    await h?.close()
  })

  test("parallel agents edit, run, report; one is steered and one is isolated", async () => {
    const repo = newRepo("parallel")
    assert.match(await h.call("opencode_models", { query: model.split("/")[1] }), new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    const common = { model, variant, directory: repo, permissions: "allow", limits: { max_steps: 25, timeout_minutes: 10 } }
    await h.call("opencode_spawn", {
      ...common,
      name: "writer",
      prompt: "Create a file named hello.txt containing exactly the text: hello from opencode. Then reply with the single word DONE.",
    })
    await h.call("opencode_spawn", {
      ...common,
      name: "isolated",
      isolation: "worktree",
      prompt: "Create a file named notes.md with one line describing this repository, commit it with git, then reply DONE.",
    })
    await h.call("opencode_message", { id: "writer", message: "Also create bye.txt containing: bye." })
    const all = await h.call("opencode_wait", { ids: ["writer", "isolated"], mode: "all", timeout_seconds: 900 })
    console.log(all)
    assert.doesNotMatch(all, /ERROR/)
    assert.match(fs.readFileSync(path.join(repo, "hello.txt"), "utf8"), /hello from opencode/)
    assert.ok(fs.existsSync(path.join(repo, "bye.txt")), "the steer was followed")
    assert.match(await h.call("opencode_worktree", { id: "isolated", action: "diff" }), /notes\.md/)
    if (!free) assert.match(await h.call("opencode_status", { ids: ["writer"] }), /\$\d/)
    for (const id of ["writer", "isolated"]) await h.call("opencode_dispose", { id, worktree: "discard" })
  })

  test("a one-shot answer, plain and as checked JSON", async () => {
    // On the free tier this goes through the tools-denied profile (it refuses tool-less sessions).
    const plain = await h.call("opencode_ask", { model, prompt: "What is 2 + 3? Answer with the number only." })
    console.log(plain)
    assert.match(plain, /\b5\b/)
    const judged = await h.call("opencode_ask", {
      model,
      prompt: "Which is the correct implementation of add(a, b)?\nA: return a - b\nB: return a + b",
      schema: { type: "object", properties: { answer: { enum: ["A", "B"] }, why: { type: "string" } }, required: ["answer"] },
    })
    console.log(judged)
    assert.match(judged, /"answer": "B"/)
  })

  test("the horde loop: a briefed worker fixes a bug in a worktree, passes its gate and files its report", async () => {
    const repo = newRepo("loop", {
      "math.js": "// Arithmetic helpers.\nexports.add = (a, b) => a - b\n",
      "math.test.js":
        "const test = require('node:test')\nconst assert = require('node:assert')\nconst { add } = require('./math.js')\n\ntest('add', () => {\n  assert.strictEqual(add(2, 3), 5)\n})\n",
      "horde.json": JSON.stringify({ verify: { checks: { test: "node --test" } } }),
    })
    const board = await Board.open(repo, path.join(tmp, "board"))
    const task = (
      await board.plan([
        {
          title: "Fix add",
          goal: "`add` in math.js subtracts instead of adding. Make it add, without changing math.test.js.",
          acceptance: ["node --test passes", "math.test.js is unchanged"],
          scope: ["math.js"],
        },
      ])
    ).tasks[0]!
    // The task-bound spawn: the board's brief (with code context), a worktree, a gate on the scope.
    const out = await h.call("opencode_spawn", {
      task: task.id,
      name: "fixer",
      model,
      variant,
      directory: repo,
      // Real models also run the tests and git themselves; the trusted report command is covered by the mock suite.
      permissions: "allow",
      limits: { max_steps: 40, timeout_minutes: 15 },
      wait: true,
      timeout_seconds: 1200,
    })
    console.log(out)
    const settled = /— IDLE/.test(out) ? out : await h.call("opencode_wait", { ids: ["fixer"], mode: "all", timeout_seconds: 1200 })
    assert.match(settled, /gate: ✓ PASS/, settled)
    const t = board.task(task.id)
    assert.equal(
      t.status,
      "review",
      `the worker filed its report through the CLI:\n${await h.call("opencode_output", { id: "fixer", scope: "all" }).catch(() => "")}`,
    )
    console.log(`report: ${JSON.stringify(t.reports.at(-1))}`)
    // Informational: real models do not always report what they did.
    console.log(`report vs diff: ${JSON.stringify(await board.checkReport(task.id))}`)
    assert.match(await h.call("opencode_worktree", { id: "fixer", action: "merge" }), /merged/)
    assert.match(fs.readFileSync(path.join(repo, "math.js"), "utf8"), /a \+ b/)
    await board.accept(task.id)
    await h.call("opencode_dispose", { id: "fixer", worktree: "remove" })
  })
})
