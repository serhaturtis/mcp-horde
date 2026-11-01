import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import type { SessionMessageAssistant, SessionMessageIdle } from "@opencode/client"
import type { Backend } from "../src/backend.js"
import type { CreateSessionInput } from "../src/runtime.js"
import { CodexRuntime } from "../src/runtime-codex.js"
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
  let fakeBin: string
  let taskId: (text: string) => string

  before(async () => {
    mock = await startMockLlm()
    const made = makeRepo(mock.url)
    repo = made.repo
    tmp = made.tmp
    codexHome = path.join(tmp, "codex-home")
    const fake = fileURLToPath(new URL("./fake-codex.mjs", import.meta.url))
    fakeBin = fake
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
    assert.match(status, /\$0\.0065/, status)

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

  // The bug-hunt findings, against the runtime directly so the event, queue and status shapes
  // are visible. The fake CLI markers are described at the top of fake-codex.mjs.
  const newRuntime = () =>
    new CodexRuntime({ info: { workerEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? tmp } } } as unknown as Backend, fakeBin)
  const newSession = async (runtime: CodexRuntime, title: string, extra: Partial<CreateSessionInput> = {}) =>
    (await runtime.createSession({ directory: repo, title, env: { CODEX_HOME: codexHome }, ...extra })).id
  const idleMessages = (runtime: CodexRuntime, id: string, count = 1) =>
    until(async () => {
      const page = await runtime.messages(id)
      const found = page.messages.filter((m): m is SessionMessageIdle => m.type === "idle")
      return found.length >= count ? found : undefined
    }, 30_000)
  const lastAssistant = (runtime: CodexRuntime, id: string) =>
    until(async () => {
      const page = await runtime.messages(id)
      const found = [...page.messages].reverse().find((m): m is SessionMessageAssistant => m.type === "assistant")
      return found
    }, 20_000)
  const invocationWith = (text: string) => until(async () => readInvocations(codexHome).find((i) => i.prompt.includes(text)), 20_000)

  test("turn.failed and error items fail the turn, and its open tool is marked errored", async () => {
    const runtime = newRuntime()
    const failedID = await newSession(runtime, "turn failure")
    await runtime.prompt(failedID, "TURN_FAILED please")
    const failed = (await idleMessages(runtime, failedID))[0]!
    assert.equal(failed.outcome, "failed")
    assert.equal(failed.error?.message, "429 Too Many Requests")
    const assistant = await lastAssistant(runtime, failedID)
    const tool = assistant.content.find((p) => p.type === "tool")
    assert.ok(tool && tool.type === "tool", "the interrupted tool is still in the message")
    assert.equal(tool.state.status, "error")
    assert.match(JSON.stringify(tool.state), /turn ended before the tool finished/)
    assert.equal((await runtime.status(failedID)).state, "error")

    const errorID = await newSession(runtime, "error item")
    await runtime.prompt(errorID, "ERROR_ITEM please")
    const errored = (await idleMessages(runtime, errorID))[0]!
    assert.equal(errored.outcome, "failed")
    assert.equal(errored.error?.message, "the provider failed")
  })

  test("interrupt keeps a queued tell and marks its running tool interrupted", async () => {
    const runtime = newRuntime()
    const id = await newSession(runtime, "interrupt queue")
    await runtime.prompt(id, "SLOW\nTOOL_STARTED\nfirst interrupted put")
    const first = await invocationWith("first interrupted put")
    const running = await until(async () => {
      const page = await runtime.messages(id)
      const assistant = page.messages.find((m): m is SessionMessageAssistant => m.type === "assistant")
      const tool = assistant?.content.find((p) => p.type === "tool")
      return tool?.type === "tool" && tool.state.status === "running" ? tool : undefined
    }, 10_000)
    assert.equal(running.state.status, "running")

    await runtime.prompt(id, "after interrupt second put")
    await runtime.interrupt(id)
    const idles = await idleMessages(runtime, id, 2)
    assert.equal(idles[0]!.outcome, "interrupted")
    assert.equal(idles[1]!.outcome, "succeeded")

    const page = await runtime.messages(id)
    const assistants = page.messages.filter((m): m is SessionMessageAssistant => m.type === "assistant")
    const stoppedTool = assistants[0]?.content.find((p) => p.type === "tool")
    assert.ok(stoppedTool && stoppedTool.type === "tool")
    assert.equal(stoppedTool.state.status, "error")
    assert.match(JSON.stringify(stoppedTool.state), /interrupted/)
    assert.ok((await invocationWith("after interrupt second put")).pid !== first.pid, "the queued tell started after the kill")
  })

  test("a malformed file_change is skipped with a note instead of crashing", async () => {
    const runtime = newRuntime()
    const id = await newSession(runtime, "bad file change")
    await runtime.prompt(id, "BAD_FILE_CHANGE please")
    const done = (await idleMessages(runtime, id))[0]!
    assert.equal(done.outcome, "succeeded")
    const assistant = await lastAssistant(runtime, id)
    const notes = assistant.content.filter((p) => p.type === "text").map((p) => (p.type === "text" ? p.text : ""))
    assert.ok(
      notes.some((text) => /malformed|without a usable path|skipped/i.test(text)),
      `a note explains the skipped change: ${notes.join(" | ")}`,
    )
  })

  test("remove escalates to SIGKILL and never starts a queued turn", async () => {
    const runtime = newRuntime()
    const id = await newSession(runtime, "remove queue")
    await runtime.prompt(id, "STUBBORN first put")
    const first = await invocationWith("STUBBORN first put")
    await until(async () => {
      const page = await runtime.messages(id)
      return page.messages.some((m) => m.type === "assistant" && m.content.some((p) => p.type === "text" && p.text === "stubborn ready"))
    }, 10_000)
    await runtime.prompt(id, "after removal second put")
    await runtime.remove(id)
    assert.ok(alive(first.pid), "SIGTERM alone does not stop the stubborn child")
    await until(async () => !alive(first.pid), 9_000, 100)
    assert.ok(!alive(first.pid), "remove escalated to SIGKILL after 5 s")
    await new Promise((r) => setTimeout(r, 300))
    assert.ok(
      !readInvocations(codexHome).some((i) => i.prompt.includes("after removal second put")),
      "a queued turn does not start after the session was removed",
    )
    await assert.rejects(runtime.prompt(id, "later"), /unknown codex session/)
  })

  test("a rejected resume clears the thread and the next prompt starts fresh with a note", async () => {
    const runtime = newRuntime()
    const id = await newSession(runtime, "stale thread")
    await runtime.prompt(id, "first thread put")
    const first = await invocationWith("first thread put")
    await idleMessages(runtime, id)
    fs.rmSync(path.join(codexHome, "fake-codex", "threads", `${first.threadId}.json`))

    await runtime.prompt(id, "second stale resume put")
    const idles = await idleMessages(runtime, id, 2)
    assert.equal(idles[1]!.outcome, "failed")
    assert.match(idles[1]!.error?.message ?? "", /no rollout found|thread/)

    await runtime.prompt(id, "third fresh thread put")
    const all = await idleMessages(runtime, id, 3)
    assert.equal(all[2]!.outcome, "succeeded")
    const third = await invocationWith("third fresh thread put")
    assert.notEqual(third.args[1], "resume", "the fresh prompt does not resume the lost thread")
    const assistant = await lastAssistant(runtime, id)
    const text = assistant.content.map((p) => (p.type === "text" ? p.text : "")).join("\n")
    assert.match(text, /no longer available|started a new one/)
  })

  test("a resume without a thread id fails clearly, then the next prompt starts fresh", async () => {
    const runtime = newRuntime()
    const id = await newSession(runtime, "missing thread")
    await runtime.prompt(id, "NO_THREAD first put")
    await idleMessages(runtime, id)

    await runtime.prompt(id, "second without thread put")
    const idles = await idleMessages(runtime, id, 2)
    assert.equal(idles[1]!.outcome, "failed")
    assert.match(idles[1]!.error?.message ?? "", /thread id/i)
    assert.equal(readInvocations(codexHome).filter((i) => i.prompt.includes("second without thread put")).length, 0)

    await runtime.prompt(id, "third after missing thread put")
    const all = await idleMessages(runtime, id, 3)
    assert.equal(all[2]!.outcome, "succeeded")
    const third = await invocationWith("third after missing thread put")
    assert.notEqual(third.args[1], "resume", "the next prompt starts a fresh thread")
    const assistant = await lastAssistant(runtime, id)
    const text = assistant.content.map((p) => (p.type === "text" ? p.text : "")).join("\n")
    assert.match(text, /thread id|new conversation/)
  })

  test("a 300 KB prompt and one starting with '-' both reach codex through stdin", async () => {
    const runtime = newRuntime()
    const id = await newSession(runtime, "stdin prompt")
    const prompt = `-1 more thing\nPAD:${"x".repeat(300_000)}`
    await runtime.prompt(id, prompt)
    const done = (await idleMessages(runtime, id))[0]!
    assert.equal(done.outcome, "succeeded")
    const invocation = await invocationWith("-1 more thing")
    assert.equal(invocation.prompt, prompt)
    assert.ok(invocation.args.length < 20, "the prompt is not in argv")
    assert.ok(!invocation.args.some((arg) => arg.length > 1_000), "no oversized argv element")
    const assistant = await lastAssistant(runtime, id)
    assert.ok(assistant.content.some((p) => p.type === "text" && p.text.includes("-1 more thing")))
  })

  test("status follows the process, not a caller's stale active set", async () => {
    const runtime = newRuntime()
    const id = await newSession(runtime, "status authority")
    await runtime.prompt(id, "SLOW status put")
    await invocationWith("SLOW status put")
    assert.equal((await runtime.status(id, new Set())).state, "running")
    await runtime.remove(id)
  })

  test("session.created is emitted once per session, not once per turn", async () => {
    const runtime = newRuntime()
    const created: string[] = []
    runtime.events.on("event", (event: { type?: string; data?: { sessionID?: string } }) => {
      if (event.type === "session.created") created.push(event.data?.sessionID ?? "")
    })
    const id = await newSession(runtime, "created once")
    await runtime.prompt(id, "created once first put")
    await idleMessages(runtime, id)
    await runtime.prompt(id, "created once second put")
    await idleMessages(runtime, id, 2)
    assert.equal(created.filter((sessionID) => sessionID === id).length, 1)
  })

  test("an accepted variant maps to model_reasoning_effort and an unknown one is noted", async () => {
    const runtime = newRuntime()
    const acceptedID = await newSession(runtime, "variant high", { model: { providerID: "codex", id: "fake", variant: "high" } })
    await runtime.prompt(acceptedID, "variant high put")
    await idleMessages(runtime, acceptedID)
    const accepted = await invocationWith("variant high put")
    assert.ok(accepted.args.includes('model_reasoning_effort="high"'), accepted.args.join(" "))

    const ignoredID = await newSession(runtime, "variant unknown", { model: { providerID: "codex", id: "fake", variant: "ultra" } })
    await runtime.prompt(ignoredID, "variant ultra put")
    await idleMessages(runtime, ignoredID)
    const ignored = await invocationWith("variant ultra put")
    assert.ok(!ignored.args.some((arg) => arg.includes("model_reasoning_effort")), ignored.args.join(" "))
    const assistant = await lastAssistant(runtime, ignoredID)
    const text = assistant.content.map((p) => (p.type === "text" ? p.text : "")).join("\n")
    assert.match(text, /does not accept the model variant "ultra"/)
  })

  test("tool parts appear in the assistant message while the turn is still running", async () => {
    const runtime = newRuntime()
    const id = await newSession(runtime, "live steps")
    await runtime.prompt(id, "RUN: sleep 1")
    const live = await until(
      async () => {
        const page = await runtime.messages(id)
        const assistant = page.messages.find((m): m is SessionMessageAssistant => m.type === "assistant")
        const tool = assistant?.content.find((p) => p.type === "tool")
        return tool?.type === "tool" && tool.state.status === "running" ? tool : undefined
      },
      5_000,
      20,
    )
    assert.equal(live.state.status, "running")
    assert.equal((await runtime.status(id)).state, "running")
    const done = (await idleMessages(runtime, id))[0]!
    assert.equal(done.outcome, "succeeded")
    const assistant = await lastAssistant(runtime, id)
    const tool = assistant.content.find((p) => p.type === "tool")
    assert.ok(tool && tool.type === "tool")
    assert.equal(tool.state.status, "completed")
  })

  test("pricing charges only uncached input and does not add reasoning to output", async () => {
    const runtime = newRuntime()
    const id = await newSession(runtime, "pricing", { model: { providerID: "codex", id: "fake" } })
    await runtime.prompt(id, "pricing put")
    await idleMessages(runtime, id)
    const info = await runtime.session(id)
    // 29420 input - 25856 cached, at $1/M; 151 output at $2/M; 25856 cached at $0.10/M.
    assert.ok(Math.abs(info.cost - 0.0064516) < 1e-9, `cost was ${info.cost}`)
    assert.equal(info.tokens.input, 29420)
    assert.equal(info.tokens.output, 151)
    assert.equal(info.tokens.cache.read, 25856)
  })
})
