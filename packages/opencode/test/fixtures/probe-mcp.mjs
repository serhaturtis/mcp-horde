// A one-tool stdio MCP server for the canary test: does OpenCode offer injected MCP tools to agents?

import { McpServer } from "@modelcontextprotocol/server"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { z } from "zod"

const server = new McpServer({ name: "probe", version: "0" })
server.registerTool("echo", { description: "Echo the text back", inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
  content: [{ type: "text", text: `echo:${text}` }],
}))
await server.connect(new StdioServerTransport())
