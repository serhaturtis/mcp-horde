#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { Board } from "@mcp-horde/board"
import { loadSyntax } from "@mcp-horde/context"
import { packageVersion, readJson, recordLifecycle } from "@mcp-horde/core"
import { McpServer } from "@modelcontextprotocol/server"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { Backend, sharedServerAlive, stopServer } from "./backend.js"
import { type Config, inProject, loadConfig } from "./config.js"
import { Fleet } from "./fleet.js"
import { makeHooks } from "./hooks.js"
import { News } from "./news.js"
import { type AgentRecord, ownerAlive, SELF, Store } from "./state.js"
import { INSTRUCTIONS, registerTools } from "./tools.js"
import { repoRoot, sweepWorktrees } from "./worktree.js"

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

// A hook reads this session's news file; a server that died without cleaning up left one behind.
const news = loaded ? new News(loaded.config.stateDir) : undefined
await news?.clear()

// Every stored record, including ones syncStore/fleet hide because their worktree vanished.
function storedAgents(store: Store): AgentRecord[] {
  const dir = path.join(store.dir, "agents")
  const records: AgentRecord[] = []
  for (const file of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!file.endsWith(".json")) continue
    const record = readJson<AgentRecord>(path.join(dir, file))
    if (record?.id) records.push(record)
  }
  return records
}

/** Clean leftovers in the worktree root and settle agents whose worktree is gone. */
async function sweepStartup(): Promise<void> {
  if (!loaded) return
  const { config, store } = loaded
  const swept = await sweepWorktrees(config.worktreeDir, storedAgents(store), (line) => process.stderr.write(`[mcp-horde/opencode] ${line}\n`))
  for (const gone of swept.gone) {
    const record = store.get(gone.id)
    if (!record) continue
    if (record.task) {
      const board = await Board.open(record.worktree?.repo ?? record.directory).catch(() => undefined)
      await board?.fail(record.task.id, { reason: `the agent could not continue: ${gone.error}`, retry: false }).catch(() => undefined)
    }
    store.remove(gone.id)
  }
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
/** The last close of a fleet and backend: a new fleet must not be born before it finishes. */
let cleanup: Promise<unknown> = Promise.resolve()

/**
 * Drop the current fleet and backend. A restart (reconnect) keeps the news file, whose outcomes
 * still wait for a report, and marks the turns in flight as taken by the dead backend; when this
 * process still has agents, the fleet is rebuilt at once so the next call finds them settled
 * instead of paying for the restart (LIVE-02). An exit removes the news file.
 */
function reset(reconnect = false) {
  const f = fleet
  const b = backend
  fleet = undefined
  backend = undefined
  let retained = false
  if (reconnect) {
    try {
      const { config, store } = load()
      // Before close() hands them over: records of this process carry its token. Attached servers
      // key their records by URL; managed ones by "local".
      retained = store.agents(config.url ?? "local").some((r) => r.owner?.token === SELF.token)
    } catch {
      retained = false
    }
  }
  cleanup = Promise.allSettled([f?.then((x) => x.close({ keepNews: reconnect, goneAt: reconnect ? Date.now() : undefined })), b?.then((x) => x.close())])
  if (retained) void cleanup.then(() => getFleet()).catch(() => undefined)
}

const getBackend = async (): Promise<Backend> => {
  if (backend) {
    const current = await backend.catch(() => undefined)
    if (current && !current.dead) return current
    reset(true)
  }
  const { config, store } = load()
  const started = Backend.start(config, store)
  backend = started
  started.then(
    (b) => b.events.once("dead", () => backend === started && reset(true)),
    () => {
      if (backend === started) backend = undefined
    },
  )
  return started
}

const getFleet = async (): Promise<Fleet> => {
  if (fleet) return fleet
  // A fleet being closed still owns its records: wait, so it cannot clear them under the new one.
  await cleanup
  const b = await getBackend()
  if (!fleet) {
    const { config, store } = load()
    // If the first load failed, this one may succeed: clear the stale file before any write.
    const newsFile = news ?? new News(config.stateDir)
    if (!news) await newsFile.clear()
    fleet = Promise.resolve(new Fleet(b, config, store, makeHooks(server, config), newsFile))
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
    if (!config.url) reset(false)
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
void sweepStartup().catch((err) =>
  process.stderr.write(`[mcp-horde/opencode] could not sweep the worktree root: ${err instanceof Error ? err.message : String(err)}\n`),
)

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
