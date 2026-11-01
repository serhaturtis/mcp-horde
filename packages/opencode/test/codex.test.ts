import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { connect, git, type Harness, isolatedEnv, type Mock, makeRepo, until } from "./harness.js"
import { startMockLlm } from "./mock-llm.js"

// The Codex runtime through the tools the orchestrator uses, with a fake `codex exec` CLI that
// behaves like the real one: one process per turn, JSONL events, and `exec resume` for later turns.

interface Invocation {
  args: string[]
  prompt: string
  cwd: string
  sandbox: string
  model?: string
  addDirs?: string[]
  threadId: string
  pid: number
}

const CHECK = `const fs = require("fs")
const bad = fs.readdirSync(".").filter((f) => f.endsWith(".txt") && fs.readFileSync(f, "utf8").trim() !== "ok")
if (bad.length) {
  console.error("txt files must say ok: " + bad.join(", "))
  process.exitCode = 1
}
`

function readInvocations(codexHome: string): Invocation[] {
  const file = path.join(codexHome, "fake-codex", "invocations.jsonl")
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Invocation)
}

function thread(codexHome: string, threadId: string): { threadId: string; prompts: string[]; sandboxes: string[] } {
  return JSON.parse(fs.readFileSync(path.join(codexHome, "fake-codex", "threads", `${threadId}.json`), "utf8"))
}

function addDirs(args: string[]): string[] {
  return args.flatMap((arg, i) => (arg === "--add-dir" && args[i + 1] ? [args[i + 1]!] : []))
}

