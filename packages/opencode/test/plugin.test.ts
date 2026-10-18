/**
 * The Claude Code plugin's servers, as the plugin starts them: the self-contained bundles
 * in plugins/horde/servers (`npm run bundle`), run with plain node from a clone.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { connect, git, type Harness, isolatedEnv, type Mock, makeRepo, opencodeBin } from "./harness.js"
import { startMockLlm } from "./mock-llm.js"

const servers = path.join(import.meta.dirname, "..", "..", "..", "plugins", "horde", "servers")
const pluginVersion = JSON.parse(fs.readFileSync(path.join(servers, "..", ".claude-plugin", "plugin.json"), "utf8")).version as string

let mock: Mock
let h: Harness
let tmp: string
let repo: string
const clients: Client[] = []

async function server(name: string, env: Record<string, string>) {
  const client = new Client({ name: "test", version: "0" })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(servers, `${name}.js`)],
      cwd: repo,
      env: { ...(process.env as Record<string, string>), ...env },
      stderr: "inherit",
    }),
  )
  clients.push(client)
  return async (tool: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name: tool, arguments: args })) as { content: { text: string }[]; isError?: boolean }
    const text = res.content.map((c) => c.text).join("\n")
    if (res.isError) throw new Error(text)
    return text
  }
}

describe("plugin bundles", { timeout: 300_000 }, () => {
  before(async () => {
    assert.ok(fs.existsSync(path.join(servers, "opencode.js")), "run `npm run bundle` first")
    mock = await startMockLlm()
    ;({ tmp, repo } = makeRepo(mock.url))
    fs.writeFileSync(path.join(repo, "util.js"), "exports.add = (a, b) => a + b\n")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "util")
    h = await connect(
      { ...isolatedEnv(tmp, repo), HORDE_OPENCODE_SERVER: "private", HORDE_BOARD_STATE_DIR: path.join(tmp, "board"), HORDE_OPENCODE_BIN: opencodeBin },
      { entry: path.join(servers, "opencode.js") },
    )
  })

  after(async () => {
    for (const c of clients) await c.close().catch(() => undefined)
    await h?.call("opencode_server", { action: "stop" }).catch(() => undefined)
    await h?.close()
    mock?.close()
  })

  test("board and opencode work a task end to end; the worker reports through the bundled CLI without prompting", async () => {
    assert.equal(h.client.getServerVersion()?.version, pluginVersion)
    const board = await server("board", { HORDE_BOARD_DIRECTORY: repo, HORDE_BOARD_STATE_DIR: path.join(tmp, "board") })
    const planned = await board("board_plan", { tasks: [{ title: "Fix util", goal: "Make `add` handle strings.", scope: ["util.js"] }] })
    const id = planned.match(/^(t-\w+) "Fix util"/m)![1]!
    // "ask": anything untrusted would stop at needs_input; the report command must not.
    const out = await h.call("opencode_spawn", { task: id, name: "bundled", permissions: "ask", wait: true, timeout_seconds: 120 })
    assert.match(out, /bundled .*— IDLE/, out)
    assert.doesNotMatch(out, /needs permission/)
    assert.match(await board("board_task", { id }), /report \(attempt 1, confidence high\): mock work done/)
    await h.call("opencode_dispose", { id: "bundled", worktree: "discard" })
  })

  test("verify and context answer from their bundles", async () => {
    const verify = await server("verify", { HORDE_VERIFY_DIRECTORY: repo, HORDE_VERIFY_STATE_DIR: path.join(tmp, "verify") })
    assert.match(await verify("verify_detect"), /no checks|check/i)
    const context = await server("context", { HORDE_CONTEXT_DIRECTORY: repo })
    assert.match(await context("context_find", { query: "add", kind: "definition" }), /^util\.js:1 {2}/)
    // The bundle finds its grammars next to it.
    assert.match(await context("context_map"), /Definitions from: tree-sitter$/m)
  })
})
