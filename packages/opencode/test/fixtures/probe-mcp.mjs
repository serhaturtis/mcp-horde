// A one-tool stdio MCP server for the canary test: does OpenCode offer injected MCP tools to agents?
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const server = new McpServer({ name: "probe", version: "0" })
server.registerTool("echo", { description: "Echo the text back", inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: "text", text: `echo:${text}` }],
}))
await server.connect(new StdioServerTransport())
