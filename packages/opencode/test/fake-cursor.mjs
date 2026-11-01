#!/usr/bin/env node
// A stand-in for Cursor's agent CLI in print mode. It speaks the stream-json shapes the
// runtime parses and acts on simple prompt lines: RUN: <cmd>, WRITE: <path>=<content>,
// SLOW (sleep 20 s first), FAIL (end with is_error), and review prompts get JSON verdicts.
// The prompt arrives on stdin (as the real CLI reads it), with HOLD_STDOUT leaving a detached
// grandchild on stdout, SIGKILL_SELF dying by signal, and DUP_TEXT answering in two chunks.
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const readStdin = async () => {
  let text = ""
  for await (const chunk of process.stdin) text += chunk
  return text
}

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : fallback
}
const workspace = flag("--workspace", process.cwd())
const resume = flag("--resume")
const model = flag("--model", "auto")
const mode = flag("--mode")
const stdin = process.stdin.isTTY ? "" : await readStdin()
// The runtime writes the prompt to stdin and passes no positional argument.
const prompt = stdin || (argv[argv.length - 1] ?? "")
const addDirs = argv.flatMap((arg, i) => (arg === "--add-dir" && argv[i + 1] ? [argv[i + 1]] : []))

const stateDir = process.env.CURSOR_FAKE_STATE || path.join(process.env.XDG_STATE_HOME || os.tmpdir(), "horde-cursor-fake")
fs.mkdirSync(stateDir, { recursive: true })
const sessionsFile = path.join(stateDir, "sessions.json")
const callsFile = path.join(stateDir, "calls.jsonl")
let sessions = {}
try {
  sessions = JSON.parse(fs.readFileSync(sessionsFile, "utf8"))
} catch {
  sessions = {}
}
const session = resume || `cursor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
sessions[session] ??= { id: session, prompts: [] }
sessions[session].prompts.push(prompt)
fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2))
fs.appendFileSync(
  callsFile,
  `${JSON.stringify({
    at: Date.now(),
    pid: process.pid,
    argv,
    workspace,
    model,
    mode,
    addDirs,
    resume: resume ?? null,
    session,
    prompt,
    envKeys: Object.keys(process.env).sort(),
  })}\n`,
)

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

emit({ type: "system", subtype: "init", cwd: workspace, session_id: session, model, permissionMode: "default" })
emit({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } })
emit({ type: "thinking", subtype: "delta", text: "working" })
emit({ type: "thinking", subtype: "completed" })

const lines = prompt.split("\n")
if (/\bSIGKILL_SELF\b/.test(prompt)) {
  process.kill(process.pid, "SIGKILL")
  await sleep(10_000)
}
if (lines.some((l) => /^\s*SLOW\b/.test(l))) await sleep(20_000)

const json = reviewJson(prompt)
let text
if (json) {
  text = JSON.stringify(json)
} else {
  const rest = []
  text = ""
  for (const line of lines) {
    if (/^\s*SLOW\b/.test(line) || /^\s*FAIL\b/.test(line)) continue
    const run = /^\s*RUN:\s*(.+)$/.exec(line)
    if (run) {
      const command = run[1].trim()
      const id = `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      emit({
        type: "tool_call",
        subtype: "started",
        call_id: id,
        tool_call: { shellToolCall: { args: { command, workingDirectory: "", timeout: 30_000 }, result: null } },
      })
      const result = spawnSync(command, { cwd: workspace, shell: true, encoding: "utf8" })
      emit({
        type: "tool_call",
        subtype: "completed",
        call_id: id,
        tool_call: {
          shellToolCall: {
            args: { command, workingDirectory: "", timeout: 30_000 },
            result: { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.status ?? 1 },
          },
        },
      })
      continue
    }
    const write = /^\s*WRITE:\s*(.+?)=(.*)$/.exec(line)
    if (write) {
      const target = path.resolve(workspace, write[1].trim())
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, write[2])
      const id = `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      const relative = path.relative(workspace, target)
      emit({
        type: "tool_call",
        subtype: "started",
        call_id: id,
        tool_call: { editToolCall: { args: { path: relative }, result: null } },
      })
      emit({
        type: "tool_call",
        subtype: "completed",
        call_id: id,
        tool_call: { editToolCall: { args: { path: relative }, result: { output: `wrote ${relative}` } } },
      })
      continue
    }
    rest.push(line)
  }
  text = rest.join("\n").trim()
}
if (!text) text = "done"
if (/\bDUP_TEXT\b/.test(prompt)) {
  // "Done.\nDone." split across two assistant events: a repeated tail is real text, not a duplicate.
  text = "Done.\nDone."
  for (const chunk of ["Done.\n", "Done."]) {
    emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: chunk }] }, model_call_id: `call_${Date.now()}` })
  }
} else {
  emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, model_call_id: `call_${Date.now()}` })
}
const fail = lines.some((l) => /^\s*FAIL\b/.test(l))
emit({
  type: "result",
  subtype: fail ? "error" : "success",
  duration_ms: 42,
  is_error: fail,
  result: fail ? "failed on purpose" : text,
  usage: { inputTokens: 10355, outputTokens: 175, cacheReadTokens: 18560, cacheWriteTokens: 0 },
})
if (/\bHOLD_STDOUT\b/.test(prompt)) {
  // A tool that daemonizes and keeps the inherited stdout open: the runtime must finish at exit.
  spawn(process.execPath, ["-e", "setTimeout(() => {}, 6000)"], { stdio: ["ignore", "inherit", "inherit"], detached: true }).unref()
}

/** Verdicts for a review prompt: every criterion cites the first added line of the diff. */
function reviewJson(prompt) {
  if (!prompt.includes("# Acceptance criteria") || !prompt.includes("# The change")) return undefined
  const section = (prompt.split("# Acceptance criteria\n")[1] ?? "").split("\n\n# ")[0] ?? ""
  const criteria = section.split("\n").filter((l) => /^\d+\. /.test(l))
  const change = prompt.split("# The change")[1] ?? ""
  let file
  let line
  for (const l of change.split("\n")) {
    const heading = /^=== (.+?)(?: \(deleted\))?$/.exec(l)
    if (heading) {
      file = heading[1]
      continue
    }
    const added = /^L(\d+) \+(.+)$/.exec(l)
    if (file && added?.[2]?.trim()) {
      line = Number(added[1])
      break
    }
  }
  return {
    verdicts: criteria.map((_, i) =>
      file && line
        ? { criterion: i + 1, status: "met", evidence: [{ file, line }], note: "matches the change" }
        : { criterion: i + 1, status: "unclear", evidence: [], note: "the change is not visible" },
    ),
  }
}
