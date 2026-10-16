import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { startMockLlm } from "./mock-llm.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = path.resolve(here, "..")
const opencodeBin = path.resolve(pkg, "../../node_modules/.bin/opencode")

let client: Client
let mock: Awaited<ReturnType<typeof startMockLlm>>
let repo: string

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = (await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as {
    content: { type: string; text: string }[]
    isError?: boolean
  }
  const text = res.content.map((c) => c.text).join("\n")
  if (process.env.SHOW_OUTPUT) console.error(`\n>>> ${name} ${JSON.stringify(args)}\n${text}`)
  if (res.isError) throw new Error(text)
  return text
}

const idOf = (text: string) => text.match(/ses_[A-Za-z0-9]+/)![0]

describe("opencode MCP server (real opencode, mock LLM)", { timeout: 300_000 }, () => {
  before(async () => {
    mock = await startMockLlm()
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "horde-oc-"))
    repo = path.join(tmp, "repo")
    fs.mkdirSync(repo)
    fs.writeFileSync(
      path.join(repo, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        provider: {
          mock: {
            npm: "@ai-sdk/openai-compatible",
            name: "Mock",
            options: { baseURL: mock.url, apiKey: "x" },
            models: { mock: { name: "Mock", tool_call: true } },
          },
        },
        model: "mock/mock",
        permission: { bash: "ask" },
      }),
    )
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo })
    git("init", "-q")
    git("add", ".")
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init")

    client = new Client({ name: "test", version: "0" })
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", path.join(pkg, "src/index.ts")],
        cwd: pkg,
        env: {
          ...(process.env as Record<string, string>),
          HORDE_OPENCODE_BIN: opencodeBin,
          HORDE_OPENCODE_DIRECTORY: repo,
          XDG_DATA_HOME: path.join(tmp, "data"),
          XDG_STATE_HOME: path.join(tmp, "state"),
          XDG_CACHE_HOME: path.join(tmp, "cache"),
        },
        stderr: "inherit",
      }),
    )
  })

  after(async () => {
    await client?.close()
    mock?.close()
  })

  test("lists tools, models and agents", async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name)
    for (const t of ["opencode_spawn", "opencode_wait", "opencode_message", "opencode_interrupt", "opencode_resume", "opencode_respond"]) {
      assert.ok(tools.includes(t), t)
    }
    assert.match(await call("opencode_models", { provider: "mock" }), /mock\/mock/)
    assert.match(await call("opencode_agents"), /build/)
  })

  test("rejects unknown models with a helpful error", async () => {
    await assert.rejects(call("opencode_spawn", { prompt: "x", model: "mock/nope" }), /Unknown model "mock\/nope"/)
  })

  test("spawn and wait returns the final answer", async () => {
    const out = await call("opencode_spawn", { prompt: "hello there", name: "greeter", model: "mock/mock", wait: true, timeout_seconds: 60 })
    assert.match(out, /greeter \(ses_/)
    assert.match(out, /IDLE/)
    assert.match(out, /Echo: hello there/)
    // Follow-up conversation keeps context and is addressable by name.
    const again = await call("opencode_message", { id: "greeter", message: "second", wait: true, timeout_seconds: 60 })
    assert.match(again, /Echo: second/)
    const full = await call("opencode_output", { id: "greeter", scope: "all" })
    assert.match(full, /hello there[\s\S]*second/)
  })

  test("parallel agents, wait any then all", async () => {
    const fast = idOf(await call("opencode_spawn", { prompt: "quick one", name: "fast" }))
    const slow = idOf(await call("opencode_spawn", { prompt: "SLOW task", name: "slow" }))
    const first = await call("opencode_wait", { ids: [fast, slow], mode: "any", timeout_seconds: 60 })
    assert.match(first, /1 settled, 1 still running/)
    assert.match(first, /fast[\s\S]*Echo: quick one/)
    assert.match(first, /slow \(ses_\w+\) — RUNNING/)

    // Wait until it is visibly mid-turn, then steer, pause and resume it.
    for (let i = 0; i < 50 && !/doing: writing/.test(await call("opencode_status", { ids: [slow] })); i++) {
      await new Promise((r) => setTimeout(r, 200))
    }
    assert.match(await call("opencode_status", { ids: [slow] }), /doing: writing/)
    await call("opencode_message", { id: "slow", message: "please also say hi" })
    const paused = await call("opencode_interrupt", { id: "slow" })
    assert.match(paused, /INTERRUPTED/)
    const resumed = await call("opencode_resume", { id: "slow", message: "finish up", wait: true, timeout_seconds: 60 })
    assert.match(resumed, /IDLE/)
    assert.match(resumed, /Echo: finish up/)
    // A steer that was not picked up before the interrupt is delivered on resume.
    const transcript = await call("opencode_output", { id: "slow", scope: "all", detail: "full" })
    assert.match(transcript, /SLOW task[\s\S]*interrupted[\s\S]*please also say hi[\s\S]*finish up/)
  })

  test("permission requests surface as needs_input and can be answered", async () => {
    const id = idOf(await call("opencode_spawn", { prompt: "TOOL: echo approved > approved.txt", name: "asker" }))
    const blocked = await call("opencode_wait", { ids: [id], timeout_seconds: 60 })
    assert.match(blocked, /NEEDS_INPUT/)
    const req = blocked.match(/needs permission (per_\w+): bash/)![1]!
    await call("opencode_respond", { id, request_id: req, decision: "once" })
    const done = await call("opencode_wait", { ids: [id], timeout_seconds: 60 })
    assert.match(done, /IDLE/)
    assert.match(done, /DONE/)
    assert.equal(fs.readFileSync(path.join(repo, "approved.txt"), "utf8").trim(), "approved")
  })

  test("permission policy deny rejects automatically", async () => {
    const out = await call("opencode_spawn", { prompt: "TOOL: echo nope > denied.txt", permissions: "deny", wait: true, timeout_seconds: 60 })
    assert.doesNotMatch(out, /NEEDS_INPUT/)
    assert.equal(fs.existsSync(path.join(repo, "denied.txt")), false)
  })

  test("worktree isolation keeps the main checkout clean", async () => {
    const out = await call("opencode_spawn", {
      prompt: "TOOL: echo isolated > isolated.txt",
      name: "iso",
      isolation: "worktree",
      permissions: "allow",
      wait: true,
      timeout_seconds: 60,
    })
    assert.match(out, /worktree branch: horde\/iso/)
    const dir = out.match(/dir: (.+)/)![1]!.trim()
    assert.notEqual(dir, repo)
    assert.equal(fs.readFileSync(path.join(dir, "isolated.txt"), "utf8").trim(), "isolated")
    assert.equal(fs.existsSync(path.join(repo, "isolated.txt")), false)
    const disposed = await call("opencode_dispose", { id: "iso", remove_worktree: true, force: true })
    assert.match(disposed, /removed worktree/)
    assert.equal(fs.existsSync(dir), false)
  })

  test("status lists tracked agents", async () => {
    const out = await call("opencode_status")
    assert.match(out, /greeter/)
    assert.match(out, /slow/)
    assert.doesNotMatch(out, /\biso\b \(/)
  })
})
