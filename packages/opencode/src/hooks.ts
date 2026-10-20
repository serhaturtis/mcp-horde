import { truncate } from "@mcp-horde/core"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { FormInfo, PermissionRequest } from "@opencode/client"
import type { Config } from "./config.js"
import type { FormAnswer, Hooks, Snapshot } from "./fleet.js"
import { renderSnapshot } from "./tools.js"

type Schema = Record<string, unknown>

/** The dialog schema for an OpenCode form (the question tool's questions); exported for tests. */
export function questionSchema(req: FormInfo): { properties: Record<string, Schema>; required: string[] } {
  const properties: Record<string, Schema> = {}
  const required: string[] = []
  req.fields.forEach((f, i) => {
    const title = f.description ?? f.title ?? f.key
    if (f.type === "boolean") {
      properties[`q${i}`] = { type: "boolean", title }
      if (f.required) required.push(`q${i}`)
      return
    }
    if (f.type === "number" || f.type === "integer") {
      properties[`q${i}`] = { type: f.type, title }
      if (f.required) required.push(`q${i}`)
      return
    }
    if (f.type === "external") {
      properties[`q${i}_text`] = { type: "string", title: `${title} (${f.url})` }
      return
    }
    const options = (f.options ?? []).map((o) => ({ const: o.value, title: o.description ? `${o.label} — ${o.description}` : o.label }))
    const custom = f.custom !== false
    if (options.length && f.type === "multiselect") {
      properties[`q${i}`] = { type: "array", title, items: { anyOf: options } }
    } else if (options.length) {
      properties[`q${i}`] = { type: "string", title, oneOf: options }
      if (!custom) required.push(`q${i}`)
    }
    if (custom || !options.length) {
      properties[`q${i}_text`] = { type: "string", title: options.length ? `${title} — or your own answer` : title }
      if (!options.length) required.push(`q${i}_text`)
    }
  })
  return { properties, required }
}

/** Turn dialog content back into a form reply (per field key: the chosen value(s), or the text). */
export function questionAnswers(req: FormInfo, content: Record<string, unknown> | undefined): FormAnswer {
  const out: FormAnswer = {}
  req.fields.forEach((f, i) => {
    const text = content?.[`q${i}_text`]
    const choice = content?.[`q${i}`]
    if (typeof text === "string" && text.trim()) out[f.key] = f.type === "multiselect" ? [text.trim()] : text.trim()
    else if (Array.isArray(choice)) out[f.key] = choice.filter((c): c is string => typeof c === "string")
    else if (typeof choice === "string" || typeof choice === "number" || typeof choice === "boolean") out[f.key] = choice
  })
  return out
}

/** The permission dialog text: what is asked, on what, and what "always" would save. */
export function permissionMessage(agent: string, directory: string, req: PermissionRequest): string {
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

    async askPermission(snap: Snapshot, req: PermissionRequest, signal: AbortSignal) {
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

    async askQuestion(snap: Snapshot, req: FormInfo, signal: AbortSignal) {
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
