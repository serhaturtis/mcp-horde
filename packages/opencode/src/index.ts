#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { Backend } from "./backend.js"
import { loadConfig } from "./config.js"
import { Fleet } from "./fleet.js"
import { makeHooks } from "./hooks.js"
import { Store } from "./state.js"
import { INSTRUCTIONS, registerTools } from "./tools.js"

const VERSION = "0.2.0"

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
// binary surfaces as a tool error instead of a dead server.
let backend: Promise<Backend> | undefined
let fleet: Promise<Fleet> | undefined
const getBackend = () => {
  backend ??= Backend.start(config, store).catch((err: unknown) => {
    backend = undefined
    throw err
  })
  return backend
}
const getFleet = () => {
  fleet ??= getBackend().then(
    (b) => new Fleet(b, config, store, makeHooks(server, config)),
    (err: unknown) => {
      fleet = undefined
      throw err
    },
  )
  return fleet
}

registerTools(server, { fleet: getFleet, backend: getBackend, store })

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
