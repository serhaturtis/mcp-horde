import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { connect, freePort, idOf, isolatedEnv, killTree, type Mock, makeRepo, opencodeBin, until } from "./harness.js"
import { startMockLlm } from "./mock-llm.js"

let mock: Mock

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("server modes and durability", { timeout: 600_000 }, () => {
  before(async () => {
    mock = await startMockLlm()
  })
  after(() => mock?.close())

  test("shared server: agents, names and policies survive an MCP restart", async () => {
    const { tmp, repo } = makeRepo(mock.url)
    const env = isolatedEnv(tmp, repo)
    const first = await connect(env)
    try {
      await first.call("opencode_spawn", { prompt: "SLOW survive", name: "survivor" })
      await first.call("opencode_spawn", { prompt: "hi", name: "trusted", permissions: "allow", wait: true, timeout_seconds: 60 })
      const pid = Number((await first.call("opencode_server", { action: "info" })).match(/pid (\d+)/)![1])
      await first.close()

      const second = await connect(env)
      try {
        const info = await second.call("opencode_server", { action: "info" })
        assert.match(info, new RegExp(`pid ${pid}`), "the same server is reused")
        const status = await second.call("opencode_status")
        assert.match(status, /survivor \(ses_\w+\) — RUNNING/)
        assert.match(status, /trusted[\s\S]*permissions: allow/)
        const done = await second.call("opencode_wait", { ids: ["survivor"], timeout_seconds: 60 })
        assert.match(done, /survivor[\s\S]*IDLE[\s\S]*Working\.+/)
        // The persisted allow policy still applies after the restart.
        const tool = await second.call("opencode_message", {
          id: "trusted",
          message: `TOOL: echo ok > ${path.join(repo, "after-restart.txt")}`,
          wait: true,
          timeout_seconds: 60,
        })
        assert.match(tool, /IDLE[\s\S]*DONE/)
        assert.ok(fs.existsSync(path.join(repo, "after-restart.txt")))
      } finally {
        await second.call("opencode_server", { action: "stop" }).catch(() => undefined)
        await second.close()
      }
      await until(async () => !alive(pid), 10_000)
    } finally {
      await first.close().catch(() => undefined)
    }
  })

  test("private server dies with the MCP process, even on SIGKILL", async () => {
    const { tmp, repo } = makeRepo(mock.url)
    const h = await connect({ ...isolatedEnv(tmp, repo), HORDE_OPENCODE_SERVER: "private" })
    try {
      const out = await h.call("opencode_spawn", { prompt: "private hello", wait: true, timeout_seconds: 60 })
      assert.match(out, /Echo\[none\]: private hello/)
      const info = await h.call("opencode_server", { action: "info" })
      assert.match(info, /^private server/)
      const url = info.match(/attach (\S+)/)![1]!
      const mcpPid = (h.client.transport as unknown as { pid: number }).pid
      process.kill(mcpPid, "SIGKILL")
      await until(
        async () => {
          const res = await fetch(`${url}/global/health`).catch(() => undefined)
          return res === undefined
        },
        15_000,
        300,
      )
    } finally {
      await h.close().catch(() => undefined)
    }
  })

  test("attach mode: password required, wrong password reported, adoption of outside sessions", async () => {
    const { tmp, repo } = makeRepo(mock.url)
    const password = "s3cret-test"
    const port = await freePort()
    const proc = spawn(opencodeBin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: repo,
      env: { ...process.env, ...isolatedEnv(tmp, repo), OPENCODE_SERVER_PASSWORD: password },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    })
    let output = ""
    proc.stdout?.on("data", (c: Buffer) => (output += c.toString()))
    proc.stderr?.on("data", (c: Buffer) => (output += c.toString()))
    const url = `http://127.0.0.1:${port}`
    try {
      await until(
        async () => (await fetch(`${url}/global/health`, { signal: AbortSignal.timeout(2000) }).catch(() => undefined)) !== undefined,
        90_000,
        300,
      ).catch((err: Error) => {
        throw new Error(`${err.message}; opencode serve output:
${output}`)
      })
      const base = isolatedEnv(tmp, repo)

      const wrong = await connect({ ...base, HORDE_OPENCODE_URL: url, OPENCODE_SERVER_PASSWORD: "nope" })
      try {
        await assert.rejects(wrong.call("opencode_models"), /unauthorized \(wrong OPENCODE_SERVER_PASSWORD/)
      } finally {
        await wrong.close()
      }

      const remote = await connect({ ...base, HORDE_OPENCODE_URL: "http://example.invalid:4096" })
      try {
        await assert.rejects(remote.call("opencode_models"), /Refusing to use .* without OPENCODE_SERVER_PASSWORD/)
      } finally {
        await remote.close()
      }

      const h = await connect({ ...base, HORDE_OPENCODE_URL: url, OPENCODE_SERVER_PASSWORD: password })
      try {
        assert.match(await h.call("opencode_server", { action: "info" }), /^attached server/)
        assert.match(await h.call("opencode_spawn", { prompt: "attached hi", wait: true, timeout_seconds: 60 }), /Echo\[none\]: attached hi/)

        // A session created by someone else (e.g. the OpenCode TUI) can be adopted and driven.
        const oc = createOpencodeClient({ baseUrl: url, headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } })
        const outside = (await oc.v2.session.create({ location: { directory: repo } })).data!.data.id
        const listed = await h.call("opencode_status", { include_untracked: true })
        assert.match(listed, new RegExp(outside))
        assert.match(await h.call("opencode_message", { id: outside, message: "adopted", wait: true, timeout_seconds: 60 }), /Echo\[none\]: adopted/)
        // One bad id is reported without failing the whole status call.
        assert.match(await h.call("opencode_status", { ids: ["ses_doesnotexist"] }), /ses_doesnotexist: .*does not exist on this OpenCode server/)
        assert.equal(idOf(listed).startsWith("ses_"), true)
      } finally {
        await h.close()
      }
    } finally {
      killTree(proc.pid)
    }
  })

  // Canary: workers reach the board through bash because v2 runners do not offer MCP tools
  // (OpenCode 1.19). When this starts failing (the dev-tag CI job runs it first), v2 has
  // gained MCP tools and the horde can mount its servers for workers instead.
  test("canary: an injected MCP server connects, but v2 runners do not offer its tools yet", async () => {
    const { tmp, repo } = makeRepo(mock.url)
    const port = await freePort()
    const fixture = path.join(import.meta.dirname, "fixtures", "probe-mcp.mjs")
    const config = { mcp: { horde: { type: "local", command: [process.execPath, fixture] } } }
    const proc = spawn(opencodeBin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: repo,
      env: { ...process.env, ...isolatedEnv(tmp, repo), OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
      stdio: "ignore",
      shell: process.platform === "win32",
    })
    const url = `http://127.0.0.1:${port}`
    try {
      await until(async () => (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) }).catch(() => undefined))?.ok, 90_000, 300)
      const status = await until(async () => {
        const s = (await fetch(`${url}/mcp?directory=${encodeURIComponent(repo)}`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json())) as Record<
          string,
          { status: string }
        >
        return s.horde?.status === "connected" ? s : undefined
      }, 30_000)
      assert.equal(status.horde!.status, "connected")
      const oc = createOpencodeClient({ baseUrl: url })
      const sid = (await oc.v2.session.create({ location: { directory: repo } })).data!.data.id
      await oc.v2.session.prompt({ sessionID: sid, prompt: { text: "TOOLS?" } })
      const tools = await until(async () => {
        const msgs = (await oc.v2.session.messages({ sessionID: sid })).data as { data: { type: string; content?: { type: string; text?: string }[] }[] }
        const text = msgs.data.flatMap((m) => (m.type === "assistant" ? (m.content ?? []) : [])).find((c) => c.type === "text" && c.text?.startsWith("Tools:"))
        return text?.text
      }, 60_000)
      assert.match(tools, /\bbash\b/, "built-in tools are offered")
      assert.doesNotMatch(tools, /horde_echo/, "MCP tools reached the v2 runner: switch workers from the CLI to MCP mounts (docs/DESIGN.md §4.2e)")
    } finally {
      killTree(proc.pid)
    }
  })
})
