import http from "node:http"
import type { AddressInfo } from "node:net"

/**
 * A tiny OpenAI-compatible chat completions server scripted by the latest user prompt:
 *   "TOOL: <cmd>"   → calls shell with <cmd>, then answers "DONE: <tool output>"
 *   "CALL: <tool> {json}" → calls any offered tool with those arguments, then answers "DONE: <tool output>"
 *   a board brief    → runs its "First:" command, its RUN: lines, shares its FINDING:, reports, then answers
 *   "STEPS: <n>"    → calls shell `echo step` n times in a row, then answers "DONE"
 *   "ASK: <q>"      → calls the question tool (options Red/Blue), then answers "DONE: <tool output>"
 *   "SLOW"          → streams "Working...." for ~15s
 *   "FAIL400"       → HTTP 400; "FREETIER" → HTTP 403 FreeTierError when no tools are offered
 *   "TOOLS?"        → answers with the tool names it was offered
 *   "JSON: <json>"  → answers with that text; "JSON-RETRY" answers prose until told it was not valid; "JSON-NEVER" always prose
 *   a compaction    → a summary in OpenCode's template
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
    // OpenCode's free tier: refuses agents that offer no tools.
    if (userText.includes("FREETIER") && !(b.tools ?? []).length) {
      res.writeHead(403, { "content-type": "application/json" })
      return void res.end(
        JSON.stringify({ type: "error", error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode." } }),
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

    // OpenCode's compaction prompt (or its retry): a summary with the template's headings.
    if (/structured summary|required summary template/.test(userText)) {
      const sections = [
        "Objective",
        "Requirements",
        "Decisions",
        "Work State\n### Completed",
        "Active",
        "Blocked",
        "Next Move",
        "Relevant Files",
        "Important Context",
      ]
      return say(sections.map((h) => `${h.startsWith("Active") || h.startsWith("Blocked") ? "###" : "##"} ${h}\n- (none)`).join("\n\n"))
    }
    const steps = userText.match(/STEPS:\s*(\d+)/)
    if (steps) {
      if (toolResults < Number(steps[1])) return callTool("shell", { command: `echo step ${toolResults + 1}`, description: "step" })
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
      if (toolResults < steps.length) return callTool("shell", { command: steps[toolResults]!, description: `step ${toolResults + 1}` })
      return say(`DONE: reported. ${textOf(last).slice(0, 200)}`)
    }
    if (last?.role === "tool") return say(`DONE: ${textOf(last).slice(0, 400)}`)
    // "CALL: <tool> <json args>" calls any offered tool (e.g. one from an MCP server).
    const call = userText.match(/CALL:\s*(\S+)\s*(\{.*\})?\s*$/s)
    if (call) return callTool(call[1]!, call[2] ? JSON.parse(call[2]) : {})
    if (userText.includes("TOOL:")) return callTool("shell", { command: userText.split("TOOL:")[1]!.trim(), description: "run" })
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
    // An acceptance review: criterion 1 met with a real line of the change, criterion 2 "met"
    // with a line that is not in it (the reviewer must downgrade it), the rest not met.
    if (userText.includes("# Acceptance criteria") && userText.includes("# The change")) {
      const file = /^=== (\S+)$/m.exec(userText)?.[1] ?? "none"
      const line = Number(/^L(\d+) \+/m.exec(userText)?.[1] ?? 1)
      const count = (/# Acceptance criteria\n([\s\S]*?)\n\n/.exec(userText)?.[1] ?? "").split("\n").filter((l) => /^\d+\. /.test(l)).length
      const verdicts = Array.from({ length: count }, (_, i) =>
        i === 0
          ? { criterion: 1, status: "met", evidence: [{ file, line }], note: "done" }
          : i === 1
            ? { criterion: 2, status: "met", evidence: [{ file, line: 9999 }], note: "trust me" }
            : { criterion: i + 1, status: "not_met", evidence: [], note: "missing" },
      )
      return say(JSON.stringify({ verdicts }))
    }
    // JSON answers: "JSON: <json>" says it; "JSON-RETRY" says prose until told it was not valid.
    const everything = msgs
      .filter((m) => m.role === "user")
      .map(textOf)
      .join("\n")
    if (userText.includes("was not valid")) return say(everything.includes("JSON-NEVER") ? "still prose" : '```json\n{"verdict": "b", "score": 7}\n```')
    if (userText.includes("JSON-NEVER")) return say("prose")
    if (userText.includes("JSON-RETRY")) return say("I think b is better.")
    const json = /^JSON: (.+)$/m.exec(userText)
    if (json) return say(json[1]!)
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
