#!/usr/bin/env node
// A dependency-free stand-in for `codex exec --json` / `codex exec resume`, scripted by the
// prompt: "RUN: <cmd>" runs a command in -C's directory, "WRITE: <path>=<content>" writes a file,
// a "SLOW" line sleeps first, and the rest becomes an agent_message. State (invocations, threads)
// lives under $CODEX_HOME/fake-codex so tests can inspect what the runtime sent.
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const argv = process.argv.slice(2)
const stateRoot = path.join(process.env.CODEX_HOME || os.tmpdir(), "fake-codex")
const threadsDir = path.join(stateRoot, "threads")
const invocations = path.join(stateRoot, "invocations.jsonl")
fs.mkdirSync(threadsDir, { recursive: true })

let i = 0
if (argv[i] !== "exec") throw new Error("fake-codex: expected `exec`")
i++
let resume
if (argv[i] === "resume") {
  i++
  resume = argv[i] ?? ""
  i++
}
let cwd = process.cwd()
let sandbox = "workspace-write"
let model
const addDirs = []
const positional = []
while (i < argv.length) {
  const a = argv[i++]
  if (a === "--json") continue
  if (a === "-C" || a === "--cd") {
    cwd = argv[i++] ?? cwd
    continue
  }
  if (a === "-s" || a === "--sandbox") {
    sandbox = argv[i++] ?? sandbox
    continue
  }
  if (a === "--add-dir") {
    addDirs.push(argv[i++] ?? "")
    continue
  }
  if (a === "-m" || a === "--model") {
    model = argv[i++]
    continue
  }
  if (a === "-c" || a === "--config") {
    const value = argv[i++] ?? ""
    const found = /sandbox_mode\s*=\s*"?([\w-]+)"?/.exec(value)
    if (found) sandbox = found[1]
    continue
  }
  if (a === "--skip-git-repo-check") continue
  if (a.startsWith("-")) continue
  positional.push(a)
}
const prompt = positional.join(" ")
const threadId = resume || randomUUID()

const threadFile = path.join(threadsDir, `${threadId}.json`)
let thread = { threadId, prompts: [], sandboxes: [] }
try {
  thread = JSON.parse(fs.readFileSync(threadFile, "utf8"))
} catch {
  // A new thread.
}
thread.prompts.push(prompt)
thread.sandboxes.push(sandbox)
fs.writeFileSync(threadFile, JSON.stringify(thread, null, 2))
fs.appendFileSync(invocations, `${JSON.stringify({ args: argv, prompt, cwd, sandbox, model, addDirs, threadId, pid: process.pid, at: Date.now() })}\n`)

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const usage = {
  input_tokens: 29420,
  cached_input_tokens: 25856,
  cache_write_input_tokens: 0,
  output_tokens: 151,
  reasoning_output_tokens: 0,
}
let items = 0
const itemID = () => `item_${items++}`

emit({ type: "thread.started", thread_id: threadId })
emit({ type: "turn.started" })

if (/\bSLOW\b/.test(prompt)) await sleep(20_000)

const message = (text) => {
  const item = { id: itemID(), type: "agent_message", text }
  emit({ type: "item.started", item: { ...item } })
  emit({ type: "item.completed", item })
}
const command = (cmd) => {
  const started = { id: itemID(), type: "command_execution", command: cmd, aggregated_output: "", exit_code: null, status: "in_progress" }
  emit({ type: "item.started", item: started })
  const result = spawnSync("/bin/sh", ["-c", cmd], { cwd, encoding: "utf8" })
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
  const exit = typeof result.status === "number" ? result.status : 1
  emit({
    type: "item.completed",
    item: { ...started, aggregated_output: output, exit_code: exit, status: exit === 0 ? "completed" : "failed" },
  })
  return output
}
const write = (file, content) => {
  const target = path.resolve(cwd, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
  const started = { id: itemID(), type: "file_change", changes: [{ path: file, kind: "update" }], status: "in_progress" }
  emit({ type: "item.started", item: started })
  emit({ type: "item.completed", item: { ...started, status: "completed" } })
}

// An acceptance review: answer with verdicts the reviewer can cite from the diff.
if (prompt.includes("# Acceptance criteria") && prompt.includes("# The change")) {
  const section = /# Acceptance criteria\n([\s\S]*?)\n\n/.exec(prompt)?.[1] ?? ""
  const count = section.split("\n").filter((l) => /^\d+\. /.test(l)).length
  const file = /^=== (\S+)$/m.exec(prompt)?.[1]
  const line = Number(/^L(\d+) [+ ]/m.exec(prompt)?.[1] ?? 1)
  const verdicts = Array.from({ length: count }, (_, n) => ({
    criterion: n + 1,
    status: "met",
    evidence: file ? [{ file, line }] : [{ check: "test" }],
    note: "done",
  }))
  message(JSON.stringify({ verdicts }))
} else {
  const said = []
  for (const raw of prompt.split("\n")) {
    const line = raw.trim()
    const run = /^RUN:\s*(.+)$/.exec(line)
    if (run) {
      command(run[1])
      continue
    }
    const writeLine = /^WRITE:\s*(.+)$/.exec(line)
    if (writeLine) {
      const at = writeLine[1].indexOf("=")
      if (at > 0) write(writeLine[1].slice(0, at), writeLine[1].slice(at + 1))
      continue
    }
    if (line === "SLOW" || line.startsWith("SLOW ")) continue
    if (line) said.push(raw)
  }
  if (said.length) message(said.join("\n"))
}

emit({ type: "turn.completed", usage })
