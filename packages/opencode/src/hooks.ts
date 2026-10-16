import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { PermissionV2Request, QuestionV2Request } from "@opencode-ai/sdk/v2"
import type { Config } from "./config.js"
import type { Hooks, Snapshot } from "./fleet.js"
import { truncate } from "./render.js"
import { renderSnapshot } from "./tools.js"

/** Bridges fleet events to the MCP client: elicitation dialogs and channel pushes. */
export function makeHooks(server: McpServer, config: Config): Hooks {
  const label = (s: Snapshot) => s.name ?? s.id
  return {
    canElicit: () => !!server.server.getClientCapabilities()?.elicitation,

    async askPermission(snap: Snapshot, req: PermissionV2Request) {
      const res = await server.server.elicitInput({
        message: `OpenCode agent "${label(snap)}" wants permission: ${req.action}\n${truncate(req.resources.join("\n"), 1500)}\n(in ${snap.directory})`,
        requestedSchema: {
          type: "object",
          properties: {
            decision: {
              type: "string",
              title: "Allow?",
              enum: ["once", "always", "reject"],
              enumNames: ["Allow once", "Always allow this pattern", "Reject"],
            },
            message: { type: "string", title: "Note to the agent (optional, used when rejecting)" },
          },
          required: ["decision"],
        },
      })
      if (res.action === "accept") {
        const decision = res.content?.decision
        const reply = decision === "always" || decision === "reject" ? decision : "once"
        const message = typeof res.content?.message === "string" && res.content.message ? res.content.message : undefined
        return { reply, message }
      }
      if (res.action === "decline") return { reply: "reject" as const, message: "The user declined this action." }
      return undefined // dismissed: leave it for the orchestrating model
    },

    async askQuestion(snap: Snapshot, req: QuestionV2Request) {
      const properties: Record<string, object> = {}
      req.questions.forEach((q, i) => {
        const labels = q.options.map((o) => o.label)
        if (labels.length && !q.multiple) {
          properties[`q${i}`] = { type: "string", title: q.question, enum: labels, enumNames: q.options.map((o) => `${o.label} — ${o.description}`) }
        }
        if (q.custom !== false || !labels.length || q.multiple) {
          properties[`q${i}_text`] = {
            type: "string",
            title: labels.length ? `${q.question} — or your own answer${q.multiple ? " (comma-separated options)" : ""}` : q.question,
          }
        }
      })
      const res = await server.server.elicitInput({
        message: `OpenCode agent "${label(snap)}" asks:`,
        requestedSchema: { type: "object", properties: properties as never },
      })
      if (res.action === "decline") return "dismiss" as const
      if (res.action !== "accept") return undefined
      return req.questions.map((q, i) => {
        const text = res.content?.[`q${i}_text`]
        if (typeof text === "string" && text.trim())
          return q.multiple
            ? text
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean)
            : [text.trim()]
        const choice = res.content?.[`q${i}`]
        return typeof choice === "string" ? [choice] : []
      })
    },

    settled(snap: Snapshot) {
      if (!config.channel) return
      void server.server
        .notification({
          method: "notifications/claude/channel",
          params: {
            content: renderSnapshot(snap, { resultChars: 4000, mode: "news" }),
            meta: { agent_id: snap.id, agent_name: snap.name ?? "", state: snap.state },
          },
        })
        .catch(() => undefined)
    },
  }
}
