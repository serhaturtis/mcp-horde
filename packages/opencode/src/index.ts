#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { Backend } from "./backend.js"
import { loadConfig } from "./config.js"
import { Fleet } from "./fleet.js"
import { INSTRUCTIONS, registerTools } from "./tools.js"

const config = loadConfig()
const server = new McpServer({ name: "mcp-horde-opencode", version: "0.1.0" }, { instructions: INSTRUCTIONS })

// OpenCode is started lazily so the MCP handshake stays fast and a missing
// binary surfaces as a tool error instead of a dead server.
let backend: Backend | undefined
let fleet: Promise<Fleet> | undefined
const getFleet = () => {
  fleet ??= Backend.start(config).then(
    (b) => {
      backend = b
      return new Fleet(b, config)
    },
    (err: unknown) => {
      fleet = undefined
      throw err
    },
  )
  return fleet
}

registerTools(server, getFleet)

const shutdown = () => {
  backend?.close()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
process.stdin.on("close", shutdown)

await server.connect(new StdioServerTransport())
