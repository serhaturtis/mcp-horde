import { truncate } from "@mcp-horde/core"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { PermissionV2Request, QuestionV2Request } from "@opencode-ai/sdk/v2"
import type { Config } from "./config.js"
import type { Hooks, Snapshot } from "./fleet.js"
import { renderSnapshot } from "./tools.js"

type Schema = Record<string, unknown>

/** The dialog schema for a question request; exported for tests. */
export function questionSchema(req: QuestionV2Request): { properties: Record<string, Schema>; required: string[] } {
  const properties: Record<string, Schema> = {}
  const required: string[] = []
  req.questions.forEach((q, i) => {
    const options = q.options.map((o) => ({ const: o.label, title: o.description ? `${o.label} — ${o.description}` : o.label }))
    const custom = q.custom !== false
    if (options.length && q.multiple) {
      properties[`q${i}`] = { type: "array", title: q.question, items: { anyOf: options } }
    } else if (options.length) {
      properties[`q${i}`] = { type: "string", title: q.question, oneOf: options }
      if (!custom) required.push(`q${i}`)
    }
    if (custom || !options.length) {
      properties[`q${i}_text`] = { type: "string", title: options.length ? `${q.question} — or your own answer` : q.question }
      if (!options.length) required.push(`q${i}_text`)
    }
  })
  return { properties, required }
}

/** Turn dialog content back into OpenCode answers (one list of labels/text per question). */
export function questionAnswers(req: QuestionV2Request, content: Record<string, unknown> | undefined): string[][] {
  return req.questions.map((_, i) => {
    const text = content?.[`q${i}_text`]
    if (typeof text === "string" && text.trim()) return [text.trim()]
    const choice = content?.[`q${i}`]
    if (Array.isArray(choice)) return choice.filter((c): c is string => typeof c === "string")
    return typeof choice === "string" ? [choice] : []
  })
}

/** The permission dialog text: what is asked, on what, and what "always" would save. */
export function permissionMessage(agent: string, directory: string, req: PermissionV2Request): string {
  const lines = [`OpenCode agent "${agent}" wants permission: ${req.action}`, truncate(req.resources.join("\n"), 1500)]
  if (req.save?.length) lines.push(`"Always" saves: ${truncate(req.save.join(", "), 500)} (for every later session of this project)`)
  lines.push(`(in ${directory})`)
  return lines.join("\n")
}

/** Bridges fleet events to the MCP client: elicitation dialogs and channel pushes. */
export function makeHooks(server: McpServer, config: Config): Hooks {
  const label = (s: Snapshot) => s.name ?? s.id
  return {
    // Only form dialogs can carry these requests. Per the MCP spec an empty
    // `elicitation: {}` means form support; a URL-only client cannot show them.
    canElicit: () => {
      const caps = server.server.getClientCapabilities()?.elicitation
      if (!caps) return false
      return caps.form !== undefined || caps.url === undefined
    },

    async askPermission(snap: Snapshot, req: PermissionV2Request, signal: AbortSignal) {
      const res = await server.server.elicitInput(
        {
          message: permissionMessage(label(snap), snap.directory, req),
          requestedSchema: {
            type: "object",
            properties: {
              decision: {
                type: "string",
                title: "Allow?",
                oneOf: [
                  { const: "once", title: "Allow once" },
                  { const: "always", title: req.save?.length ? `Always allow ${truncate(req.save.join(", "), 200)}` : "Always allow this pattern" },
                  { const: "reject", title: "Reject" },
                ],
              },
              message: { type: "string", title: "Note to the agent (optional, used when rejecting)" },
            },
            required: ["decision"],
          },
        },
        { signal, timeout: config.elicitTimeoutMs },
      )
      if (res.action === "accept") {
        const decision = res.content?.decision
        // Approve only on an explicit choice; anything else goes to the calling model.
        if (decision !== "once" && decision !== "always" && decision !== "reject") return undefined
        const reply = decision
        const message = typeof res.content?.message === "string" && res.content.message ? res.content.message : undefined
        return { reply, message }
      }
      if (res.action === "decline") return { reply: "reject" as const, message: "The user declined this action." }
      return undefined // dismissed: leave it for the orchestrating model
    },

    async askQuestion(snap: Snapshot, req: QuestionV2Request, signal: AbortSignal) {
      const { properties, required } = questionSchema(req)
      const res = await server.server.elicitInput(
        {
          message: `OpenCode agent "${label(snap)}" asks:`,
          requestedSchema: { type: "object", properties: properties as never, ...(required.length ? { required } : {}) },
        },
        { signal, timeout: config.elicitTimeoutMs },
      )
      if (res.action === "decline") return "dismiss" as const
      if (res.action !== "accept") return undefined
      return questionAnswers(req, res.content as Record<string, unknown> | undefined)
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
