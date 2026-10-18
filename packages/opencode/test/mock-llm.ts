import http from "node:http"
import type { AddressInfo } from "node:net"

/**
 * A tiny OpenAI-compatible chat completions server scripted by the latest user prompt:
 *   "TOOL: <cmd>"   → calls bash with <cmd>, then answers "DONE: <tool output>"
 *   "CALL: <tool> {json}" → calls any offered tool with those arguments, then answers "DONE: <tool output>"
 *   a board brief    → runs its "First:" command, its RUN: lines, shares its FINDING:, reports, then answers
 *   "STEPS: <n>"    → calls bash `echo step` n times in a row, then answers "DONE"
 *   "ASK: <q>"      → calls the question tool (options Red/Blue), then answers "DONE: <tool output>"
 *   "SLOW"          → streams "Working...." for ~15s
 *   "FAIL400"       → HTTP 400
 *   "TOOLS?"        → answers with the tool names it was offered
 *   anything else   → "Echo[<reasoning_effort>]: <prompt>" (+ " FILE:<name>" for attached files)
 */
export async function startMockLlm(): Promise<{ url: string; close: () => void; requests: unknown[] }> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const requests: unknown[] = []
  type Msg = { role: string; content: unknown }
  const textOf = (m?: Msg) =>
    typeof m?.content === "string" ? m.content : ((m?.content as { type?: string; text?: string }[] | undefined) ?? []).map((p) => p.text ?? "").join(" ")

  const server = http.createServer(async (req, res) => {
    let body = ""
    for await (const c of req) body += c
    if (req.url?.endsWith("/models")) return void res.end(JSON.stringify({ data: [{ id: "mock" }] }))
    const b = JSON.parse(body || "{}") as { stream?: boolean; messages?: Msg[]; tools?: { function: { name: string } }[]; reasoning_effort?: string }
    requests.push(b)
    const msgs = b.messages ?? []
    const last = msgs[msgs.length - 1]
    const lastUserIdx = msgs.map((m) => m.role).lastIndexOf("user")
    const lastUser = msgs[lastUserIdx]
    const userText = textOf(lastUser)
    const toolResults = msgs.slice(lastUserIdx + 1).filter((m) => m.role === "tool").length

    if (b.stream === false) {
      return void res.end(
        JSON.stringify({
          id: "c",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "Mock title" }, finish_reason: "stop" }],
        }),
      )
    }
    if (userText.includes("FAIL400")) {
      res.writeHead(400, { "content-type": "application/json" })
      return void res.end(JSON.stringify({ error: { message: "bad request from mock", type: "invalid_request_error" } }))
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    const chunk = (delta: object, finish: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      )
    const end = () => {
      res.write(
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "mock", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
      )
      res.write("data: [DONE]\n\n")
      res.end()
    }
    const say = (text: string) => {
      chunk({ role: "assistant", content: text })
      chunk({}, "stop")
      end()
    }
    const callTool = (name: string, args: object) => {
      chunk({
        role: "assistant",
        tool_calls: [{ index: 0, id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, type: "function", function: { name, arguments: "" } }],
      })
      chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] })
      chunk({}, "tool_calls")
      end()
    }

    const steps = userText.match(/STEPS:\s*(\d+)/)
    if (steps) {
      if (toolResults < Number(steps[1])) return callTool("bash", { command: `echo step ${toolResults + 1}`, description: "step" })
      return say("DONE")
    }
    // A board brief: like a cooperative worker, read the task, run the goal's "RUN: <cmd>" lines,
    // share its "FINDING: <text> @ <path>" line, then report.
    if (userText.includes("## Reporting (required)")) {
      const lines = userText.split("\n")
      const after = (marker: string) => {
        const l = lines.find((x) => x.includes(marker))
        return l?.slice(l.indexOf(marker) + marker.length).trim()
      }
      const finding = lines
        .find((l) => l.startsWith("FINDING: "))
        ?.slice(9)
        .split(" @ ")
      const steps = [
        after("- First:"),
        ...lines.filter((l) => l.startsWith("RUN: ")).map((l) => l.slice(5).trim()),
        finding && after("- A fact other workers need:")?.replace('"the fact"', `"${finding[0]}"`).replace('"src/x.ts"', `"${finding[1]}"`),
        lines
          .find((l) => / report t-\w+ \w+ --summary /.test(l))
          ?.trim()
          .replace(/--summary "[^"]*"/, '--summary "mock work done"'),
      ].filter((c): c is string => !!c)
      if (toolResults < steps.length) return callTool("bash", { command: steps[toolResults]!, description: `step ${toolResults + 1}` })
      return say(`DONE: reported. ${textOf(last).slice(0, 200)}`)
    }
    if (last?.role === "tool") return say(`DONE: ${textOf(last).slice(0, 400)}`)
    // "CALL: <tool> <json args>" calls any offered tool (e.g. one from an MCP server).
    const call = userText.match(/CALL:\s*(\S+)\s*(\{.*\})?\s*$/s)
    if (call) return callTool(call[1]!, call[2] ? JSON.parse(call[2]) : {})
    if (userText.includes("TOOL:")) return callTool("bash", { command: userText.split("TOOL:")[1]!.trim(), description: "run" })
    if (userText.includes("ASK:")) {
      return callTool("question", {
        questions: [
          {
            question: userText.split("ASK:")[1]!.trim(),
            header: "Pick",
            options: [
              { label: "Red", description: "warm" },
              { label: "Blue", description: "cool" },
            ],
          },
        ],
      })
    }
    if (userText.includes("TOOLS?")) return say(`Tools: ${(b.tools ?? []).map((t) => t.function.name).join(",")}`)
    if (userText.includes("SLOW")) {
      chunk({ role: "assistant", content: "Working" })
      for (let i = 0; i < 30 && !res.destroyed; i++) {
        await sleep(500)
        chunk({ content: "." })
      }
      chunk({}, "stop")
      return end()
    }
    const files = Array.isArray(lastUser?.content)
      ? (lastUser.content as { type?: string; text?: string; file?: { filename?: string } }[])
          .map((p) => (p.type === "file" ? `FILE:${p.file?.filename ?? "?"}` : p.type === "text" && p.text?.includes("hello-attachment") ? "FILE-CONTENT" : ""))
          .filter(Boolean)
      : []
    say(`Echo[${b.reasoning_effort ?? "none"}]: ${userText.slice(0, 200)}${files.length ? ` ${files.join(" ")}` : ""}`)
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}
