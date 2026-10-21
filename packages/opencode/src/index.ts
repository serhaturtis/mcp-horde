#!/usr/bin/env node
import { loadSyntax } from "@mcp-horde/context"
import { packageVersion, recordLifecycle } from "@mcp-horde/core"
import { McpServer } from "@modelcontextprotocol/server"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { Backend, sharedServerAlive, stopServer } from "./backend.js"
import { type Config, inProject, loadConfig } from "./config.js"
import { Fleet } from "./fleet.js"
import { makeHooks } from "./hooks.js"
import { ownerAlive, Store } from "./state.js"
import { INSTRUCTIONS, registerTools } from "./tools.js"
import { repoRoot } from "./worktree.js"

const VERSION = packageVersion(import.meta.url)
recordLifecycle("opencode", VERSION)

// A bug in a background task must not take the whole MCP server down.
process.on("unhandledRejection", (err) => {
  process.stderr.write(`[mcp-horde/opencode] unhandled rejection: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
})

// A bad environment or horde.json must not kill the server before the handshake: the
// error is returned by every tool call instead, and fixing horde.json takes effect on
// the next call (environment variables need a restart).
let loaded: { config: Config; store: Store } | undefined
const load = (): { config: Config; store: Store } => {
  if (loaded) return loaded
  try {
    const config = loadConfig()
    loaded = { config, store: new Store(config.stateDir) }
    return loaded
  } catch (err) {
    throw new Error(`mcp-horde/opencode is misconfigured: ${err instanceof Error ? err.message : String(err)}`)
  }
}
try {
  load()
} catch (err) {
  process.stderr.write(`[mcp-horde/opencode] ${(err as Error).message}\n`)
}

const server = new McpServer(
  { name: "opencode", version: VERSION },
  {
    instructions: INSTRUCTIONS,
    // Claude Code "channels" (research preview): lets us push a message into the
    // session when an agent settles. Harmless for clients that ignore it.
    capabilities: loaded?.config.channel ? { experimental: { "claude/channel": {} } } : {},
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
  const { config, store } = load()
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
    const { config, store } = load()
    fleet = Promise.resolve(new Fleet(b, config, store, makeHooks(server, config)))
  }
  return fleet
}

registerTools(server, {
  fleet: getFleet,
  backend: getBackend,
  peekFleet: () => fleet,
  peekBackend: () => backend,
  clientName: () => server.server.getClientVersion()?.name,
  stop: async () => {
    const { config, store } = load()
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

// Grammars for code context (briefs, related tests); without them line patterns answer.
await loadSyntax()
await server.connect(new StdioServerTransport())

// Reconnect to agents left running by a previous process (shared server) so
// policies, limits and notifications keep working without a tool call. Only
// when that server is still alive (never start one before a tool needs it), and
// only when an agent of this session's project lost its owner: other projects'
// agents are taken over by their own sessions, or when a call touches them.
void (async () => {
  if (!loaded || loaded.config.url || loaded.config.serverMode !== "shared") return
  const { config, store } = loaded
  const known = store.server
  if (!known) return
  const root = await repoRoot(config.directory).catch(() => config.directory)
  const orphans = store.agents("local").filter((r) => !ownerAlive(r.owner, r.ownerSeen) && inProject(r, root))
  if (!orphans.length) return
  if (await sharedServerAlive(config, known)) await getFleet()
})().catch(() => undefined)
