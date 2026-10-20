import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { Board, renderBrief, workerCommand } from "@mcp-horde/board"
import { OpenCode } from "@opencode/client"
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
    assert.match(models, /mock\/pricey — Pricey mock · ctx \d+k · \$100000\/\$100000 per M ·/)
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
    // Token usage is tracked.
    assert.match(await h.call("opencode_status", { ids: ["greeter"] }), /3 steps · \$0 · 45 tok/)
  })

  test("agent names are unique; a failed spawn leaves nothing behind", async () => {
    await h.call("opencode_spawn", { prompt: "first", name: "uniq", wait: true, timeout_seconds: 60 })
    await assert.rejects(h.call("opencode_spawn", { prompt: "again", name: "uniq" }), /already exists/)
    // Worktree isolation outside a git repository fails after the session was created: it must be rolled back.
    const plain = fs.mkdtempSync(path.join(tmp, "plain-"))
    await assert.rejects(h.call("opencode_spawn", { prompt: "x", name: "failed", directory: plain, isolation: "worktree" }), /needs a git repository/)
    assert.doesNotMatch(await h.call("opencode_status"), /failed \(ses_/)
    const reused = await h.call("opencode_spawn", { prompt: "reuse", name: "failed", wait: true, timeout_seconds: 60 })
    assert.match(reused, /failed \(ses_\w+\) — IDLE/)
  })

  test("a relative directory is resolved against the configured directory", async () => {
    fs.mkdirSync(path.join(repo, "sub"), { recursive: true })
    const out = await h.call("opencode_spawn", { prompt: "where", name: "rel", directory: "sub", wait: true, timeout_seconds: 60 })
    // Either the configured or the real path (macOS /var → /private/var).
    const dir = out.match(/dir: (\S+)/)![1]!
    assert.equal(fs.realpathSync(dir), fs.realpathSync(path.join(repo, "sub")))
  })

  test("limits merge on message instead of replacing each other", async () => {
    await h.call("opencode_spawn", { prompt: "hi", name: "limited", limits: { max_steps: 9 }, wait: true, timeout_seconds: 60 })
    const out = await h.call("opencode_message", { id: "limited", message: "again", limits: { max_cost_usd: 5 }, wait: true, timeout_seconds: 60 })
    assert.match(out, /limits: 9 steps, \$5/)
  })

  test("cost and time limits interrupt the turn; a later turn is not killed by the old one", async () => {
    const pricey = await h.call("opencode_spawn", {
      prompt: "STEPS: 6",
      name: "spender",
      model: "mock/pricey",
      permissions: "allow",
      limits: { max_cost_usd: 2 },
      wait: true,
      timeout_seconds: 60,
    })
    assert.match(pricey, /INTERRUPTED[\s\S]*reason: cost limit reached/)
    // The cost of the previous turn does not count against a new one.
    const next = await h.call("opencode_message", { id: "spender", message: "cheap", limits: { max_cost_usd: 2 }, wait: true, timeout_seconds: 60 })
    assert.match(next, /IDLE[\s\S]*Echo\[none\]: cheap/)

    const slow = await h.call("opencode_spawn", { prompt: "SLOW timed", name: "timed", limits: { timeout_minutes: 0.05 }, wait: true, timeout_seconds: 60 })
    assert.match(slow, /INTERRUPTED[\s\S]*reason: time limit reached/)
  })

  test("queued messages run after the current turn", async () => {
    await h.call("opencode_spawn", { prompt: "SLOW 2s first", name: "queuer" })
    await h.call("opencode_message", { id: "queuer", message: "queued second", delivery: "queue" })
    const out = await h.call("opencode_wait", { ids: ["queuer"], timeout_seconds: 60 })
    assert.match(out, /IDLE/)
    const all = await h.call("opencode_output", { id: "queuer", scope: "all" })
    assert.match(all, /SLOW 2s first[\s\S]*Working[\s\S]*queued second[\s\S]*Echo\[none\]: queued second/)
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
    // Interrupting an idle agent is a no-op.
    assert.match(await h.call("opencode_interrupt", { id: "fast" }), /— IDLE/)
    // Resuming a running agent is refused instead of sending "you were interrupted".
    await h.call("opencode_spawn", { prompt: "SLOW busy", name: "busy" })
    await assert.rejects(h.call("opencode_resume", { id: "busy" }), /running/i)
    await h.call("opencode_interrupt", { id: "busy" })
  })

  test("graceful pause lets the running tool finish", async () => {
    const marker = path.join(repo, "paused.txt")
    await h.call("opencode_spawn", { prompt: `TOOL: sleep 4 && echo done > ${marker}`, name: "pauser", permissions: "allow" })
    await until(async () => /doing: shell/.test(await h.call("opencode_status", { ids: ["pauser"] })))
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
    const req = blocked.match(/needs permission (per_\w+): shell/)![1]!
    await assert.rejects(h.call("opencode_respond", { id: "asker", request_id: "per_nope" }), /no pending request per_nope[\s\S]*Pending: per_/)
    await h.call("opencode_respond", { id: "asker", request_id: req, decision: "always" })
    const done = await h.call("opencode_wait", { ids: ["asker"], timeout_seconds: 60 })
    assert.match(done, /IDLE[\s\S]*DONE/)
    assert.equal(fs.readFileSync(path.join(repo, "approved.txt"), "utf8").trim(), "approved")
    // "always" saved a rule for the project; it can be listed and removed.
    const saved = await h.call("opencode_permissions")
    assert.match(saved, /1 saved permission\(s\) for .*:\n(\S+) {2}shell "/, saved)
    const rule = saved.match(/\n(\S+) {2}shell/)![1]!
    assert.match(await h.call("opencode_permissions", { action: "remove", id: rule }), new RegExp(`Removed ${rule}: shell`))
    assert.match(await h.call("opencode_permissions"), /No saved permissions/)
    await assert.rejects(h.call("opencode_permissions", { action: "remove", id: "nope" }), /no saved permission nope/)

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
    assert.ok(h.elicit.seen.some((m) => m.includes('"human" wants permission: shell')))
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
    assert.match(blocked, /needs answer (frm_\w+): favourite colour\? \[Red \| Blue\]/)
    const req = blocked.match(/needs answer (frm_\w+)/)![1]!
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
    assert.match(out, /error: bad request from mock \(HTTP 400\)/)
  })

  test("a provider that cannot start is reported as an error with its cause, not idle", async () => {
    const out = await h.call("opencode_spawn", { prompt: "hello?", name: "ghost", model: "broken/model", wait: true, timeout_seconds: 120 })
    assert.match(out, /ghost .*— ERROR/)
    assert.match(out, /error: Cannot initialize broken\/model/)
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
    // A child the way OpenCode's subagent tool makes one, but deterministic: created through the API.
    const info = await h.call("opencode_server", { action: "info" })
    const [, posixFile, winFile, url] = info.match(/(?:OPENCODE_SERVER_PASSWORD="\$\(cat '([^']+)'\)"|Get-Content -Raw '([^']+)';) opencode attach (\S+)/)!
    const file = posixFile ?? winFile
    const password = fs.readFileSync(file!, "utf8")
    assert.doesNotMatch(info, new RegExp(password), "the password itself is never printed")
    const oc = OpenCode.make({ baseUrl: url!, headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } })
    const child = (await oc.session.create({ location: { directory: repo }, parentID: parent, title: "child" })).id
    await oc.session.prompt({ sessionID: child, text: "TOOL: echo child > child.txt" })
    const blocked = await h.call("opencode_wait", { ids: ["parent"], timeout_seconds: 60 })
    assert.match(blocked, new RegExp(`subagents: ${child}`))
    assert.match(blocked, new RegExp(`needs permission (per_\\w+) \\(subagent ${child}\\): shell`))
    const req = blocked.match(/needs permission (per_\w+)/)![1]!
    await h.call("opencode_respond", { id: "parent", request_id: req })
    await until(async () => fs.existsSync(path.join(repo, "child.txt")))

    // Sessions started outside this server are listed on request and adopted
    // with the cautious "ask" policy, never auto-approved by our defaults.
    const outside = (await oc.session.create({ location: { directory: repo }, title: "outside" })).id
    const listed = await h.call("opencode_status", { include_untracked: true })
    assert.match(listed, new RegExp(outside))
    assert.doesNotMatch(await h.call("opencode_status"), new RegExp(`${outside}\\) —`))
    const adopted = await h.call("opencode_status", { ids: [outside] })
    assert.match(adopted, /permissions: ask\/ask/)
    // A child id resolves to its root agent instead of being adopted on its own.
    assert.match(await h.call("opencode_status", { ids: [child] }), new RegExp(`parent \\(${parent}\\)`))
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
    assert.match(out, /Tools: .*shell/)
    assert.doesNotMatch(out, /Tools: .*webfetch/)
    const dir = out.match(/dir: (\S+) \(worktree/)![1]!
    assert.ok(!dir.startsWith(repo), "worktree lives outside the repo")
    assert.equal(fs.readFileSync(path.join(dir, "README.md"), "utf8"), "# test repo\nlocal edit\n")
    assert.equal(fs.readFileSync(path.join(dir, "scratch.txt"), "utf8"), "untracked\n")
    assert.ok(fs.lstatSync(path.join(dir, "node_modules")).isSymbolicLink())
    assert.equal(git(repo, "status", "--porcelain", "--", ".opencode"), "", "generated profile is not visible in the main checkout")

    await h.call("opencode_message", {
      id: "iso",
      message: 'TOOL: echo feature > feature.txt && git add feature.txt && git commit -qm "add feature"',
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

    // A second merge only brings the new commit, not the first batch again.
    await h.call("opencode_message", {
      id: "iso",
      message: 'TOOL: echo more > more.txt && git add more.txt && git commit -qm "add more"',
      wait: true,
      timeout_seconds: 60,
    })
    assert.match(await h.call("opencode_worktree", { id: "iso", action: "merge" }), /merged 1 commit\(s\)/)
    assert.equal(git(repo, "log", "-2", "--format=%s"), "add more\nadd feature")
    assert.match(await h.call("opencode_worktree", { id: "iso", action: "merge" }), /nothing to merge|no new commits/i)

    const disposed = await h.call("opencode_dispose", { id: "iso", worktree: "remove", delete_session: true })
    assert.match(disposed, /removed worktree/)
    assert.match(disposed, /kept branch horde\/iso/)
    assert.match(disposed, /deleted session/)
    assert.equal(fs.existsSync(dir), false)
  })

  test("worktree isolation through a symlinked path (macOS /var → /private/var)", async () => {
    const link = path.join(tmp, "repo-link")
    fs.symlinkSync(repo, link, "dir")
    const out = await h.call("opencode_spawn", { prompt: "via link", name: "linked", directory: link, isolation: "worktree", wait: true, timeout_seconds: 60 })
    assert.match(out, /linked .*— IDLE/)
    const dir = out.match(/dir: (\S+) \(worktree/)![1]!
    assert.ok(fs.existsSync(dir), `worktree dir ${dir} exists`)
    await h.call("opencode_dispose", { id: "linked", worktree: "discard" })
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

  test("worktree sync: the agent's work is replayed onto what was merged since; conflicts abort cleanly", async () => {
    await h.call("opencode_spawn", {
      prompt: "TOOL: echo mine > synced-mine.txt",
      name: "syncer",
      isolation: "worktree",
      permissions: "allow",
      wait: true,
      timeout_seconds: 60,
    })
    fs.writeFileSync(path.join(repo, "synced-theirs.txt"), "theirs\n")
    git(repo, "add", "synced-theirs.txt")
    git(repo, "commit", "-qm", "someone else's work")
    const synced = await h.call("opencode_worktree", { id: "syncer", action: "sync" })
    assert.match(synced, /rebased 1 commit\(s\) of horde\/syncer onto \S+ \(\w{10}\)/, synced)
    const status = await h.call("opencode_status", { ids: ["syncer"] })
    const dir = status.match(/dir: (\S+) \(worktree/)![1]!
    assert.ok(fs.existsSync(path.join(dir, "synced-theirs.txt")), "the agent now sees the merged work")
    assert.match(await h.call("opencode_worktree", { id: "syncer", action: "sync" }), /already contains .*nothing to sync/)
    assert.match(await h.call("opencode_worktree", { id: "syncer", action: "merge" }), /merged 1 commit\(s\) from horde\/syncer/)
    assert.equal(fs.readFileSync(path.join(repo, "synced-mine.txt"), "utf8").trim(), "mine")
    await h.call("opencode_dispose", { id: "syncer", worktree: "remove" })

    await h.call("opencode_spawn", {
      prompt: "TOOL: echo agent > sync-clash.txt",
      name: "clasher",
      isolation: "worktree",
      permissions: "allow",
      wait: true,
      timeout_seconds: 60,
    })
    fs.writeFileSync(path.join(repo, "sync-clash.txt"), "main\n")
    git(repo, "add", "sync-clash.txt")
    git(repo, "commit", "-qm", "clash")
    const before = git(repo, "rev-parse", "horde/clasher")
    await assert.rejects(
      h.call("opencode_worktree", { id: "clasher", action: "sync" }),
      /failed and was aborted; the worktree is unchanged[\s\S]*sync-clash\.txt/,
    )
    // The agent's leftovers were committed first; nothing was rebased.
    assert.equal(git(repo, "rev-parse", "horde/clasher~1"), before)
    await h.call("opencode_dispose", { id: "clasher", worktree: "discard" })
  })

  test("scope: edits inside the scope go through, edits outside are refused by OpenCode", async () => {
    const inside = await h.call("opencode_spawn", {
      prompt: 'CALL: write {"path": "scoped/in.txt", "content": "inside"}',
      name: "scoped",
      isolation: "worktree",
      permissions: "allow",
      scope: { paths: ["scoped/**"] },
      wait: true,
      timeout_seconds: 60,
    })
    const dir = inside.match(/dir: (\S+) \(worktree/)![1]!
    assert.equal(fs.readFileSync(path.join(dir, "scoped/in.txt"), "utf8"), "inside")
    const outside = await h.call("opencode_message", {
      id: "scoped",
      message: 'CALL: write {"path": "elsewhere.txt", "content": "outside"}',
      wait: true,
      timeout_seconds: 60,
    })
    assert.match(outside, /Permission denied: edit/, "the agent is told the write failed")
    assert.ok(!fs.existsSync(path.join(dir, "elsewhere.txt")), "the out-of-scope write was refused")
    await h.call("opencode_dispose", { id: "scoped", worktree: "discard" })
    // outside "ask": the out-of-scope edit comes to the caller even under the "allow" policy.
    const asking = await h.call("opencode_spawn", {
      prompt: 'CALL: write {"path": "elsewhere.txt", "content": "outside"}',
      name: "scoped-ask",
      isolation: "worktree",
      permissions: "allow",
      scope: { paths: ["scoped/**"], outside: "ask" },
      wait: true,
      timeout_seconds: 60,
    })
    assert.match(asking, /scoped-ask .*— NEEDS_INPUT[\s\S]*needs permission (per_\w+): edit/, asking)
    const req = asking.match(/needs permission (per_\w+): edit/)![1]!
    await h.call("opencode_respond", { id: "scoped-ask", request_id: req, decision: "once" })
    assert.match(await h.call("opencode_wait", { ids: ["scoped-ask"], timeout_seconds: 60 }), /IDLE/)
    const askDir = asking.match(/dir: (\S+) \(worktree/)![1]!
    assert.equal(fs.readFileSync(path.join(askDir, "elsewhere.txt"), "utf8"), "outside", "approved by the caller")
    await h.call("opencode_dispose", { id: "scoped-ask", worktree: "discard" })
    // Scope rules belong to the session, so they need no worktree: the shared checkout is confined too.
    const shared = await h.call("opencode_spawn", {
      prompt: 'CALL: write {"path": "elsewhere-shared.txt", "content": "outside"}',
      name: "scoped-shared",
      permissions: "allow",
      scope: { paths: ["scoped/**"] },
      wait: true,
      timeout_seconds: 60,
    })
    assert.match(shared, /Permission denied: edit/)
    assert.ok(!fs.existsSync(path.join(repo, "elsewhere-shared.txt")), "the out-of-scope write was refused")
  })

  test("gates: a failing check goes back to the agent, which fixes it; the caller only hears the outcome", async () => {
    // Each scenario lives in its own directory with its own horde.json checks.
    const scenario = (name: string, command: string) => {
      const dir = path.join(repo, name)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, "horde.json"), JSON.stringify({ verify: { checks: { check: command } } }))
      return name
    }
    // The failure output tells the mock model what to run, so the "fix" is real.
    const fixable = scenario(
      "gated-fix",
      `node -e "process.exit(require('fs').existsSync('fixed.txt') ? 0 : (console.log('Error: fixed.txt is missing. TOOL: echo fixed > fixed.txt'), 1))"`,
    )
    const fixed = await h.call("opencode_spawn", {
      prompt: "start the task",
      name: "gated",
      directory: fixable,
      permissions: "allow",
      gate: { max_rounds: 2 },
      wait: true,
      timeout_seconds: 120,
    })
    assert.match(fixed, /gated .*— IDLE/)
    assert.match(fixed, /gate: ✓ PASS \(round 2\/2\)/, fixed)
    assert.ok(fs.existsSync(path.join(repo, fixable, "fixed.txt")), "the agent fixed it after the verdict came back")
    const transcript = await h.call("opencode_output", { id: "gated", scope: "all" })
    assert.match(transcript, /gate round 1 of 2[\s\S]*Error: fixed\.txt is missing/, "the agent was told what failed")

    const never = scenario("gated-never", `node -e "console.log('Error: never fixed'); process.exit(1)"`)
    const failed = await h.call("opencode_spawn", { prompt: "try", name: "gated-never", directory: never, gate: true, wait: true, timeout_seconds: 120 })
    assert.match(failed, /gated-never .*— IDLE/)
    assert.match(failed, /gate: ✗ FAIL \(round 2\/2\)\n {4}FAIL · 1 check failed[\s\S]*Error: never fixed/, failed)

    const fine = scenario("gated-ok", `node -e "process.exit(0)"`)
    const passed = await h.call("opencode_spawn", { prompt: "easy", name: "gated-ok", directory: fine, gate: true, wait: true, timeout_seconds: 60 })
    assert.match(passed, /gate: ✓ PASS \(round 1\/2\) · /)
    // A new instruction starts the rounds again.
    const again = await h.call("opencode_message", { id: "gated-ok", message: "more", wait: true, timeout_seconds: 60 })
    assert.match(again, /gate: ✓ PASS \(round 1\/2\)/)
  })

  test("board: a worker reports through the CLI without prompting; a chained command is not trusted", async () => {
    const board = await Board.open(repo, path.join(tmp, "board-state"))
    const task = (await board.plan([{ title: "Limit logins", goal: "Add a rate limit to login.", acceptance: ["429 after 5 failures"], scope: ["src/**"] }]))
      .tasks[0]!
    const { attempt } = await board.assign(task.id, "limiter")
    // permissions "ask": anything not trusted would stop at needs_input.
    const out = await h.call("opencode_spawn", {
      prompt: renderBrief(board, board.task(task.id), attempt),
      name: "limiter",
      permissions: "ask",
      wait: true,
      timeout_seconds: 120,
    })
    assert.match(out, /limiter .*— IDLE/, out)
    assert.doesNotMatch(out, /needs permission/)
    const t = board.task(task.id)
    assert.equal(t.status, "review")
    assert.equal(t.reports[0]!.summary, "mock work done")
    assert.deepEqual(t.reports[0]!.unverifiedClaims, ["anything you did not run or check"])
    assert.ok(t.attempts[0]!.seenAt, "the worker read its task first")

    // The same command with something chained onto it goes through the normal policy.
    const other = (await board.plan([{ title: "Other", goal: "x" }])).tasks[0]!
    const second = await board.assign(other.id)
    const chained = `${workerCommand(board.dir)} task ${other.id} ${second.attempt.token}; echo pwned`
    const blocked = await h.call("opencode_spawn", { prompt: `TOOL: ${chained}`, name: "chained", permissions: "ask", wait: true, timeout_seconds: 60 })
    assert.match(blocked, /chained .*— NEEDS_INPUT[\s\S]*needs permission per_\w+: shell/)
    const req = blocked.match(/needs permission (per_\w+)/)![1]!
    await h.call("opencode_respond", { id: "chained", request_id: req, decision: "reject" })
    assert.equal(board.task(other.id).attempts[0]!.seenAt, undefined, "the untrusted command never ran")
  })

  test("context use shows in status; compaction summarizes and the agent carries on", async () => {
    const first = await h.call("opencode_spawn", { prompt: "remember the word kiwi", name: "long", wait: true, timeout_seconds: 60 })
    assert.match(first, /long .*— IDLE · 1 steps · .* · ctx 15\/100k \(0%\)/, first)
    assert.match(await h.call("opencode_compact", { id: "long" }), /long .*— IDLE · .* · ctx compacted/)
    assert.match(await h.call("opencode_message", { id: "long", message: "and now?", wait: true, timeout_seconds: 60 }), /Echo\[none\]: and now\?/)
    await h.call("opencode_spawn", { prompt: "SLOW", name: "busy-compact" })
    await assert.rejects(h.call("opencode_compact", { id: "busy-compact" }), /busy-compact is running; compact it once it is idle/)
    await h.call("opencode_interrupt", { id: "busy-compact" })
  })

  test("revert: the last turn's files and messages are undone; the agent carries on from before it", async () => {
    await h.call("opencode_spawn", { prompt: "hello", name: "undo", permissions: "allow", wait: true, timeout_seconds: 60 })
    const bad = await h.call("opencode_message", { id: "undo", message: "TOOL: echo oops > oops.txt", wait: true, timeout_seconds: 60 })
    assert.match(bad, /IDLE/)
    assert.ok(fs.existsSync(path.join(repo, "oops.txt")))
    const out = await h.call("opencode_revert", { id: "undo" })
    assert.match(out, /^Reverted 1 turn\(s\); restored: oops\.txt \(deleted\)\./, out)
    assert.ok(!fs.existsSync(path.join(repo, "oops.txt")), "the file is gone")
    const before = mock.requests.length
    assert.match(await h.call("opencode_message", { id: "undo", message: "and now?", wait: true, timeout_seconds: 60 }), /Echo\[none\]: and now\?/)
    const sent = JSON.stringify((mock.requests[before] as { messages: unknown[] }).messages)
    assert.ok(sent.includes("hello") && !sent.includes("oops"), "the reverted turn is not in the model's context")
    await assert.rejects(h.call("opencode_revert", { id: "undo", turns: 2 }), /undo undo's first turn, leaving nothing/)
    await assert.rejects(h.call("opencode_revert", { id: "undo", turns: 9 }), /has 2 turn\(s\) on record; cannot revert 9/)
  })

  test("ask: one-shot answers without tools; JSON checked against a schema, with one retry", async () => {
    assert.match(await h.call("opencode_ask", { prompt: "quick question" }), /^Echo\[none\]: Answer the request below directly[\s\S]*\n\(mock\/mock · \$0\)$/)
    assert.match(await h.call("opencode_ask", { prompt: "TOOLS?" }), /^Tools:\n/, "no tools are offered")
    // A provider that refuses tool-less sessions (OpenCode's free tier) gets the read-only tools only.
    const guarded = await h.call("opencode_ask", { prompt: "FREETIER TOOLS?" })
    assert.match(guarded, /^Tools: \w+[\s\S]*read-only tools offered/, guarded)
    const offered = guarded.match(/^Tools: (.*)$/m)![1]!.split(",")
    for (const tool of offered) assert.ok(["read", "grep", "glob", "list", "invalid"].includes(tool), `unexpected tool offered: ${tool} (${guarded})`)
    const schema = { type: "object", properties: { verdict: { enum: ["a", "b"] }, score: { type: "integer" } }, required: ["verdict"] }
    assert.match(
      await h.call("opencode_ask", { prompt: 'JSON: {"verdict": "a", "score": 2}', schema }),
      /^\{\n {2}"verdict": "a",\n {2}"score": 2\n\}\n\(mock\/mock/,
    )
    assert.match(await h.call("opencode_ask", { prompt: "JSON-RETRY which is better?", schema }), /"verdict": "b"[\s\S]*retried once for the schema/)
    await assert.rejects(h.call("opencode_ask", { prompt: "JSON-NEVER", schema }), /did not match the schema after one retry:\nthe reply is not JSON/)
    // Nothing is left behind: no agents, no sessions in the project's listing, the directory is ignored by git.
    assert.doesNotMatch(await h.call("opencode_status"), /ask-/)
    assert.doesNotMatch(git(repo, "status", "--porcelain"), /horde-ask/)
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
    await h.call("opencode_spawn", { prompt: "for the record", name: "recorded", wait: true, timeout_seconds: 60 })
    const list = await h.client.listResources()
    const uri = list.resources.find((r) => r.uri.includes("/transcript"))!.uri
    const res = await h.client.readResource({ uri })
    assert.match(String((res.contents[0] as { text: string }).text), /## user/)
  })
})

// A separate MCP server (and OpenCode server) with a small running limit and a
// short dialog timeout, so these tests do not depend on what the suite above left running.
describe("capacity, dialog timeouts and server restarts", { timeout: 600_000 }, () => {
  let g: Harness
  let gmock: Mock
  let groot: { tmp: string; repo: string }

  before(async () => {
    gmock = await startMockLlm()
    groot = makeRepo(gmock.url)
    g = await connect({ ...isolatedEnv(groot.tmp, groot.repo), HORDE_OPENCODE_MAX_RUNNING: "3", HORDE_OPENCODE_DIALOG_TIMEOUT: "2" }, { elicitation: true })
  })

  after(async () => {
    await g?.call("opencode_server", { action: "stop" }).catch(() => undefined)
    await g?.close()
    gmock?.close()
  })

  test("concurrent spawns never exceed the running limit", async () => {
    const names = ["c1", "c2", "c3", "c4", "c5"]
    const results = await Promise.allSettled(names.map((n) => g.call("opencode_spawn", { prompt: `SLOW ${n}`, name: n })))
    const ok = results.filter((r) => r.status === "fulfilled").length
    assert.equal(ok, 3, results.map((r) => (r.status === "rejected" ? String(r.reason) : "ok")).join("\n"))
    for (const r of results) if (r.status === "rejected") assert.match(String(r.reason), /3 agents are already working or starting/)
    const started = names.filter((_, i) => results[i]!.status === "fulfilled")
    await Promise.all(started.map((n) => g.call("opencode_interrupt", { id: n })))
    const all = await g.call("opencode_wait", { ids: started, mode: "all", timeout_seconds: 60 })
    assert.equal(all.match(/INTERRUPTED/g)?.length, 3, all)
    // The slots are free again.
    assert.match(await g.call("opencode_spawn", { prompt: "after", name: "after", wait: true, timeout_seconds: 60 }), /IDLE/)
  })

  test("a dialog the human never answers falls back to the caller", async () => {
    g.elicit.answer = () => new Promise(() => undefined)
    const out = await g.call("opencode_spawn", { prompt: "TOOL: echo late > late.txt", name: "unanswered", wait: true, timeout_seconds: 60 })
    assert.match(out, /NEEDS_INPUT[\s\S]*needs permission (per_\w+)/)
    const req = out.match(/needs permission (per_\w+)/)![1]!
    await g.call("opencode_respond", { id: "unanswered", request_id: req, decision: "once" })
    assert.match(await g.call("opencode_wait", { ids: ["unanswered"], timeout_seconds: 60 }), /IDLE[\s\S]*DONE/)
  })

  test("stopping the server does not break later calls", async () => {
    const stopped = await g.call("opencode_server", { action: "stop" })
    assert.match(stopped, /Stopped/)
    const out = await g.call("opencode_spawn", { prompt: "back again", name: "again", wait: true, timeout_seconds: 60 })
    assert.match(out, /again .*— IDLE[\s\S]*Echo\[none\]: back again/)
  })
})
