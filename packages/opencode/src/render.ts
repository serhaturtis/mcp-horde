import { indent, oneLine, truncate } from "@mcp-horde/core"
import type { SessionMessage, SessionMessageAssistant, SessionMessageAssistantTool } from "@opencode-ai/sdk/v2"

export type Detail = "final" | "summary" | "full"

const INPUT_KEYS = ["command", "filePath", "path", "pattern", "url", "query", "description", "prompt", "name"]

export function inputSummary(input: unknown): string {
  if (typeof input === "string") return truncate(oneLine(input), 160)
  if (input && typeof input === "object") {
    const rec = input as Record<string, unknown>
    for (const key of INPUT_KEYS) {
      const value = rec[key]
      if (typeof value === "string" && value) return truncate(oneLine(value), 160)
    }
  }
  return truncate(JSON.stringify(input), 160)
}

function toolOutput(tool: SessionMessageAssistantTool): string {
  const state = tool.state
  if (state.status === "pending") return ""
  const text = state.content.map((c) => (c.type === "text" ? c.text : `[file ${c.name ?? c.uri}]`)).join("\n")
  if (state.status === "error") return [state.error.message, text].filter(Boolean).join("\n")
  return text
}

const STATUS_MARK: Record<string, string> = { pending: "…", running: "…", completed: "✓", error: "✗" }

export function renderTool(tool: SessionMessageAssistantTool, withOutput: boolean): string {
  const head = `[${tool.name} ${STATUS_MARK[tool.state.status] ?? tool.state.status}] ${inputSummary(tool.state.input)}`
  if (!withOutput) {
    return tool.state.status === "error" ? `${head} — ${truncate(oneLine(tool.state.error.message), 200)}` : head
  }
  const out = toolOutput(tool)
  return out ? `${head}\n${indent(truncate(out, 2000))}` : head
}

export function assistantText(msg: SessionMessageAssistant): string {
  return msg.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim()
}

/** Render a list of messages (chronological) at the requested level of detail. */
export function renderTranscript(messages: SessionMessage[], detail: Detail): string {
  if (detail === "final") {
    const last = [...messages].reverse().find((m): m is SessionMessageAssistant => m.type === "assistant" && !!assistantText(m))
    return last ? assistantText(last) : "(no assistant text yet)"
  }
  const out: string[] = []
  for (const m of messages) {
    switch (m.type) {
      case "user":
        out.push(`## user\n${m.text}${m.files?.length ? `\n[attached: ${m.files.map((f) => f.name ?? f.uri).join(", ")}]` : ""}`)
        break
      case "synthetic":
      case "system":
        if (detail === "full") out.push(`## ${m.type}\n${m.text}`)
        break
      case "shell":
        out.push(`## shell $ ${m.command}${detail === "full" ? `\n${indent(truncate(m.output, 2000))}` : ""}`)
        break
      case "compaction":
        out.push(`## compaction (${m.reason})${detail === "full" ? `\n${m.summary}` : ""}`)
        break
      case "agent-switched":
        out.push(`## switched agent → ${m.agent}`)
        break
      case "model-switched":
        out.push(`## switched model → ${m.model.providerID}/${m.model.id}${m.model.variant ? ` [${m.model.variant}]` : ""}`)
        break
      case "assistant": {
        const lines: string[] = [`## assistant (${m.agent} · ${m.model.providerID}/${m.model.id})`]
        for (const c of m.content) {
          if (c.type === "text") lines.push(c.text.trim())
          else if (c.type === "reasoning") {
            if (detail === "full" && c.text.trim()) lines.push(`<thinking>\n${truncate(c.text.trim(), 2000)}\n</thinking>`)
          } else lines.push(renderTool(c, detail === "full"))
        }
        if (m.error) lines.push(`(error: ${m.error.message})`)
        out.push(lines.filter(Boolean).join("\n"))
        break
      }
    }
  }
  return out.join("\n\n")
}
