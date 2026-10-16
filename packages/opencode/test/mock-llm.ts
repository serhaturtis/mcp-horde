import http from "node:http"
import type { AddressInfo } from "node:net"

/**
 * A tiny OpenAI-compatible chat completions server driven by the prompt text:
 *   "TOOL: <cmd>"  → calls the bash tool with <cmd>, then answers "DONE: <output>"
 *   "SLOW"         → streams "Working...." for ~15s
 *   anything else  → answers "Echo: <prompt>"
 */
export async function startMockLlm(): Promise<{ url: string; close: () => void }> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const server = http.createServer(async (req, res) => {
    let body = ""
    for await (const c of req) body += c
    if (req.url?.endsWith("/models")) return void res.end(JSON.stringify({ data: [{ id: "mock" }] }))
    const b = JSON.parse(body || "{}") as { stream?: boolean; messages?: { role: string; content: unknown }[] }
    const msgs = b.messages ?? []
    const last = msgs[msgs.length - 1]
    const lastUser = [...msgs].reverse().find((m) => m.role === "user")
    const userText =
      typeof lastUser?.content === "string"
        ? lastUser.content
        : ((lastUser?.content as { text?: string }[] | undefined) ?? []).map((p) => p.text ?? "").join(" ")
    if (b.stream === false) {
      return void res.end(
        JSON.stringify({ id: "c", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "Mock title" }, finish_reason: "stop" }] }),
      )
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    const chunk = (delta: object, finish: string | null = null) =>
      res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
    const end = () => {
      res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "mock", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`)
      res.write("data: [DONE]\n\n")
      res.end()
    }
    if (last?.role === "tool") {
      chunk({ role: "assistant", content: `DONE: ${String(last.content).slice(0, 80)}` })
      chunk({}, "stop")
      return end()
    }
    if (userText.includes("TOOL:")) {
      const cmd = userText.split("TOOL:")[1]!.trim()
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: "bash", arguments: "" } }] })
      chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: cmd, description: "run" }) } }] })
      chunk({}, "tool_calls")
      return end()
    }
    if (userText.includes("SLOW")) {
      chunk({ role: "assistant", content: "Working" })
      for (let i = 0; i < 30 && !res.destroyed; i++) {
        await sleep(500)
        chunk({ content: "." })
      }
      chunk({}, "stop")
      return end()
    }
    chunk({ role: "assistant", content: `Echo: ${userText.slice(0, 200)}` })
    chunk({}, "stop")
    end()
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}
