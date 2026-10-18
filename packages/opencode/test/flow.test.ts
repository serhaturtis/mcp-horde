import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { connect, git, type Harness, isolatedEnv, type Mock, makeRepo } from "./harness.js"
import { startMockLlm } from "./mock-llm.js"

// The orchestration procedure end to end, as the horde skill runs it: plan on the board, brief
// two workers that run in parallel in worktrees, gate their work, read reports, merge, accept,
// and see a worker's finding reach a later task's brief.

const boardPkg = path.join(import.meta.dirname, "..", "..", "board")

// The project's one check: every module must export something. Its failure tells the mock
// worker how to fix it, so the gate's second round is a real fix.
const CHECK = `const fs = require("fs")
for (const f of ["a.js", "b.js", "c.js"]) {
  if (fs.existsSync(f) && !fs.readFileSync(f, "utf8").includes("export")) {
    console.log("Error: " + f + " has no export. TOOL: echo export const fixed = 1 > " + f)
    process.exit(1)
  }
}
`

let h: Harness
let mock: Mock
let repo: string
let tmp: string
let board: Client

async function boardCall(name: string, args: Record<string, unknown> = {}) {
  const res = (await board.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
  const text = res.content.map((c) => c.text).join("\n")
  if (res.isError) throw new Error(text)
  return text
}

describe("the horde flow: board, workers, gates (real opencode, mock LLM)", { timeout: 600_000 }, () => {
  before(async () => {
    mock = await startMockLlm()
    ;({ tmp, repo } = makeRepo(mock.url))
    fs.writeFileSync(path.join(repo, "check.js"), CHECK)
    fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify({ verify: { checks: { exports: "node check.js" } } }))
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "checks")
    h = await connect({ ...isolatedEnv(tmp, repo), HORDE_OPENCODE_MAX_RUNNING: "4" })
    board = new Client({ name: "test", version: "0" })
    await board.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--conditions=source", "--import", "tsx", path.join(boardPkg, "src", "index.ts")],
        cwd: boardPkg,
        env: { ...(process.env as Record<string, string>), HORDE_BOARD_DIRECTORY: repo, HORDE_BOARD_STATE_DIR: path.join(tmp, "board-state") },
        stderr: "inherit",
      }),
    )
  })

  after(async () => {
    await board?.close()
    await h?.call("opencode_server", { action: "stop" }).catch(() => undefined)
    await h?.close()
    mock?.close()
  })

  test("plan three tasks, run two in parallel, gate, merge, accept; findings reach the dependent task", async () => {
    const planned = await boardCall("board_plan", {
      tasks: [
        {
          title: "Module a",
          goal: "Add module a.\nRUN: echo export const a = 1 > a.js\nFINDING: modules export named constants @ c.js",
          acceptance: ["a.js exports a"],
          scope: ["a.js"],
        },
        { title: "Module b", goal: "Add module b.\nRUN: echo broken > b.js", acceptance: ["b.js exports b"], scope: ["b.js"] },
        { title: "Module c", goal: "Add module c.\nRUN: echo export const c = 3 > c.js", scope: ["c.js"], deps: ["Module a", "Module b"] },
      ],
    })
    const id = (title: string) => planned.match(new RegExp(`^(t-\\w+) "${title}"`, "m"))![1]!
    const [a, b, c] = [id("Module a"), id("Module b"), id("Module c")]
    const next = await boardCall("board_next")
    assert.match(next, new RegExp(a))
    assert.match(next, new RegExp(b))
    assert.doesNotMatch(next, new RegExp(c), "c waits for a and b")

    // Two workers at once, each in its own worktree, each gated on its own scope.
    const spawn = async (task: string, name: string, scope: string) =>
      h.call("opencode_spawn", {
        prompt: await boardCall("board_brief", { id: task, agent: name }),
        name,
        isolation: "worktree",
        permissions: "allow",
        gate: { allowed: [scope] },
      })
    await spawn(a, "wa", "a.js")
    await spawn(b, "wb", "b.js")
    const settled = await h.call("opencode_wait", { ids: ["wa", "wb"], mode: "all", timeout_seconds: 240 })
    assert.match(settled, /wa .*— IDLE[\s\S]*gate: ✓ PASS \(round 1\/2\)/, settled)
    // b's first version fails the check; the verdict goes back to the worker, which fixes it.
    assert.match(settled, /wb .*— IDLE[\s\S]*gate: ✓ PASS \(round 2\/2\)/, settled)
    assert.match(await boardCall("board_summary"), /3 tasks: 2 review, 1 open/)

    // Read the reports, not the transcripts; merge and accept in dependency order.
    for (const [task, name] of [
      [a, "wa"],
      [b, "wb"],
    ] as const) {
      assert.match(await boardCall("board_task", { id: task }), /mock work done/)
      assert.match(await h.call("opencode_worktree", { id: name, action: "merge" }), /merged/)
      await h.call("opencode_dispose", { id: name, worktree: "remove" })
    }
    await boardCall("board_accept", { id: a })
    assert.match(await boardCall("board_accept", { id: b }), new RegExp(`Now ready: ${c}`))
    assert.match(fs.readFileSync(path.join(repo, "a.js"), "utf8"), /export const a = 1/)
    assert.match(fs.readFileSync(path.join(repo, "b.js"), "utf8"), /export const fixed = 1/)

    // What a's worker learned is in c's brief.
    const brief = await boardCall("board_brief", { id: c, agent: "wc" })
    assert.match(brief, /## Findings from other workers[\s\S]*modules export named constants \(c\.js\)/)
    const done = await h.call("opencode_spawn", {
      prompt: brief,
      name: "wc",
      isolation: "worktree",
      permissions: "allow",
      gate: { allowed: ["c.js"] },
      wait: true,
      timeout_seconds: 120,
    })
    assert.match(done, /gate: ✓ PASS \(round 1\/2\)/, done)
    await h.call("opencode_worktree", { id: "wc", action: "merge" })
    await h.call("opencode_dispose", { id: "wc", worktree: "remove" })
    await boardCall("board_accept", { id: c })
    assert.match(await boardCall("board_summary"), /^3 tasks: 3 done/)
    assert.ok(fs.existsSync(path.join(repo, "c.js")))
  })
})
