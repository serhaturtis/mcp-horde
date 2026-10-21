import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
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
    fs.writeFileSync(
      path.join(repo, "horde.json"),
      JSON.stringify({ verify: { checks: { exports: "node check.js" } }, tiers: [{ model: "mock/mock", variant: "low" }, { model: "mock/pricey" }] }),
    )
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "checks")
    h = await connect({ ...isolatedEnv(tmp, repo), HORDE_OPENCODE_MAX_RUNNING: "4", HORDE_BOARD_STATE_DIR: path.join(tmp, "board-state") })
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

    // Two workers at once, each working a board task: brief, worktree and a gate on its scope come with it.
    const spawned = await h.call("opencode_spawn", { task: a, name: "wa", permissions: "allow" })
    assert.match(spawned, new RegExp(`working ${a} "Module a" \\(attempt 1, tier 0 \\(mock/mock low\\)\\)`), spawned)
    assert.match(spawned, /model: mock\/mock \[low\]/, "the tier picked the model")
    assert.match(spawned, new RegExp(`\\(worktree, branch horde/wa\\)\\n {2}task: ${a} "Module a"`), spawned)
    await h.call("opencode_spawn", { task: b, name: "wb", permissions: "allow" })
    await assert.rejects(h.call("opencode_spawn", { task: c, name: "early" }), new RegExp(`${c} waits for`))
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
      const report = await boardCall("board_task", { id: task })
      assert.match(report, /mock work done/)
      // The mock reports the brief's example file names: the board catches the mismatch with the diff.
      assert.match(report, /⚠ claimed but not in the diff: a\.ts, b\.ts, a\.test\.ts\n {2}⚠ in the diff but not in the report: [ab]\.js/, report)
      // The acceptance review reads the attempt's worktree; the default reviewer is another tier's model.
      if (task === a) {
        const review = await h.call("review_task", { id: task })
        assert.match(review, /^review t-\w+ "Module a" by mock\/pricey: 1\/1 met\n✓ 1\. a\.js exports a — a\.js:1\n/, review)
        assert.match(await boardCall("board_task", { id: task }), /review 1\/1 met by mock\/pricey/)
      }
      // The merged checkout is checked too, not just each worker's branch.
      assert.match(await h.call("opencode_worktree", { id: name, action: "merge" }), /merged 1 commit[\s\S]*your checkout after the merge: PASS/)
      await h.call("opencode_dispose", { id: name, worktree: "remove" })
    }
    await boardCall("board_accept", { id: a })
    assert.match(await boardCall("board_accept", { id: b }), new RegExp(`Now ready: ${c}`))
    assert.match(fs.readFileSync(path.join(repo, "a.js"), "utf8"), /export const a = 1/)
    assert.match(fs.readFileSync(path.join(repo, "b.js"), "utf8"), /export const fixed = 1/)

    // What a's worker learned is in c's brief.
    const brief = await boardCall("board_brief", { id: c, agent: "wc" })
    assert.match(brief, /## Findings from other workers[\s\S]*modules export named constants \(c\.js; from t-\w+\)/)
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

  test("escalation moves a task to the next model tier, and past the last tier it is the orchestrator's", async () => {
    const planned = await boardCall("board_plan", { tasks: [{ title: "Hard one", goal: "Something difficult." }] })
    const id = planned.match(/^(t-\w+) "Hard one"/m)![1]!
    assert.match(await boardCall("board_next"), new RegExp(`${id} "Hard one" · tier 0 \\(mock/mock low\\)`))
    await h.call("opencode_spawn", { task: id, name: "hard-0", wait: true, timeout_seconds: 60 })
    assert.match(await boardCall("board_fail", { id, reason: "gate failed twice", escalate: true }), /is open, now at tier 1 \(mock\/pricey\)/)
    assert.match(await h.call("opencode_spawn", { task: id, name: "hard-1", wait: true, timeout_seconds: 60 }), /model: mock\/pricey/)
    // The attempt's spend reached the board without anyone passing it.
    // The attempt's state and gate are there too, from the fleet.
    assert.match(await boardCall("board_task", { id }), /tier 1 \(mock\/pricey\) · \$\d.*\(agent hard-1 on mock\/pricey, attempt 2, idle, /)
    assert.match(await boardCall("board_fail", { id, reason: "still failing", escalate: true }), /now at tier 2 \(past the last model tier: yours\)/)
    await assert.rejects(h.call("opencode_spawn", { task: id, name: "hard-2" }), /past the last of the 2 tier\(s\) in horde\.json: the last tier is you/)
    // An explicit model always wins.
    assert.match(await h.call("opencode_spawn", { task: id, name: "hard-me", model: "mock/mock", wait: true, timeout_seconds: 60 }), /model: mock\/mock/)
    for (const n of ["hard-0", "hard-1", "hard-me"]) await h.call("opencode_dispose", { id: n, worktree: "discard" })
  })
})
