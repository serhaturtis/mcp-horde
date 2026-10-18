#!/usr/bin/env node
import { packageVersion } from "@mcp-horde/core"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { Backend, stopServer } from "./backend.js"
import { loadConfig } from "./config.js"
import { Fleet } from "./fleet.js"
import { makeHooks } from "./hooks.js"
import { Store } from "./state.js"
import { INSTRUCTIONS, registerTools } from "./tools.js"

const VERSION = packageVersion(import.meta.url)

// A bug in a background task must not take the whole MCP server down.
process.on("unhandledRejection", (err) => {
  process.stderr.write(`[mcp-horde/opencode] unhandled rejection: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
})

const config = loadConfig()
const store = new Store(config.stateDir)
const server = new McpServer(
  { name: "opencode", version: VERSION },
  {
    instructions: INSTRUCTIONS,
    // Claude Code "channels" (research preview): lets us push a message into the
    // session when an agent settles. Harmless for clients that ignore it.
    capabilities: config.channel ? { experimental: { "claude/channel": {} } } : {},
  },
)

// OpenCode is started lazily so the MCP handshake stays fast and a missing
// binary surfaces as a tool error instead of a dead server. If the server
// dies or is stopped, the next call starts (or reconnects to) a fresh one.
let backend: Promise<Backend> | undefined
let fleet: Promise<Fleet> | undefined

function reset() {
  const f = fleet
  const b = backend
  fleet = undefined
  backend = undefined
  void f?.then((x) => x.close()).catch(() => undefined)
  void b?.then((x) => x.close()).catch(() => undefined)
}

const getBackend = async (): Promise<Backend> => {
  if (backend) {
    const current = await backend.catch(() => undefined)
    if (current && !current.dead) return current
    reset()
  }
  const started = Backend.start(config, store)
  backend = started
  started.then(
    (b) => b.events.once("dead", () => backend === started && reset()),
    () => {
      if (backend === started) backend = undefined
    },
  )
  return started
}

const getFleet = async (): Promise<Fleet> => {
  const b = await getBackend()
  if (!fleet) {
    fleet = Promise.resolve(new Fleet(b, config, store, makeHooks(server, config)))
  }
  return fleet
}

registerTools(server, {
  fleet: getFleet,
  backend: getBackend,
  peekFleet: () => fleet,
  clientName: () => server.server.getClientVersion()?.name,
  stop: async () => {
    const b = await backend?.catch(() => undefined)
    const text = await stopServer(config, store, b)
    if (!config.url) reset()
    return text
  },
})

let closing = false
const shutdown = () => {
  if (closing) return
  closing = true
  void Promise.allSettled([fleet?.then((f) => f.close()), backend?.then((b) => b.close())]).finally(() => process.exit(0))
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
process.stdin.on("close", shutdown)

await server.connect(new StdioServerTransport())

// Reconnect to agents left running by a previous process (shared server) so
// policies, limits and notifications keep working without a tool call. Only
// when that server is still alive: never start one before a tool needs it.
const known = config.url ? undefined : store.server
if (known && config.serverMode === "shared") {
  const auth = `Basic ${Buffer.from(`${config.username}:${known.password}`).toString("base64")}`
  void fetch(`${known.url}/global/health`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(2000) })
    .then((res) => (res.ok ? getFleet() : undefined))
    .catch(() => undefined)
}
