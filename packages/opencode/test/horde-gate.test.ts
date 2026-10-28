import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { Board, projectOf } from "@mcp-horde/board"
import { lockDirFor } from "@mcp-horde/verify"
import { git, type Harness, type Mock, makeRepo, until } from "./harness.js"
import { CHECK, createHordeEnv, type HordeEnv } from "./horde-support.js"

// The simple path the way an agent that has never seen the horde uses it: horde_do, horde_wait,
// horde_land, and horde_tell / horde_drop when something goes wrong.

describe("the simple path: horde_do, horde_wait, horde_land (real opencode, mock LLM)", { timeout: 600_000 }, () => {
  let env: HordeEnv
  let h: Harness
  let mock: Mock
  let repo: string
  let tmp: string
  let boardState: () => string
  let idOf: (text: string) => string
  let settle: (id: string) => Promise<string>

  before(async () => {
    env = await createHordeEnv()
    ;({ h, mock, repo, tmp, boardState, idOf, settle } = env)
  })

  after(async () => {
    await env.close()
  })

  test("horde_do refuses up front in a repository without checks, and says how to add them", async () => {
    const bare = path.join(tmp, "no-checks")
    fs.mkdirSync(bare)
    fs.writeFileSync(path.join(bare, "README.md"), "# nothing to run\n")
    git(bare, "init", "-q")
    git(bare, "add", ".")
    git(bare, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init")
    await assert.rejects(h.call("horde_do", { goal: "Change the README.", directory: bare }), (err: Error) => {
      assert.match(err.message, /no checks found in .*no-checks, so nothing was started/)
      assert.match(err.message, /"verify": \{"checks"/)
      return true
    })
    assert.deepEqual((await Board.open(bare, boardState())).tasks(), [], "no task was planned")
    // Checks only in the working tree: the workers' gates read HEAD's horde.json and would find none.
    fs.writeFileSync(path.join(bare, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } } }))
    await assert.rejects(h.call("horde_do", { goal: "Change the README.", directory: bare }), /horde\.json are not committed, so nothing was started/)
  })

  test("horde_do refuses a detached HEAD before a board task or worktree exists", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } }, tiers: ["mock/mock"] }))
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    git(r, "checkout", "--detach", "-q")
    await assert.rejects(h.call("horde_do", { directory: r, goal: "Say hi." }), (err: Error) => {
      assert.ok(err.message.includes(`your checkout ${r} is on a detached HEAD; switch to a branch first`), err.message)
      return true
    })
    assert.deepEqual((await Board.open(r, boardState())).tasks(), [], "no task was planned")
    assert.equal(git(r, "branch", "--list", "horde/*"), "", "no worktree branch was created")
  })

  test("horde_do in a non-git directory refuses before creating a board", async () => {
    const plain = path.join(tmp, "plain-not-a-repo")
    fs.mkdirSync(plain, { recursive: true })
    fs.writeFileSync(path.join(plain, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } } }))
    await assert.rejects(h.call("horde_do", { directory: plain, goal: "Say hi." }), /isolation "worktree" needs a git repository/)
    const { key } = await projectOf(plain)
    assert.ok(!fs.existsSync(path.join(boardState(), key)), "no board was created for the plain directory")
  })

  test("horde_drop closes a task whose worker never started", async () => {
    const board = await Board.open(repo, boardState())
    const [task] = (await board.plan([{ title: "Stale claim", goal: "Never started.", acceptance: [], scope: [] }])).tasks
    const dropped = await h.call("horde_drop", { id: task!.id, reason: "stale" })
    assert.match(dropped, new RegExp(`^dropped ${task!.id}: it had no worker`), dropped)
    assert.equal((await Board.open(repo, boardState())).task(task!.id).status, "failed")
    await assert.rejects(h.call("horde_drop", { id: "t-0000" }), /unknown agent/)
  })

  test("a workers.land command's file is committed on top and landed, judged by the checks", async () => {
    const { tmp: at, repo: r } = makeRepo(mock.url)
    const marker = path.join(at, "land-check.ran")
    // The land command writes the rebased HEAD's subject; the land check asserts it is the worker's.
    fs.writeFileSync(
      path.join(r, "horde.json"),
      JSON.stringify({
        verify: {
          checks: {
            ok: "true",
            land: {
              command: `node -e "require('fs').readFileSync('generated.txt','utf8').trim()==='worker'||process.exit(1);require('fs').writeFileSync(process.argv[1],'ran')" ${JSON.stringify(marker)}`,
              when: "land",
            },
          },
        },
        workers: { land: { command: "git log -1 --format=%s > generated.txt", message: "chore: generated" } },
        tiers: ["mock/mock", "mock/pricey"],
      }),
    )
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    const id = idOf(
      await h.call("horde_do", {
        directory: r,
        goal: "Write worker.txt.\nRUN: echo ok > worker.txt && git add worker.txt && git commit -qm worker",
        done: ["worker.txt exists"],
        scope: ["worker.txt"],
      }),
    )
    await settle(id)
    // Master moves so the landing actually rebases the worker's commit onto a new tip.
    fs.writeFileSync(path.join(r, "master.txt"), "m\n")
    git(r, "add", "master.txt")
    git(r, "commit", "-qm", "master moves")
    const landed = await h.call("horde_land", { id })
    assert.match(landed, new RegExp(`^landed ${id} on master: 2 commit\\(s\\)`), landed)
    assert.ok(fs.existsSync(marker), "the land check ran and passed")
    assert.equal(fs.readFileSync(path.join(r, "generated.txt"), "utf8").trim(), "worker", "the command's file landed")
    assert.equal(git(r, "log", "-1", "--format=%s"), "chore: generated", "the land commit has the configured message")
  })

  test("a failed land check leaves the worker's branch without the workers.land commit or its files", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(
      path.join(r, "horde.json"),
      JSON.stringify({
        verify: {
          checks: {
            test: `node -e "const fs=require('fs'); if (fs.existsSync('worker.txt') && fs.existsSync('generated.txt')) { console.log('TAP version 13'); console.log('not ok 1 - both'); console.log('  ---'); console.log('  message: Error: worker.txt and generated.txt must not exist together'); console.log('  ...'); process.exit(1) }"`,
          },
        },
        workers: { land: "node -e \"require('fs').writeFileSync('generated.txt', 'x')\"" },
        tiers: ["mock/mock", "mock/pricey"],
      }),
    )
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    const started = await h.call("horde_do", {
      directory: r,
      goal: "Write worker.txt.\nRUN: echo ok > worker.txt && git add worker.txt && git commit -qm worker",
      done: ["worker.txt exists"],
      scope: ["worker.txt"],
    })
    const id = idOf(started)
    const branch = started.match(/worktree (horde\/[\w-]+)/)![1]!
    await settle(id)
    const refused = await h.call("horde_land", { id })
    assert.match(refused, /^not landed: .*'s commits fail the checks on top of master:/, refused)
    assert.equal(git(r, "log", "-1", "--format=%s", branch), "worker", "the workers.land commit is gone from the branch")
    assert.ok(!git(r, "show", "--name-only", "--format=", branch).split("\n").includes("generated.txt"), "nor the file it wrote")
    await h.call("horde_drop", { id })
  })

  test("a failed workers.land command leaves the worker's branch without its files", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(
      path.join(r, "horde.json"),
      JSON.stringify({
        verify: { checks: { test: "true" } },
        workers: { land: "node -e \"require('fs').writeFileSync('generated.txt', 'x'); process.exit(1)\"" },
        tiers: ["mock/mock", "mock/pricey"],
      }),
    )
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    const started = await h.call("horde_do", {
      directory: r,
      goal: "Write worker.txt.\nRUN: echo ok > worker.txt && git add worker.txt && git commit -qm worker",
      done: ["worker.txt exists"],
      scope: ["worker.txt"],
    })
    const id = idOf(started)
    const branch = started.match(/worktree (horde\/[\w-]+)/)![1]!
    const ready = await settle(id)
    const worktree = ready.match(/diff: git -C (\S+) diff/)![1]!
    const refused = await h.call("horde_land", { id })
    assert.match(refused, /^not landed: .*workers\.land step failed/, refused)
    assert.equal(git(r, "log", "-1", "--format=%s", branch), "worker", "the worker's branch keeps only its own work")
    assert.ok(!fs.existsSync(path.join(worktree, "generated.txt")), "the command's file was not kept in the worktree")
    await h.call("horde_drop", { id })
  })

  test("a worker told it carried a checkout's untracked file deletes it and lands only its tracked change", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(path.join(r, "tracked.txt"), "stale\n")
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } }, tiers: ["mock/mock", "mock/pricey"] }))
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    // The orchestrator's untracked export (a binary), carried over as the worktree's baseline.
    fs.writeFileSync(path.join(r, "carried.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]))
    const seen = mock.requests.length
    const id = idOf(
      await h.call("horde_do", {
        directory: r,
        goal: "Delete the carried file and update the tracked one.\nRUN: rm carried.png && echo ok > tracked.txt && git add -A && git commit -qm change",
        done: ["tracked.txt says ok"],
        scope: ["tracked.txt", "carried.png"],
      }),
    )
    // The worker's first prompt names the carried-over file and forbids touching it.
    const prompts = (mock.requests.slice(seen) as { messages?: { role: string; content: unknown }[] }[])
      .flatMap((q) => q.messages ?? [])
      .map((m) => (typeof m.content === "string" ? m.content : ((m.content as { text?: string }[] | undefined) ?? []).map((p) => p.text ?? "").join(" ")))
      .join("\n")
    assert.ok(
      prompts.includes(
        "holds 1 file(s) that are uncommitted in the main checkout, not the project's committed state: carried.png. Do not delete, move or rewrite them",
      ),
      prompts,
    )
    const ready = await settle(id)
    assert.match(ready, new RegExp(`^${id} READY`), ready)
    assert.match(ready, /1 deleted file\(s\) exist only in your checkout's uncommitted changes and stay as they are when landed/, ready)
    const landed = await h.call("horde_land", { id })
    assert.match(landed, new RegExp(`^landed ${id} on master: 1 commit\\(s\\)`), landed)
    assert.equal(git(r, "show", "--name-only", "--format=", "HEAD"), "tracked.txt", "only the tracked change landed")
    assert.equal(git(r, "status", "--porcelain"), "?? carried.png", "the untracked file stays untracked in the checkout")
  })

  test("a conflict confined to generated files is resolved by the land step, which regenerates them", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.mkdirSync(path.join(r, "src"), { recursive: true })
    fs.mkdirSync(path.join(r, "dist"), { recursive: true })
    fs.writeFileSync(path.join(r, "src", "worker.txt"), "base\n")
    fs.writeFileSync(path.join(r, "src", "master.txt"), "base\n")
    fs.writeFileSync(path.join(r, "dist", "out.txt"), "base\n")
    fs.writeFileSync(
      path.join(r, "horde.json"),
      JSON.stringify({
        verify: { checks: { test: "true" }, audit: { generated: ["dist/**"] } },
        workers: {
          land: `node -e "require('fs').writeFileSync('dist/out.txt', require('fs').readFileSync('src/worker.txt','utf8').trim() + '-' + require('fs').readFileSync('src/master.txt','utf8').trim())"`,
        },
        tiers: ["mock/mock", "mock/pricey"],
      }),
    )
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    const id = idOf(
      await h.call("horde_do", {
        directory: r,
        goal: "Change the worker source and its generated output.\nRUN: echo worker > src/worker.txt && echo worker-dist > dist/out.txt && git add -A && git commit -qm worker",
        done: ["src/worker.txt says worker"],
        scope: ["src/**", "dist/**"],
      }),
    )
    await settle(id)
    // Master changes a different source file and regenerates the same output.
    fs.writeFileSync(path.join(r, "src", "master.txt"), "master\n")
    fs.writeFileSync(path.join(r, "dist", "out.txt"), "master-dist\n")
    git(r, "add", "-A")
    git(r, "commit", "-qm", "master regenerates")
    const landed = await h.call("horde_land", { id })
    assert.match(landed, new RegExp(`^landed ${id} on master: 2 commit\\(s\\)`), landed)
    assert.match(landed, /resolved 1 conflict\(s\) in generated files with master's version; the land step regenerated them/, landed)
    assert.equal(fs.readFileSync(path.join(r, "dist", "out.txt"), "utf8").trim(), "worker-master", "the land step regenerated the file from both sources")
    assert.equal(fs.readFileSync(path.join(r, "src", "worker.txt"), "utf8").trim(), "worker")
    assert.equal(fs.readFileSync(path.join(r, "src", "master.txt"), "utf8").trim(), "master")
  })

  test("a conflict confined to generated files with no workers.land is refused, naming them", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.mkdirSync(path.join(r, "src"), { recursive: true })
    fs.mkdirSync(path.join(r, "dist"), { recursive: true })
    fs.writeFileSync(path.join(r, "src", "worker.txt"), "base\n")
    fs.writeFileSync(path.join(r, "src", "master.txt"), "base\n")
    fs.writeFileSync(path.join(r, "dist", "out.txt"), "base\n")
    fs.writeFileSync(
      path.join(r, "horde.json"),
      JSON.stringify({ verify: { checks: { test: "true" }, audit: { generated: ["dist/**"] } }, tiers: ["mock/mock", "mock/pricey"] }),
    )
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    const id = idOf(
      await h.call("horde_do", {
        directory: r,
        goal: "Change the worker source and its generated output.\nRUN: echo worker > src/worker.txt && echo worker-dist > dist/out.txt && git add -A && git commit -qm worker",
        done: ["src/worker.txt says worker"],
        scope: ["src/**", "dist/**"],
      }),
    )
    await settle(id)
    fs.writeFileSync(path.join(r, "src", "master.txt"), "master\n")
    fs.writeFileSync(path.join(r, "dist", "out.txt"), "master-dist\n")
    git(r, "add", "-A")
    git(r, "commit", "-qm", "master regenerates")
    const head = git(r, "rev-parse", "HEAD")
    const refused = await h.call("horde_land", { id })
    assert.match(refused, /only in generated files \(dist\/out\.txt\); master is unchanged\./, refused)
    assert.match(refused, /Set horde\.json "workers\.land" to the command that regenerates them/, refused)
    assert.equal(git(r, "rev-parse", "HEAD"), head, "master did not move")
    await h.call("horde_drop", { id })
  })

  test("a conflict in a non-generated file is still refused, even with generated paths set", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(path.join(r, "conflict.txt"), "base\n")
    fs.writeFileSync(
      path.join(r, "horde.json"),
      JSON.stringify({ verify: { checks: { test: "true" }, audit: { generated: ["dist/**"] } }, tiers: ["mock/mock", "mock/pricey"] }),
    )
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    const id = idOf(
      await h.call("horde_do", {
        directory: r,
        goal: "Change conflict.txt to worker.\nRUN: echo worker > conflict.txt && git add -A && git commit -qm worker",
        done: ["conflict.txt says worker"],
        scope: ["conflict.txt"],
      }),
    )
    await settle(id)
    fs.writeFileSync(path.join(r, "conflict.txt"), "master\n")
    git(r, "add", "conflict.txt")
    git(r, "commit", "-qm", "master change")
    const refused = await h.call("horde_land", { id })
    assert.match(refused, /not landed: .*conflict with master in conflict\.txt/, refused)
    await h.call("horde_drop", { id })
  })

  test("the first answer names the useful parallelism when a check has slots", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { test: { command: "true", slots: 1 } } }, tiers: ["mock/mock"] }))
    git(r, "add", "horde.json")
    git(r, "commit", "-qm", "checks")
    const started = await h.call("horde_do", {
      directory: r,
      goal: "Write p.txt.\nRUN: echo ok > p.txt && git add p.txt && git commit -qm p",
      done: ["p.txt exists"],
      scope: ["p.txt"],
    })
    assert.match(started, /at most 1 task\(s\) can usefully run at once on this repository \(test has 1 slot\)/, started)
    await h.call("horde_drop", { id: idOf(started) })
  })

  test("the first answer names setup, every check and land with cwd and env names; a changed set is announced once", async () => {
    const { repo: r } = makeRepo(mock.url)
    const horde = (env: string, land: string) =>
      JSON.stringify({
        verify: { checks: { test: { command: 'node -e "0"', env: { [env]: "1" } } } },
        workers: { setup: 'node -e "0"', land },
        tiers: ["mock/mock"],
      })
    fs.writeFileSync(path.join(r, "horde.json"), horde("FOO", 'node -e "0"'))
    git(r, "add", "horde.json")
    git(r, "commit", "-qm", "commands")

    const first = await h.call("horde_do", { directory: r, goal: "Write q.txt.\nRUN: echo ok > q.txt && git add q.txt && git commit -qm q", scope: ["q.txt"] })
    assert.match(first, /workers\.setup \(node -e "0" · cwd: \. · env: none\)/, first)
    assert.match(first, /check test \(node -e "0" · cwd: \. · env: FOO\)/, first)
    assert.match(first, /workers\.land \(node -e "0" · cwd: \. · env: none\)/, first)
    assert.doesNotMatch(first, /commands changed since/, first)
    await h.call("horde_drop", { id: idOf(first) })

    fs.writeFileSync(path.join(r, "horde.json"), horde("BAR", 'node -e "1"'))
    git(r, "add", "horde.json")
    git(r, "commit", "-qm", "change commands")
    const second = await h.call("horde_do", { directory: r, goal: "Write r.txt.\nRUN: echo ok > r.txt && git add r.txt && git commit -qm r", scope: ["r.txt"] })
    assert.match(second, /horde\.json's commands changed since you last ran a task here: .*\+ workers\.land .*− check test /, second)
    await h.call("horde_drop", { id: idOf(second) })

    const third = await h.call("horde_do", { directory: r, goal: "Write s.txt.\nRUN: echo ok > s.txt && git add s.txt && git commit -qm s", scope: ["s.txt"] })
    assert.doesNotMatch(third, /commands changed since/, third)
    assert.match(third, /check test \(node -e "0" · cwd: \. · env: BAR\)/, third)
    await h.call("horde_drop", { id: idOf(third) })
  })

  test("horde_wait and opencode_status name the check a gate waits on and its slot holder", async () => {
    const { repo: r } = makeRepo(mock.url, { permission: { bash: "allow" } })
    fs.writeFileSync(
      path.join(r, "horde.json"),
      JSON.stringify({ verify: { checks: { test: { command: 'node -e "setTimeout(() => {}, 60000)"', slots: 1 } } }, tiers: ["mock/mock"] }),
    )
    git(r, "add", "horde.json")
    git(r, "commit", "-qm", "checks")
    const lockDir = await lockDirFor(r, path.join(tmp, "xdg-state", "mcp-horde", "verify"))
    fs.mkdirSync(lockDir, { recursive: true })
    const lockFile = path.join(lockDir, "check-test.0.lock")
    // Another process holds the one test slot, heartbeating its lock as core's withLock does.
    const holder = spawn(
      process.execPath,
      [
        "-e",
        `const fs = require("fs")
const file = process.argv[1]
fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: require("os").hostname(), token: "test" }))
setInterval(() => { const t = new Date(); fs.utimesSync(file, t, t) }, 5000)
setTimeout(() => process.exit(0), 60000)`,
        lockFile,
      ],
      { stdio: "ignore" },
    )
    try {
      await until(async () => fs.existsSync(lockFile))
      const started = await h.call("horde_do", {
        directory: r,
        goal: "Write n.txt.\nRUN: echo ok > n.txt && git add n.txt && git commit -qm n",
        done: ["n.txt exists"],
        scope: ["n.txt"],
      })
      const id = idOf(started)
      let waited = ""
      const deadline = Date.now() + 30_000
      while (!waited && Date.now() < deadline) {
        const out = await h.call("horde_wait", { ids: [id], timeout_seconds: 1 })
        const match = out.match(/gate round \d+: waiting for the test slot held by pid \d+ for \S+/)
        if (match) waited = match[0]
        else if (new RegExp(`^${id} (READY|FAILED|REPORT)`).test(out)) break
      }
      assert.match(waited, new RegExp(`^gate round \\d+: waiting for the test slot held by pid ${holder.pid} for `), waited)
      const status = await h.call("opencode_status", { ids: [id] })
      assert.match(status, new RegExp(`gate: running checks · gate round \\d+: waiting for the test slot held by pid ${holder.pid} for `), status)
      await h.call("horde_drop", { id })
    } finally {
      holder.kill("SIGKILL")
      fs.rmSync(lockFile, { force: true })
    }
  })

  test("an uncommitted horde.json is not carried over; the gate runs HEAD's and the notes say so", async () => {
    const { repo: r } = makeRepo(mock.url)
    const committed = "echo committed > marker.txt"
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { test: committed } }, tiers: ["mock/mock", "mock/pricey"] }))
    git(r, "add", "horde.json")
    git(r, "commit", "-qm", "checks")
    // The user edits horde.json locally and leaves another, unrelated change uncommitted.
    fs.writeFileSync(
      path.join(r, "horde.json"),
      JSON.stringify({ verify: { checks: { test: "echo uncommitted > marker.txt" } }, tiers: ["mock/mock", "mock/pricey"] }),
    )
    fs.writeFileSync(path.join(r, "carried.txt"), "carried\n")

    const started = await h.call("horde_do", {
      directory: r,
      goal: "Write hello.txt.\nRUN: echo ok > hello.txt && git add hello.txt && git commit -qm hello",
      done: ["hello.txt says ok"],
      scope: ["hello.txt"],
    })
    assert.match(started, /echo committed/, started) // the announced checks are HEAD's, not the edit
    assert.doesNotMatch(started, /echo uncommitted/, started)
    assert.match(started, /horde\.json's uncommitted changes stay in your checkout; tasks use HEAD's/, started)
    const id = idOf(started)
    const ready = await settle(id)
    assert.match(ready, new RegExp(`^${id} READY`), ready)
    const worktree = ready.match(/diff: git -C (\S+) diff/)![1]!
    assert.equal(fs.readFileSync(path.join(worktree, "marker.txt"), "utf8").trim(), "committed", "the gate ran HEAD's horde.json")
    assert.ok(fs.existsSync(path.join(worktree, "carried.txt")), "other uncommitted changes are still carried over")
    assert.match(fs.readFileSync(path.join(r, "horde.json"), "utf8"), /echo uncommitted/, "the edit stays in the checkout")
    await h.call("horde_drop", { id })
  })

  test("an explicit model that is a tier records it, so escalation does not name the same model", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(path.join(r, "check.js"), CHECK)
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { test: "node check.js" } }, tiers: ["mock/mock", "mock/pricey"] }))
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    const started = await h.call("horde_do", {
      directory: r,
      model: "mock/pricey",
      goal: "Write the stubborn file.\nRUN: echo nope > stubborn.txt && git add stubborn.txt && git commit -qm stubborn",
      done: ["stubborn.txt says ok"],
      scope: ["stubborn.txt"],
    })
    assert.match(started, /mock\/pricey \(tier 1 of 2\)/, started)
    const id = idOf(started)
    const failed = await settle(id)
    assert.match(failed, new RegExp(`^${id} FAILED`), failed)
    assert.match(failed, /mock\/pricey \(tier 1\)/, failed)
    assert.doesNotMatch(failed, /tier 2 is/, failed)
    assert.doesNotMatch(failed, /model: "mock\/pricey"/, failed)
    assert.equal((await Board.open(r, boardState())).task(id).tier, 1)
    await h.call("horde_drop", { id })
  })

  test("an explicit model that matches no tier keeps tier 0", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } }, tiers: ["mock/mock", "mock/pricey"] }))
    git(r, "add", "horde.json")
    git(r, "commit", "-qm", "checks")
    const started = await h.call("horde_do", {
      directory: r,
      model: "mock/other",
      goal: "Write fine.txt.\nRUN: echo ok > fine.txt && git add fine.txt && git commit -qm fine",
      done: ["fine.txt says ok"],
      scope: ["fine.txt"],
    })
    assert.match(started, /mock\/other \(tier 0 of 2\)/, started)
    const id = idOf(started)
    const ready = await settle(id)
    assert.match(ready, /mock\/other \(tier 0; tier 1 is mock\/pricey\)/, ready)
    assert.equal((await Board.open(r, boardState())).task(id).tier, 0)
    await h.call("horde_drop", { id })
  })

  test("landing runs the committed workers.land, not an uncommitted edit in the checkout", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(
      path.join(r, "horde.json"),
      JSON.stringify({
        verify: { checks: { test: "true" } },
        workers: { land: `node -e "require('fs').writeFileSync('generated.txt','committed')"` },
        tiers: ["mock/mock", "mock/pricey"],
      }),
    )
    git(r, "add", "horde.json")
    git(r, "commit", "-qm", "checks")
    // The orchestrator edits the checkout's working horde.json without committing it: only the
    // commit the work lands on is the rules, so the committed command must run.
    fs.writeFileSync(
      path.join(r, "horde.json"),
      JSON.stringify({
        verify: { checks: { test: "true" } },
        workers: { land: `node -e "require('fs').writeFileSync('generated.txt','working')"` },
        tiers: ["mock/mock", "mock/pricey"],
      }),
    )
    const id = idOf(
      await h.call("horde_do", {
        directory: r,
        goal: "Write worker.txt.\nRUN: echo ok > worker.txt && git add worker.txt && git commit -qm worker",
        done: ["worker.txt exists"],
        scope: ["worker.txt"],
      }),
    )
    await settle(id)
    const landed = await h.call("horde_land", { id })
    assert.match(landed, new RegExp(`^landed ${id} on master:`), landed)
    assert.equal(fs.readFileSync(path.join(r, "generated.txt"), "utf8").trim(), "committed", "the committed workers.land ran, not the working edit")
  })

  test("a worker that moves the target branch onto its own commit is refused", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } }, tiers: ["mock/mock", "mock/pricey"] }))
    git(r, "add", "horde.json")
    git(r, "commit", "-qm", "checks")
    const started = await h.call("horde_do", {
      directory: r,
      goal: [
        "Write the file.",
        "RUN: echo ok > moved.txt && git add moved.txt && git commit -qm moved",
        // The worker commits a loosened horde.json and points the target branch at it: the rules
        // it would have the gate read are its own.
        `RUN: node -e "require('fs').writeFileSync('horde.json', JSON.stringify({verify:{checks:{test:'true'}},audit:{off:['scope','tests','secrets','binaries']}}))" && git add horde.json && git commit -qm loosen`,
        "RUN: git update-ref refs/heads/master $(git rev-parse HEAD)",
      ].join("\n"),
      done: ["moved.txt exists"],
      scope: ["moved.txt"],
    })
    const id = idOf(started)
    const out = await settle(id)
    assert.match(out, new RegExp(`^${id} FAILED`), out)
    assert.match(out, /the target branch's tip is on the worker's branch; the worker moved it/, out)
    // The landing refuses too, rather than "not ready to land".
    const refused = await h.call("horde_land", { id })
    assert.match(refused, /^not landed: the target branch's tip is on the worker's branch; the worker moved it/, refused)
    await h.call("opencode_dispose", { id, worktree: "discard" })
  })

  test("work already squash-merged onto master is recognised and closed without empty commits", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } }, tiers: ["mock/mock", "mock/pricey"] }))
    git(r, "add", "horde.json")
    git(r, "commit", "-qm", "checks")
    const started = await h.call("horde_do", {
      directory: r,
      // Two commits: the squash's patch-id matches neither, so only the tree comparison sees it.
      goal: "Write two files.\nRUN: echo one > one.txt && git add one.txt && git commit -qm one\nRUN: echo two > two.txt && git add two.txt && git commit -qm two",
      done: ["one.txt and two.txt exist"],
      scope: ["one.txt", "two.txt"],
    })
    const id = idOf(started)
    const branch = started.match(/worktree (horde\/[\w-]+)/)![1]!
    await settle(id)
    const before = git(r, "rev-parse", "HEAD")
    // The orchestrator squash-merges the worker's branch by hand.
    git(r, "merge", "--squash", branch)
    git(r, "commit", "-qm", "squash merge")
    assert.equal(git(r, "rev-list", "--count", `${before}..HEAD`), "1", "master now has the worker's change")
    const landed = await h.call("horde_land", { id })
    assert.match(landed, new RegExp(`^${id}'s 2 commit\\(s\\) are already on master \\(the work's tree is already there\\): nothing to land`), landed)
    assert.equal(git(r, "rev-list", "--count", `${before}..HEAD`), "1", "no empty commit was added on top of the squash merge")
    assert.equal(git(r, "branch", "--list", "horde/*"), "", "the branch is gone")
  })

  test("a partly squash-merged task drops the commits that became empty and lands the rest", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(path.join(r, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } }, tiers: ["mock/mock", "mock/pricey"] }))
    git(r, "add", "horde.json")
    git(r, "commit", "-qm", "checks")
    const started = await h.call("horde_do", {
      directory: r,
      goal: "Write two files.\nRUN: echo a > a.txt && git add a.txt && git commit -qm a\nRUN: echo b > b.txt && git add b.txt && git commit -qm b",
      done: ["a.txt and b.txt exist"],
      scope: ["a.txt", "b.txt"],
    })
    const id = idOf(started)
    await settle(id)
    // Master gets a.txt through a different commit (a.txt + c.txt), so the worker's a.txt commit
    // replays empty while b.txt lands.
    fs.writeFileSync(path.join(r, "a.txt"), "a\n")
    fs.writeFileSync(path.join(r, "c.txt"), "c\n")
    git(r, "add", "a.txt", "c.txt")
    git(r, "commit", "-qm", "master a and c")
    const landed = await h.call("horde_land", { id })
    assert.match(landed, new RegExp(`^landed ${id} on master: 1 commit\\(s\\)`), landed)
    assert.match(landed, /1 of 2 commits became empty on master/, landed)
    assert.equal(git(r, "show", "--name-only", "--format=", "HEAD"), "b.txt", "only b.txt landed")
  })

  test("a check that rewrites a tracked file refuses the fast-forward, naming it", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.writeFileSync(path.join(r, "data.txt"), "stale\n")
    fs.writeFileSync(
      path.join(r, "horde.json"),
      JSON.stringify({
        verify: { checks: { test: "true", gen: { command: `node -e "require('fs').writeFileSync('data.txt','generated')"`, when: "land" } } },
        tiers: ["mock/mock", "mock/pricey"],
      }),
    )
    git(r, "add", ".")
    git(r, "commit", "-qm", "checks")
    const id = idOf(
      await h.call("horde_do", {
        directory: r,
        goal: "Write worker.txt.\nRUN: echo ok > worker.txt && git add worker.txt && git commit -qm worker",
        done: ["worker.txt exists"],
        scope: ["worker.txt"],
      }),
    )
    await settle(id)
    const before = git(r, "rev-parse", "HEAD")
    const refused = await h.call("horde_land", { id })
    assert.match(refused, /not landed: the checks modified tracked files/, refused)
    assert.match(refused, /data\.txt/, refused)
    assert.match(refused, /workers\.land/, refused)
    assert.equal(git(r, "rev-parse", "HEAD"), before, "master did not move")
    await h.call("horde_drop", { id })
  })

  test("a task started from a subdirectory is gated at landing by the subdirectory's checks", async () => {
    const { repo: r } = makeRepo(mock.url)
    fs.mkdirSync(path.join(r, "api"), { recursive: true })
    fs.writeFileSync(path.join(r, "api", "package.json"), JSON.stringify({ scripts: { test: "true" } }))
    git(r, "add", ".")
    git(r, "commit", "-qm", "api package")
    const started = await h.call("horde_do", {
      directory: path.join(r, "api"),
      goal: "Write api.txt.\nRUN: echo ok > api.txt && git add api.txt && git commit -qm api",
      done: ["api.txt says ok"],
    })
    const id = idOf(started)
    const ready = await settle(id)
    assert.match(ready, new RegExp(`^${id} READY`), ready)
    const landed = await h.call("horde_land", { id })
    assert.match(landed, new RegExp(`^landed ${id} on master: 1 commit\\(s\\)`), landed)
    assert.ok(fs.existsSync(path.join(r, "api", "api.txt")), "the subdirectory's work landed")
  })
})
