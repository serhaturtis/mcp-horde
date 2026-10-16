import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { connect, git, type Harness, idOf, isolatedEnv, type Mock, makeRepo, until } from "./harness.js"
import { startMockLlm } from "./mock-llm.js"

let h: Harness
let mock: Mock
let repo: string
let tmp: string

describe("opencode MCP server: core behaviour (real opencode, mock LLM)", { timeout: 600_000 }, () => {
  before(async () => {
    mock = await startMockLlm()
    ;({ tmp, repo } = makeRepo(mock.url))
    h = await connect({ ...isolatedEnv(tmp, repo), HORDE_OPENCODE_MAX_RUNNING: "6", HORDE_OPENCODE_CHANNEL: "1" }, { elicitation: true })
  })

  after(async () => {
    await h?.call("opencode_server", { action: "stop" }).catch(() => undefined)
    await h?.close()
    mock?.close()
  })

  test("catalog: tools, models with variants, agents, unsupported models hidden", async () => {
    const tools = (await h.client.listTools()).tools.map((t) => t.name)
    for (const t of [
      "opencode_spawn",
      "opencode_wait",
      "opencode_message",
      "opencode_interrupt",
      "opencode_resume",
      "opencode_respond",
      "opencode_worktree",
      "opencode_server",
    ]) {
      assert.ok(tools.includes(t), t)
    }
    const models = await h.call("opencode_models", { provider: "mock" })
    assert.match(models, /mock\/mock — Mock .* effort variants: high, low/)
    assert.match(models, /mock\/other — .* no effort variants/)
    assert.match(await h.call("opencode_agents"), /^build/m)
    const all = await h.call("opencode_models", { include_unsupported: true })
    const native = all.match(/^(\S+) — .*UNSUPPORTED/m)?.[1]
    if (native) await assert.rejects(h.call("opencode_spawn", { prompt: "x", model: native }), /cannot run agents/)
  })

  test("validation: unknown model, variant, agent", async () => {
    await assert.rejects(h.call("opencode_spawn", { prompt: "x", model: "mock/nope" }), /Unknown model "mock\/nope"/)
    await assert.rejects(h.call("opencode_spawn", { prompt: "x", model: "mock/other", variant: "high" }), /no effort variants/)
    await assert.rejects(h.call("opencode_spawn", { prompt: "x", model: "mock/mock", variant: "ultra" }), /Available: high, low/)
    await assert.rejects(h.call("opencode_spawn", { prompt: "x", agent: "nope" }), /Unknown agent profile "nope"/)
  })

  test("spawn with model + effort, follow-up, switch effort mid-session, transcript", async () => {
    const out = await h.call("opencode_spawn", { prompt: "hello there", name: "greeter", model: "mock/mock", variant: "high", wait: true, timeout_seconds: 60 })
    assert.match(out, /greeter \(ses_\w+\) — IDLE/)
    assert.match(out, /Echo\[high\]: hello there/)
    assert.match(out, /model: mock\/mock \[high\]/)
    const again = await h.call("opencode_message", { id: "greeter", message: "second", variant: "low", wait: true, timeout_seconds: 60 })
    assert.match(again, /Echo\[low\]: second/)
    const switched = await h.call("opencode_message", { id: "greeter", message: "third", model: "mock/other", wait: true, timeout_seconds: 60 })
    assert.match(switched, /Echo\[none\]: third/)
    assert.match(switched, /model: mock\/other/)
    const full = await h.call("opencode_output", { id: "greeter", scope: "all" })
    assert.match(full, /hello there[\s\S]*second[\s\S]*switched model → mock\/other[\s\S]*third/)
    assert.match(await h.call("opencode_output", { id: "greeter", detail: "final" }), /^Echo\[none\]: third$/)
  })

  test("token usage is tracked", async () => {
    assert.match(await h.call("opencode_status", { ids: ["greeter"] }), /3 steps · \$0 · 45 tok/)
  })

  test("parallel agents: wait any reports each one once, then the next", async () => {
    await h.call("opencode_spawn", { prompt: "quick one", name: "fast" })
    await h.call("opencode_spawn", { prompt: "SLOW task", name: "slow" })
    const first = await h.call("opencode_wait", { ids: ["fast", "slow"], timeout_seconds: 60 })
    assert.match(first, /1 with news, 1 still running/)
    assert.match(first, /fast[\s\S]*Echo\[none\]: quick one/)
    // fast was reported; the next wait must not return it again but block on slow.
    await until(async () => /doing: writing/.test(await h.call("opencode_status", { ids: ["slow"] })))
    await h.call("opencode_message", { id: "slow", message: "please also say hi" })
    const stopped = await h.call("opencode_interrupt", { id: "slow" })
    assert.match(stopped, /INTERRUPTED/)
    const next = await h.call("opencode_wait", { ids: ["fast", "slow"], timeout_seconds: 60 })
    assert.match(next, /1 with news/)
    assert.match(next, /slow .*INTERRUPTED/)
    assert.match(next, /Already reported: fast/)
    const nothing = await h.call("opencode_wait", { ids: ["fast", "slow"], timeout_seconds: 60 })
    assert.match(nothing, /Nothing new/)
    // Resume: the steer that was not picked up before the interrupt is delivered too.
    const resumed = await h.call("opencode_resume", { id: "slow", message: "finish up", wait: true, timeout_seconds: 60 })
    assert.match(resumed, /IDLE/)
    assert.match(resumed, /Echo\[none\]: finish up/)
    assert.match(await h.call("opencode_output", { id: "slow", scope: "all" }), /SLOW task[\s\S]*interrupted[\s\S]*please also say hi[\s\S]*finish up/)
  })

  test("interrupting an idle agent is a no-op", async () => {
    assert.match(await h.call("opencode_interrupt", { id: "fast" }), /— IDLE/)
  })

  test("graceful pause lets the running tool finish", async () => {
    const marker = path.join(repo, "paused.txt")
    await h.call("opencode_spawn", { prompt: `TOOL: sleep 2 && echo done > ${marker}`, name: "pauser", permissions: "allow" })
    await until(async () => /doing: bash/.test(await h.call("opencode_status", { ids: ["pauser"] })))
    const pausing = await h.call("opencode_interrupt", { id: "pauser", when: "after_step" })
    assert.match(pausing, /RUNNING[\s\S]*pausing after the current step/)
    const out = await h.call("opencode_wait", { ids: ["pauser"], timeout_seconds: 60 })
    assert.match(out, /INTERRUPTED/)
    assert.match(out, /reason: paused after step/)
    assert.equal(fs.readFileSync(marker, "utf8").trim(), "done")
  })

  test("permissions: ask → respond once; always; deny; allow", async () => {
    await h.call("opencode_spawn", { prompt: "TOOL: echo approved > approved.txt", name: "asker", permissions: "ask" })
    const blocked = await h.call("opencode_wait", { ids: ["asker"], timeout_seconds: 60 })
    assert.match(blocked, /NEEDS_INPUT/)
    const req = blocked.match(/needs permission (per_\w+): bash/)![1]!
    await assert.rejects(h.call("opencode_respond", { id: "asker", request_id: "per_nope" }), /no pending request per_nope[\s\S]*Pending: per_/)
    await h.call("opencode_respond", { id: "asker", request_id: req, decision: "always" })
    const done = await h.call("opencode_wait", { ids: ["asker"], timeout_seconds: 60 })
    assert.match(done, /IDLE[\s\S]*DONE/)
    assert.equal(fs.readFileSync(path.join(repo, "approved.txt"), "utf8").trim(), "approved")

    const denied = await h.call("opencode_spawn", { prompt: "TOOL: echo nope > denied.txt", permissions: "deny", wait: true, timeout_seconds: 60 })
    assert.match(denied, /IDLE/)
    assert.equal(fs.existsSync(path.join(repo, "denied.txt")), false)

    const allowed = await h.call("opencode_spawn", { prompt: "TOOL: echo yes > allowed.txt", permissions: "allow", wait: true, timeout_seconds: 60 })
    assert.match(allowed, /IDLE[\s\S]*DONE/)
    assert.equal(fs.existsSync(path.join(repo, "allowed.txt")), true)
  })

  test("permissions: user policy asks the human through elicitation", async () => {
    h.elicit.answer = () => ({ action: "accept", content: { decision: "once" } })
    const out = await h.call("opencode_spawn", { prompt: "TOOL: echo human > human.txt", name: "human", wait: true, timeout_seconds: 60 })
    assert.match(out, /IDLE[\s\S]*DONE/)
    assert.ok(h.elicit.seen.some((m) => m.includes('"human" wants permission: bash')))
    assert.equal(fs.readFileSync(path.join(repo, "human.txt"), "utf8").trim(), "human")

    h.elicit.answer = () => ({ action: "decline" })
    const declined = await h.call("opencode_message", { id: "human", message: "TOOL: echo again > declined.txt", wait: true, timeout_seconds: 60 })
    assert.match(declined, /IDLE/)
    assert.equal(fs.existsSync(path.join(repo, "declined.txt")), false)

    // Dismissing the dialog hands the request to the calling model instead.
    h.elicit.answer = () => ({ action: "cancel" })
    const handed = await h.call("opencode_message", { id: "human", message: "TOOL: echo late > late.txt", wait: true, timeout_seconds: 60 })
    assert.match(handed, /NEEDS_INPUT[\s\S]*needs permission per_/)
    const req = handed.match(/needs permission (per_\w+)/)![1]!
    await h.call("opencode_respond", { id: "human", request_id: req, decision: "reject", message: "no" })
    assert.match(await h.call("opencode_wait", { ids: ["human"], timeout_seconds: 60 }), /IDLE/)
  })

  test("questions: ask → answer, user → elicitation, dismiss", async () => {
    await h.call("opencode_spawn", { prompt: "ASK: favourite colour?", name: "quiz", questions: "ask" })
    const blocked = await h.call("opencode_wait", { ids: ["quiz"], timeout_seconds: 60 })
    assert.match(blocked, /needs answer (que_\w+): favourite colour\? \[Red \| Blue\]/)
    const req = blocked.match(/needs answer (que_\w+)/)![1]!
    await h.call("opencode_respond", { id: "quiz", request_id: req, answers: [["Blue"]] })
    assert.match(await h.call("opencode_wait", { ids: ["quiz"], timeout_seconds: 60 }), /DONE: .*Blue/)

    h.elicit.answer = (r) => ({ action: "accept", content: { q0: "Red" } as Record<string, string>, _r: r }) as never
    const viaUser = await h.call("opencode_message", { id: "quiz", message: "ASK: again?", questions: "user", wait: true, timeout_seconds: 60 })
    assert.match(viaUser, /DONE: .*Red/)

    const dismissed = await h.call("opencode_message", { id: "quiz", message: "ASK: third?", questions: "dismiss", wait: true, timeout_seconds: 60 })
    assert.match(dismissed, /IDLE/)
    assert.doesNotMatch(dismissed, /needs answer/)
  })

  test("limits: step limit interrupts with a reason", async () => {
    const out = await h.call("opencode_spawn", {
      prompt: "STEPS: 6",
      name: "looper",
      permissions: "allow",
      limits: { max_steps: 2 },
      wait: true,
      timeout_seconds: 60,
    })
    assert.match(out, /INTERRUPTED/)
    assert.match(out, /reason: step limit reached \(2 steps this turn\)/)
  })

  test("provider errors surface as error state", async () => {
    const out = await h.call("opencode_spawn", { prompt: "FAIL400", name: "broken", wait: true, timeout_seconds: 60 })
    assert.match(out, /— ERROR/)
    assert.match(out, /error: Provider request failed with HTTP 400/)
  })

  test("a turn that silently never runs is reported as an error, not idle", async () => {
    const out = await h.call("opencode_spawn", { prompt: "hello?", name: "ghost", model: "broken/model", wait: true, timeout_seconds: 120 })
    assert.match(out, /ghost .*— ERROR/)
    assert.match(out, /error: .*(never started|stopped without finishing|failed)/)
  })

  test("file attachments reach the model", async () => {
    fs.writeFileSync(path.join(repo, "note.txt"), "hello-attachment\n")
    const out = await h.call("opencode_spawn", { prompt: "read this", files: ["note.txt"], wait: true, timeout_seconds: 60 })
    assert.match(out, /Echo\[none\]: read this[\s\S]*<file path="note\.txt">\s*hello-attachment/)
    await assert.rejects(h.call("opencode_spawn", { prompt: "x", files: ["missing.txt"] }), /attachment not found/)
  })

  test("requests from child sessions surface on the parent agent", async () => {
    const parentOut = await h.call("opencode_spawn", { prompt: "parent", name: "parent", permissions: "ask", wait: true, timeout_seconds: 60 })
    const parent = idOf(parentOut)
    // OpenCode's v2 runner has no subagent tool yet; create the child the way the legacy task tool does.
    const [, password, url] = (await h.call("opencode_server", { action: "info" })).match(/OPENCODE_SERVER_PASSWORD=(\S+) opencode attach (\S+)/)!
    const oc = createOpencodeClient({ baseUrl: url, headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } })
    const child = (await oc.session.create({ directory: repo, parentID: parent, title: "child" })).data!.id
    await oc.v2.session.prompt({ sessionID: child, prompt: { text: "TOOL: echo child > child.txt" } })
    const blocked = await h.call("opencode_wait", { ids: ["parent"], timeout_seconds: 60 })
    assert.match(blocked, new RegExp(`subagents: ${child}`))
    assert.match(blocked, new RegExp(`needs permission (per_\\w+) \\(subagent ${child}\\): bash`))
    const req = blocked.match(/needs permission (per_\w+)/)![1]!
    await h.call("opencode_respond", { id: "parent", request_id: req })
    await until(async () => fs.existsSync(path.join(repo, "child.txt")))
  })

  test("worktree isolation: uncommitted changes, link, setup, profile, diff, merge, dispose", async () => {
    fs.writeFileSync(path.join(repo, "README.md"), "# test repo\nlocal edit\n")
    fs.writeFileSync(path.join(repo, "scratch.txt"), "untracked\n")
    fs.mkdirSync(path.join(repo, "node_modules", "dep"), { recursive: true })
    fs.writeFileSync(path.join(repo, "node_modules", "dep", "index.js"), "module.exports = 1\n")
    const out = await h.call("opencode_spawn", {
      prompt: "TOOLS?",
      name: "iso",
      isolation: "worktree",
      permissions: "allow",
      worktree: { link: ["node_modules"], setup: "mkdir -p build && echo ready > build/setup.txt" },
      profile: { tools: { webfetch: false, websearch: false } },
      wait: true,
      timeout_seconds: 60,
    })
    assert.match(out, /carried over uncommitted changes and \d+ untracked file/)
    assert.match(out, /linked node_modules/)
    assert.match(out, /setup `mkdir -p build && echo ready > build\/setup.txt` succeeded/)
    assert.match(out, /worktree, branch horde\/iso/)
    assert.match(out, /Tools: .*bash/)
    assert.doesNotMatch(out, /Tools: .*webfetch/)
    const dir = out.match(/dir: (\S+) \(worktree/)![1]!
    assert.ok(!dir.startsWith(repo), "worktree lives outside the repo")
    assert.equal(fs.readFileSync(path.join(dir, "README.md"), "utf8"), "# test repo\nlocal edit\n")
    assert.equal(fs.readFileSync(path.join(dir, "scratch.txt"), "utf8"), "untracked\n")
    assert.ok(fs.lstatSync(path.join(dir, "node_modules")).isSymbolicLink())
    assert.equal(git(repo, "status", "--porcelain", "--", ".opencode"), "", "generated profile is not visible in the main checkout")

    await h.call("opencode_message", {
      id: "iso",
      message: "TOOL: echo feature > feature.txt && git add feature.txt && git commit -qm 'add feature'",
      wait: true,
      timeout_seconds: 60,
    })
    const diff = await h.call("opencode_worktree", { id: "iso", action: "diff" })
    assert.match(diff, /add feature/)
    assert.match(diff, /feature\.txt/)

    // Only the agent's own commit is merged; carried-over local edits stay local and uncommitted.
    const merged = await h.call("opencode_worktree", { id: "iso", action: "merge" })
    assert.match(merged, /merged 1 commit\(s\) from horde\/iso/)
    assert.equal(fs.readFileSync(path.join(repo, "feature.txt"), "utf8").trim(), "feature")
    assert.equal(git(repo, "log", "-1", "--format=%s"), "add feature")
    assert.match(git(repo, "status", "--porcelain"), /^\s?M README\.md/m)
    assert.doesNotMatch(git(repo, "show", "--stat", "HEAD"), /node_modules|scratch|setup/)

    const disposed = await h.call("opencode_dispose", { id: "iso", worktree: "remove", delete_session: true })
    assert.match(disposed, /removed worktree/)
    assert.match(disposed, /kept branch horde\/iso/)
    assert.match(disposed, /deleted session/)
    assert.equal(fs.existsSync(dir), false)
  })

  test("merge conflicts abort cleanly", async () => {
    const out = await h.call("opencode_spawn", {
      prompt: "TOOL: echo theirs > clash.txt",
      name: "clash",
      isolation: "worktree",
      permissions: "allow",
      wait: true,
      timeout_seconds: 60,
    })
    assert.match(out, /IDLE/)
    fs.writeFileSync(path.join(repo, "clash.txt"), "ours\n")
    git(repo, "add", "clash.txt")
    git(repo, "commit", "-qm", "ours")
    const head = git(repo, "rev-parse", "HEAD")
    await assert.rejects(h.call("opencode_worktree", { id: "clash", action: "merge" }), /failed and was aborted[\s\S]*clash\.txt/)
    assert.equal(git(repo, "rev-parse", "HEAD"), head)
    assert.equal(fs.readFileSync(path.join(repo, "clash.txt"), "utf8"), "ours\n")
    assert.doesNotMatch(git(repo, "status", "--porcelain"), /clash\.txt/)
    await h.call("opencode_dispose", { id: "clash", worktree: "discard" })
  })

  test("many agents in parallel and the running limit", async () => {
    const names = ["p1", "p2", "p3", "p4", "p5", "p6"]
    await Promise.all(names.map((n) => h.call("opencode_spawn", { prompt: `SLOW ${n}`, name: n })))
    await assert.rejects(h.call("opencode_spawn", { prompt: "one too many" }), /6 agents are already working/)
    await Promise.all(names.map((n) => h.call("opencode_interrupt", { id: n })))
    const all = await h.call("opencode_wait", { ids: names, mode: "all", timeout_seconds: 60 })
    assert.equal(all.match(/INTERRUPTED/g)?.length, 6)
  })

  test("channel notifications are pushed when agents settle", async () => {
    const before = h.channel.length
    await h.call("opencode_spawn", { prompt: "ping", name: "pinger" })
    const note = await until(async () => h.channel.slice(before).find((n) => n.meta.agent_name === "pinger"))
    assert.equal(note.meta.state, "idle")
    assert.match(note.content, /Echo\[none\]: ping/)
    // A push is best effort, so opencode_wait still delivers the result once.
    assert.match(await h.call("opencode_wait", { ids: ["pinger"], timeout_seconds: 5 }), /pinger[\s\S]*Echo\[none\]: ping/)
  })

  test("transcripts are exposed as resources", async () => {
    const list = await h.client.listResources()
    const uri = list.resources.find((r) => r.uri.includes("/transcript"))!.uri
    const res = await h.client.readResource({ uri })
    assert.match(String((res.contents[0] as { text: string }).text), /## user/)
  })
})
