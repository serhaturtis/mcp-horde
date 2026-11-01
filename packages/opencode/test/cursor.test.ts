import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { Board } from "@mcp-horde/board"
import { connect, git, type Harness, isolatedEnv, type Mock, makeRepo, until } from "./harness.js"
import { startMockLlm } from "./mock-llm.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const fakeScript = path.join(here, "fake-cursor.mjs")

// The project's one check: every .txt file says "ok".
const CHECK = `const fs = require("fs")
const bad = []
for (const f of fs.readdirSync(".").filter((f) => f.endsWith(".txt"))) {
  if (fs.readFileSync(f, "utf8").trim() !== "ok") bad.push(f + " must say ok")
}
if (bad.length) throw new Error(bad.join("\\n"))
`

describe("the cursor runtime: Cursor's agent CLI as a worker", { timeout: 600_000 }, () => {
  let h: Harness
  let mock: Mock
  let repo: string
  let tmp: string
  let cursorState: string
  let boardState: () => string
  let idOf: (text: string) => string
  let settle: (id: string) => Promise<string>
  let calls: () => Record<string, unknown>[]
  let alive: (pid: number) => boolean

  before(async () => {
    mock = await startMockLlm()
    ;({ tmp, repo } = makeRepo(mock.url))
    fs.writeFileSync(path.join(repo, "check.js"), CHECK)
    fs.writeFileSync(
      path.join(repo, "horde.json"),
      JSON.stringify({ verify: { checks: { test: "node check.js" } }, tiers: ["cursor/fake"], opencode: { maxRunning: 2 } }),
    )
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "checks")
    // The worker environment keeps XDG_* (the fake's state lives there); HORDE_* is dropped by design.
    cursorState = path.join(tmp, "xdg-state", "horde-cursor-fake")
    // The runtime spawns the configured binary directly; a wrapper runs the fake with node.
    const bin = path.join(tmp, "cursor-agent")
    fs.writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeScript)} "$@"\n`, { mode: 0o755 })
    fs.chmodSync(bin, 0o755)
    boardState = () => path.join(tmp, "board-state")
    h = await connect({ ...isolatedEnv(tmp, repo), HORDE_CURSOR_BIN: bin })
    idOf = (text: string) => text.match(/\bt-[0-9a-f]+\b/)![0]
    calls = () => {
      try {
        return fs
          .readFileSync(path.join(cursorState, "calls.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .flatMap((line) => {
            try {
              return [JSON.parse(line) as Record<string, unknown>]
            } catch {
              return []
            }
          })
      } catch {
        return []
      }
    }
    alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    settle = async (id: string) => {
      for (;;) {
        const out = await h.call("horde_wait", { ids: [id], timeout_seconds: 120 })
        if (!/ NEEDS YOU /.test(out)) return out
        await h.call("horde_tell", { id, approve: true })
      }
    }
  })

  after(async () => {
    try {
      await h.call("opencode_server", { action: "stop" })
    } catch {
      // The server is already gone; nothing to stop.
    }
    await h.close()
    mock.close()
  })

  test("horde_do runs on cursor-agent, horde_wait shows the work, horde_land lands it", async () => {
    // Reading OpenCode's catalog first must not hide the cursor tier's model.
    await h.call("opencode_models", {})
    const started = await h.call("horde_do", {
      goal: "Write the greeting file.\nWRITE: hello.txt=ok\nRUN: git add hello.txt && git commit -qm hello",
      done: ["hello.txt says ok"],
      scope: ["hello.txt"],
    })
    assert.match(started, /^t-\w+ working: "Write the greeting file"/)
    assert.match(started, /cursor\/fake \(tier 0 of 1\)/)
    const id = idOf(started)
    const ready = await settle(id)
    assert.match(ready, new RegExp(`^${id} READY · "Write the greeting file"`), ready)
    assert.match(ready, /checks ✓ test/)
    assert.match(ready, /review: 1 of 1 criteria met \(by cursor\/fake/, ready)
    assert.match(ready, /changed 1 file\(s\) \(\+1 −0\): hello\.txt/)
    // Status carries the step count and the result's tokens.
    const status = await h.call("opencode_status", { ids: [id] })
    assert.match(status, /1 steps · \$\d.* · \d+\.?\d*k? tok/, status)

    // The transcript carries the shell tool's command and output as OpenCode-shaped parts.
    const transcript = await h.call("opencode_output", { id, scope: "all" })
    assert.match(transcript, /\[bash ✓\] git add hello\.txt && git commit -qm hello/, transcript)
    assert.match(transcript, /\[edit ✓\] hello\.txt/, transcript)

    // The first turn starts a chat; the gate's review is a separate read-only ask.
    const log = calls()
    const first = log.find((c) => typeof c.prompt === "string" && c.prompt.includes("Write the greeting file"))
    assert.ok(first, "the worker's first turn reached the fake CLI")
    assert.equal(first.resume, null)
    assert.equal(first.model, "fake")
    const argv = first.argv as string[]
    assert.equal(argv[argv.indexOf("--output-format") + 1], "stream-json")
    assert.ok(argv.includes("--force"))
    assert.equal(argv[argv.indexOf("--sandbox") + 1], "enabled")
    assert.equal(argv[argv.indexOf("--workspace") + 1], first.workspace)
    const addDirs = first.addDirs as string[]
    assert.ok(
      addDirs.some((dir) => dir.endsWith(".git")),
      `the first turn grants the git common directory: ${addDirs.join(", ")}`,
    )
    assert.ok(
      addDirs.some((dir) => dir.startsWith(boardState())),
      `the first turn grants the board state directory: ${addDirs.join(", ")}`,
    )
    assert.ok(
      log.some((c) => c.mode === "ask" && typeof c.prompt === "string" && c.prompt.includes("# Acceptance criteria")),
      "the review ran in ask mode",
    )

    const landed = await h.call("horde_land", { id })
    assert.match(landed, /^landed t-\w+ on master: 1 commit\(s\)/)
    assert.equal(fs.readFileSync(path.join(repo, "hello.txt"), "utf8").trim(), "ok")
    assert.equal((await Board.open(repo, boardState())).task(id).status, "done")
  })

  test("horde_tell continues the same Cursor chat with --resume", async () => {
    const id = idOf(
      await h.call("horde_do", {
        goal: "Write the first file.\nWRITE: first.txt=ok\nRUN: git add first.txt && git commit -qm first",
        done: ["first.txt says ok"],
        scope: ["first.txt", "second.txt"],
      }),
    )
    assert.match(await settle(id), new RegExp(`^${id} READY`))
    const first = calls().find((c) => typeof c.prompt === "string" && c.prompt.includes("Write the first file"))
    assert.ok(first)
    const cursorID = first.session
    assert.equal(typeof cursorID, "string")

    await h.call("horde_tell", {
      id,
      message: "Now write the second file.\nWRITE: second.txt=ok\nRUN: git add second.txt && git commit -qm second",
    })
    const ready = await settle(id)
    assert.match(ready, new RegExp(`^${id} READY`), ready)
    assert.match(ready, /changed 2 file\(s\)/, ready)
    const second = calls().find((c) => typeof c.prompt === "string" && c.prompt.includes("Now write the second file"))
    assert.ok(second, "the follow-up turn reached the fake CLI")
    assert.equal(second.resume, cursorID)
    assert.equal(second.session, cursorID)
    const resumedDirs = second.addDirs as string[]
    assert.ok(
      resumedDirs.some((dir) => dir.endsWith(".git")),
      `the resumed turn grants the git common directory: ${resumedDirs.join(", ")}`,
    )
    assert.ok(
      resumedDirs.some((dir) => dir.startsWith(boardState())),
      `the resumed turn grants the board state directory: ${resumedDirs.join(", ")}`,
    )

    assert.match(await h.call("horde_land", { id }), /^landed t-\w+ on master: 2 commit\(s\)/)
    assert.equal(fs.readFileSync(path.join(repo, "second.txt"), "utf8").trim(), "ok")
  })

  test("horde_drop kills a running cursor-agent process", async () => {
    const id = idOf(
      await h.call("horde_do", {
        goal: "Take your time.\nSLOW",
        done: ["it waited"],
        scope: ["slow.txt"],
      }),
    )
    const call = await until(() => Promise.resolve(calls().find((c) => typeof c.prompt === "string" && c.prompt.includes("Take your time"))), 20_000, 100)
    const pid = call?.pid
    assert.equal(typeof pid, "number")
    assert.ok(alive(pid as number), "the fake CLI is running")
    const dropped = await h.call("horde_drop", { id, reason: "not needed" })
    assert.match(dropped, new RegExp(`^dropped ${id}:`), dropped)
    await until(() => Promise.resolve(!alive(pid as number)), 10_000, 100)
    assert.equal(alive(pid as number), false, "the runtime killed the process group")
    await assert.rejects(h.call("horde_wait", { ids: [id] }), /unknown agent|no longer tracked|disposed/)
  })

  test("a failed cursor turn shows as an error", async () => {
    const id = idOf(
      await h.call("horde_do", {
        goal: "This turn fails.\nFAIL",
        done: ["it does not fail"],
        scope: ["failed.txt"],
      }),
    )
    const failed = await settle(id)
    assert.match(failed, new RegExp(`^${id} FAILED`), failed)
    assert.match(failed, /failed on purpose/)
    await h.call("horde_drop", { id })
  })

  test("review_task asks cursor-agent in ask mode", async () => {
    const id = idOf(
      await h.call("horde_do", {
        goal: "Write the reviewed file.\nWRITE: review.txt=ok\nRUN: git add review.txt && git commit -qm review",
        done: ["review.txt says ok"],
        scope: ["review.txt"],
      }),
    )
    assert.match(await settle(id), new RegExp(`^${id} READY`))
    const before = calls().length
    const review = await h.call("review_task", { id })
    assert.match(review, /1\/1 met/, review)
    assert.ok(
      calls()
        .slice(before)
        .some((c) => c.mode === "ask" && typeof c.prompt === "string" && c.prompt.includes("# Acceptance criteria")),
      "review_task ran in ask mode",
    )
    await h.call("horde_drop", { id })
  })
})