function writableRoots(args: string[]): string[] {
  const flag = args.find((arg) => arg.startsWith("sandbox_workspace_write.writable_roots="))
  if (!flag) return []
  try {
    return JSON.parse(flag.slice("sandbox_workspace_write.writable_roots=".length)) as string[]
  } catch {
    return []
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("the Codex runtime: codex exec --json and exec resume (fake CLI)", { timeout: 600_000 }, () => {
  let h: Harness
  let mock: Mock
  let repo: string
  let tmp: string
  let codexHome: string
  let taskId: (text: string) => string

  before(async () => {
    mock = await startMockLlm()
    const made = makeRepo(mock.url)
    repo = made.repo
    tmp = made.tmp
    codexHome = path.join(tmp, "codex-home")
    const fake = fileURLToPath(new URL("./fake-codex.mjs", import.meta.url))
    fs.chmodSync(fake, 0o755)
    fs.writeFileSync(path.join(repo, "check.js"), CHECK)
    fs.writeFileSync(
      path.join(repo, "horde.json"),
      JSON.stringify({
        verify: { checks: { test: "node check.js" } },
        tiers: ["codex/fake"],
        prices: { "codex/fake": { input: 1, output: 2, cachedInput: 0.1 } },
        // A chosen running limit also skips horde_do's load-average refusal on a busy test host.
        opencode: { maxRunning: 4 },
      }),
    )
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "checks")
    h = await connect({ ...isolatedEnv(tmp, repo), HORDE_CODEX_BIN: fake, CODEX_HOME: codexHome })
    taskId = (text: string) => text.match(/\bt-[0-9a-f]+\b/)![0]
  })

  after(async () => {
    try {
      await h.call("opencode_server", { action: "stop" })
    } catch {
      // The server is already gone; the test's own failure is the useful one.
    }
    await h.close()
    mock.close()
  })

  test("horde_do, a checked and reviewed outcome, tokens, priced cost, and horde_land", async () => {
    const started = await h.call("horde_do", {
      goal: "Write the greeting file.\nWRITE: note.txt=ok\nRUN: echo ok > hello.txt && git add hello.txt note.txt && git commit -qm hello",
      done: ["hello.txt says ok"],
      scope: ["hello.txt", "note.txt"],
    })
    assert.match(started, /codex\/fake \(tier 0 of 1\)/, started)
    const id = taskId(started)
    const ready = await h.call("horde_wait", { ids: [id], timeout_seconds: 120 })
    assert.match(ready, new RegExp(`^${id} READY`), ready)
    assert.match(ready, /checks ✓ test/, ready)
    assert.match(ready, /review: 1 of 1 criteria met/, ready)

    const status = await h.call("opencode_status", { ids: [id] })
    assert.match(status, /tok/, status)
    assert.match(status, /\$0\.03/, status)

    const transcript = await h.call("opencode_output", { id, detail: "summary", scope: "all" })
    assert.match(transcript, /\[bash ✓\] echo ok > hello\.txt/, transcript)
    assert.match(transcript, /\[edit ✓\] note\.txt/, transcript)

    // The review is a separate Codex session created with permissions "deny": read-only.
    const reviews = readInvocations(codexHome).filter((i) => i.prompt.includes("# Acceptance criteria"))
    assert.ok(reviews.length, "the gate's review ran on the codex runtime")
    assert.ok(
      reviews.every((i) => i.sandbox === "read-only"),
      `a review ask ran read-only: ${reviews.map((i) => i.sandbox).join(", ")}`,
    )

    const landed = await h.call("horde_land", { id })
    assert.match(landed, new RegExp(`^landed ${id} on master`), landed)
    assert.equal(fs.readFileSync(path.join(repo, "hello.txt"), "utf8").trim(), "ok")
  })

  test("horde_tell resumes the same codex thread", async () => {
    const started = await h.call("horde_do", {
      goal: "Write the second file.\nRUN: echo ok > next.txt && git add next.txt && git commit -qm next",
      done: ["next.txt says ok"],
      scope: ["next.txt", "third.txt"],
    })
    const id = taskId(started)
    assert.match(await h.call("horde_wait", { ids: [id], timeout_seconds: 120 }), / READY/)

    const worker = readInvocations(codexHome).find((i) => i.prompt.includes("Write the second file."))
    assert.ok(worker, "the worker's first turn ran")
    const boardState = path.join(tmp, "board-state")
    const firstDirs = addDirs(worker.args)
    assert.ok(
      firstDirs.some((dir) => dir.endsWith(".git")),
      `the first turn grants the git common directory: ${firstDirs.join(", ")}`,
    )
    assert.ok(
      firstDirs.some((dir) => dir.startsWith(boardState)),
      `the first turn grants the board state directory: ${firstDirs.join(", ")}`,
    )
    const before = thread(codexHome, worker.threadId)
    assert.equal(before.prompts.length, 1)

    const told = await h.call("horde_tell", {
      id,
      message: "Also write third.txt.\nRUN: echo ok > third.txt && git add third.txt && git commit -qm third",
    })
    assert.match(told, /works again/, told)
    assert.match(await h.call("horde_wait", { ids: [id], timeout_seconds: 120 }), / READY/)

    const after = thread(codexHome, worker.threadId)
    assert.equal(after.threadId, worker.threadId)
    assert.equal(after.prompts.length, 2)
    assert.ok(after.prompts[1]!.includes("Also write third.txt."))
    const resumed = readInvocations(codexHome).filter((i) => i.threadId === worker.threadId)
    assert.equal(resumed.length, 2, "the second turn was an exec resume of the same thread")
    assert.deepEqual(resumed[1]!.args.slice(0, 3), ["exec", "resume", worker.threadId])
    const resumedDirs = writableRoots(resumed[1]!.args)
    assert.ok(
      resumedDirs.some((dir) => dir.endsWith(".git")),
      `the resumed turn grants the git common directory: ${resumedDirs.join(", ")}`,
    )
    assert.ok(
      resumedDirs.some((dir) => dir.startsWith(boardState)),
      `the resumed turn grants the board state directory: ${resumedDirs.join(", ")}`,
    )

    assert.match(await h.call("horde_land", { id }), new RegExp(`^landed ${id} on master`))
    assert.equal(fs.readFileSync(path.join(repo, "third.txt"), "utf8").trim(), "ok")
  })

  test("horde_drop kills the running codex process", async () => {
    const started = await h.call("horde_do", {
      goal: "Slow work.\nSLOW\nRUN: echo ok > slow.txt",
      done: ["slow.txt says ok"],
      scope: ["slow.txt"],
    })
    const id = taskId(started)
    const invocation = await until(async () => readInvocations(codexHome).find((i) => i.prompt.includes("Slow work.")))
    assert.equal(invocation.sandbox, "workspace-write")
    assert.ok(alive(invocation.pid), "the fake codex process is running")

    const dropped = await h.call("horde_drop", { id })
    assert.match(dropped, /^dropped /, dropped)
    await until(async () => !alive(invocation.pid), 10_000)
    assert.ok(!alive(invocation.pid), "horde_drop killed the codex process")
  })
})
