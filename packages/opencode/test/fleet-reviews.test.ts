import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { createFleetEnv, type FleetEnv } from "./fleet-support.js"
import { git, type Harness, type Mock, makeRepo, until } from "./harness.js"

describe("fleet fixes: gates, tasks and worktrees (real opencode, mock LLM)", { timeout: 600_000 }, () => {
  let env: FleetEnv
  let h: Harness
  let mock: Mock
  let repo: string
  let idOf: (text: string) => string

  before(async () => {
    env = await createFleetEnv()
    ;({ h, mock, repo, idOf } = env)
  })

  after(async () => {
    await env.close()
  })

  test("a gate failure waits for a running slot instead of exceeding the limit", async () => {
    const dir = path.join(repo, "gq")
    fs.mkdirSync(dir, { recursive: true })
    // Slow enough to start two other agents while it runs; fails until fixed.txt exists.
    const check = `node -e "setTimeout(() => process.exit(require('fs').existsSync('fixed.txt') ? 0 : (console.log('Error: fixed.txt is missing. TOOL: echo fixed > fixed.txt'), 1)), 4000)"`
    fs.writeFileSync(path.join(dir, "horde.json"), JSON.stringify({ verify: { checks: { check } } }))
    await h.call("opencode_spawn", { prompt: "start", name: "gq", directory: "gq", permissions: "allow", gate: { max_rounds: 2 } })
    await until(async () => /gq .*— IDLE[\s\S]*gate: running checks/.test(await h.call("opencode_status", { ids: ["gq"] })), 60_000, 100)
    // The idle agent holds no slot: both go to new agents.
    await h.call("opencode_spawn", { prompt: "SLOW hog one", name: "hog1" })
    await h.call("opencode_spawn", { prompt: "SLOW hog two", name: "hog2" })
    const queued = await until(async () => {
      const s = await h.call("opencode_status", { ids: ["gq"] })
      return /gate: failed; fix queued/.test(s) && s
    }, 60_000)
    assert.match(queued, /gq .*— IDLE/, "the fix waits: the running limit is reached")
    assert.match(await h.call("opencode_status", { ids: ["hog1", "hog2"] }), /hog1 .*— RUNNING[\s\S]*hog2 .*— RUNNING/)
    await h.call("opencode_interrupt", { id: "hog1" })
    // A slot is free: the fix goes out on a later tick and the second round passes.
    const done = await h.call("opencode_wait", { ids: ["gq"], timeout_seconds: 120 })
    assert.match(done, /gq .*— IDLE[\s\S]*gate: ✓ PASS \(round 2\/2\)/, done)
    assert.ok(fs.existsSync(path.join(dir, "fixed.txt")))
    await h.call("opencode_interrupt", { id: "hog2" })
  })

  test("after a sync the judged turn is not gated again; the next turn is", async () => {
    fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify({ verify: { checks: { ok: `node -e "process.exit(0)"` } } }))
    git(repo, "add", "horde.json")
    git(repo, "commit", "-qm", "checks")
    const first = await h.call("opencode_spawn", {
      prompt: "TOOL: echo mine > ds.txt",
      name: "ds",
      isolation: "worktree",
      permissions: "allow",
      gate: true,
      wait: true,
      timeout_seconds: 120,
    })
    assert.match(first, /gate: ✓ PASS \(round 1\/2\)/, first)
    fs.writeFileSync(path.join(repo, "theirs.txt"), "theirs\n")
    git(repo, "add", "theirs.txt")
    git(repo, "commit", "-qm", "theirs")
    const synced = await h.call("opencode_worktree", { id: "ds", action: "sync" })
    assert.match(synced, /rebased 1 commit\(s\)[\s\S]*The gate does not re-run by itself; it judges the turn that message starts\./, synced)
    await new Promise((r) => setTimeout(r, 1500))
    assert.doesNotMatch(await h.call("opencode_status", { ids: ["ds"] }), /gate:/, "no gate for the turn judged before the sync")
    const next = await h.call("opencode_message", { id: "ds", message: "re-check", wait: true, timeout_seconds: 120 })
    assert.match(next, /gate: ✓ PASS \(round 1\/2\)/, next)
    await h.call("opencode_dispose", { id: "ds", worktree: "discard" })
  })

  test("a worktree gate reads a rule committed on the main checkout while the task runs", async () => {
    const { repo: r } = makeRepo(mock.url, { permission: { bash: "allow" } })
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { ok: `node -e "process.exit(0)"` } } }))
    git(r, "add", "horde.json")
    git(r, "commit", "-qm", "checks")
    const failed = await h.call("opencode_spawn", {
      prompt: `TOOL: node -e "require('fs').writeFileSync('logo.bin', Buffer.from([0,1,2,3]))"`,
      name: "rules",
      directory: r,
      isolation: "worktree",
      permissions: "allow",
      gate: { max_rounds: 1 },
      wait: true,
      timeout_seconds: 120,
    })
    assert.match(failed, /gate: ✗ FAIL \(round 1\/1\)/, failed)
    assert.match(failed, /binaries/, failed)
    // The orchestrator commits the looser rule on the target branch; the worktree does not have it.
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { ok: `node -e "process.exit(0)"` }, audit: { warn: ["binaries"] } } }))
    git(r, "add", "horde.json")
    git(r, "commit", "-qm", "warn binaries")
    const passed = await h.call("opencode_message", { id: "rules", message: "run the checks again", wait: true, timeout_seconds: 120 })
    assert.match(passed, /gate: ✓ PASS \(round 1\/1\)/, passed)
    await h.call("opencode_dispose", { id: "rules", worktree: "discard" })
  })

  for (const [label, tiers] of [
    ["once", ["mock/pricey"]],
    ["twice", ["mock/pricey", "mock/pricey"]],
  ] as const) {
    test(`tiers naming only the worker's model (${label}) are reviewed by that model, not OpenCode's default`, async () => {
      const { repo: r } = makeRepo(mock.url, { permission: { bash: "allow" } })
      fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { ok: "true" } }, tiers }))
      git(r, "add", ".")
      git(r, "commit", "-qm", "checks")
      const file = `pricey-${label}.txt`
      const criterion = `${file} says hello`
      const started = await h.call("horde_do", {
        directory: r,
        goal: `Write the greeting.\nRUN: echo hello > ${file} && git add ${file} && git commit -qm pricey`,
        done: [criterion],
        scope: [file],
      })
      const id = idOf(started)
      const out = await h.call("horde_wait", { ids: [id], timeout_seconds: 180 })
      assert.match(out, new RegExp(`^${id} READY`), out)
      // The harness's OpenCode default is mock/mock, so only a reviewer chosen from the tiers
      // (the worker's own model here) makes the outcome say mock/pricey.
      assert.match(out, /review: 1 of 1 criteria met \(by mock\/pricey, the model that did the work\)/, out)
      const reviews = mock.requests.filter((b) => {
        const msgs = (b as { messages?: { role: string; content: unknown }[] }).messages ?? []
        return msgs.some(
          (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("# Acceptance criteria") && m.content.includes(criterion),
        )
      })
      assert.equal(reviews.length, 1)
      assert.equal((reviews[0] as { model?: string }).model, "pricey", "the reviewer was the worker's model, not the OpenCode default")
      await h.call("opencode_dispose", { id, worktree: "discard" })
    })
  }

  test("a gate review with no answer from the first reviewer retries on another model", async () => {
    const { repo: r } = makeRepo(mock.url, { permission: { bash: "allow" } })
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { ok: "true" } }, tiers: ["mock/mock", "broken/model", "mock/other"] }))
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    const started = await h.call("horde_do", {
      directory: r,
      goal: "Write the greeting.\nRUN: echo hello > greeting.txt && git add greeting.txt && git commit -qm greeting",
      done: ["greeting.txt says hello"],
      scope: ["greeting.txt"],
    })
    const id = idOf(started)
    const out = await h.call("horde_wait", { ids: [id], timeout_seconds: 180 })
    assert.match(out, new RegExp(`^${id} READY`), out)
    assert.match(out, /review: 1 of 1 criteria met \(by mock\/other\)/, out)
    const reviews = mock.requests.filter((b) => {
      const msgs = (b as { messages?: { role: string; content: unknown }[] }).messages ?? []
      return msgs.some(
        (m) =>
          m.role === "user" && typeof m.content === "string" && m.content.includes("# Acceptance criteria") && m.content.includes("greeting.txt says hello"),
      )
    })
    assert.equal(reviews.length, 1)
    assert.equal((reviews[0] as { model?: string }).model, "other", "the retry used the next tier model")
    await h.call("opencode_dispose", { id, worktree: "discard" })
  })

  test("a gate whose reviewers both give no answer fails closed", async () => {
    const { repo: r } = makeRepo(mock.url, { permission: { bash: "allow" } })
    // A second unrunnable model, so first reviewer and retry both fail to start.
    const config = JSON.parse(fs.readFileSync(path.join(r, "opencode.json"), "utf8"))
    config.provider.broken.models.other = { name: "Broken other", tool_call: true }
    fs.writeFileSync(path.join(r, "opencode.json"), JSON.stringify(config))
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { ok: "true" } }, tiers: ["mock/mock", "broken/model", "broken/other"] }))
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    const started = await h.call("horde_do", {
      directory: r,
      goal: "Write the greeting.\nRUN: echo hello > hi.txt && git add hi.txt && git commit -qm hi",
      done: ["hi.txt says hello"],
      scope: ["hi.txt"],
    })
    const id = idOf(started)
    const out = await h.call("horde_wait", { ids: [id], timeout_seconds: 180 })
    assert.match(out, new RegExp(`^${id} FAILED`), out)
    assert.match(out, /review could not run/, out)
    assert.match(out, /Cannot initialize broken\/other/, out)
    await h.call("opencode_dispose", { id, worktree: "discard" })
  })
})
