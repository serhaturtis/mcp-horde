import { type ChildProcess, execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import type { startMockLlm } from "./mock-llm.js"

const here = path.dirname(fileURLToPath(import.meta.url))
export const pkg = path.resolve(here, "..")
const binName = process.platform === "win32" ? "opencode.cmd" : "opencode"
export const opencodeBin = [path.resolve(pkg, "node_modules/.bin", binName), path.resolve(pkg, "../../node_modules/.bin", binName)].find((p) =>
  fs.existsSync(p),
)!

export type Mock = Awaited<ReturnType<typeof startMockLlm>>

export function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd })
    .toString()
    .trim()
}

/** A temp git repo configured to use the mock provider. */
export function makeRepo(mockUrl: string, extra: Record<string, unknown> = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "horde-oc-"))
  const repo = path.join(tmp, "repo")
  fs.mkdirSync(repo)
  fs.writeFileSync(
    path.join(repo, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      provider: {
        mock: {
          npm: "@ai-sdk/openai-compatible",
          name: "Mock",
          options: { baseURL: mockUrl, apiKey: "x" },
          models: {
            mock: { name: "Mock", tool_call: true, reasoning: true, variants: { high: { reasoningEffort: "high" }, low: { reasoningEffort: "low" } } },
            other: { name: "Other mock", tool_call: true },
            // $1.50 per mock step (10 input + 5 output tokens), for cost limits.
            pricey: { name: "Pricey mock", tool_call: true, cost: { input: 100_000, output: 100_000 } },
          },
        },
        // A provider OpenCode accepts but cannot run: turns are admitted and then silently dropped.
        broken: {
          npm: "@ai-sdk/this-package-does-not-exist",
          name: "Broken",
          options: { baseURL: mockUrl, apiKey: "x" },
          models: { model: { name: "Broken", tool_call: true } },
        },
      },
      model: "mock/mock",
      permission: { bash: "ask" },
      ...extra,
    }),
  )
  fs.writeFileSync(path.join(repo, "README.md"), "# test repo\n")
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\nbuild/\n")
  git(repo, "init", "-q")
  // Deterministic line endings on Windows runners.
  git(repo, "config", "core.autocrlf", "false")
  git(repo, "add", ".")
  git(repo, "commit", "-qm", "init")
  return { tmp, repo }
}

export interface Harness {
  client: Client
  call(name: string, args?: Record<string, unknown>): Promise<string>
  /** What the next elicitation dialog answers; undefined = decline support. */
  elicit: { answer: (req: { message: string; requestedSchema: unknown }) => ElicitResult | Promise<ElicitResult>; seen: string[] }
  channel: { content: string; meta: Record<string, string> }[]
  close(): Promise<void>
}

export async function connect(env: Record<string, string>, opts: { elicitation?: boolean; built?: boolean } = {}): Promise<Harness> {
  const client = new Client({ name: "test", version: "0" }, { capabilities: opts.elicitation ? { elicitation: { form: {} } } : {} })
  const elicit: Harness["elicit"] = { answer: () => ({ action: "cancel" }), seen: [] }
  const channel: Harness["channel"] = []
  if (opts.elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      const params = req.params as { message: string; requestedSchema: unknown }
      elicit.seen.push(params.message)
      return elicit.answer(params)
    })
  }
  client.setNotificationHandler(
    z.object({ method: z.literal("notifications/claude/channel"), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }) }) as never,
    (n: { params: { content: string; meta: Record<string, string> } }) => {
      channel.push(n.params)
    },
  )
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      // `built` runs the compiled package exactly as npm installs it.
      args: opts.built ? [path.join(pkg, "dist/index.js")] : ["--conditions=source", "--import", "tsx", path.join(pkg, "src/index.ts")],
      cwd: pkg,
      env: { ...(process.env as Record<string, string>), HORDE_OPENCODE_BIN: opencodeBin, ...env },
      stderr: "inherit",
    }),
  )
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 })) as { content: { text: string }[]; isError?: boolean }
    const text = res.content.map((c) => c.text).join("\n")
    if (process.env.SHOW_OUTPUT) console.error(`\n>>> ${name} ${JSON.stringify(args)}\n${text}`)
    if (res.isError) throw new Error(text)
    return text
  }
  return { client, call, elicit, channel, close: () => client.close() }
}

export async function freePort(): Promise<number> {
  const net = await import("node:net")
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolve(port))
    })
  })
}

/** Kill a process and its children (on Windows, opencode runs behind a .cmd shim). */
export function killTree(pid: number | undefined) {
  if (!pid) return
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" })
    else process.kill(pid, "SIGTERM")
  } catch {
    // already gone
  }
}

/**
 * Stop a server spawned with `detached: true` and wait for it to exit: SIGTERM to its process
 * group, then SIGKILL. OpenCode can ignore SIGTERM while it has MCP servers running (macOS),
 * and a surviving child keeps the test process alive.
 */
export async function stopTree(proc: ChildProcess, graceMs = 5000) {
  if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) return
  const exited = new Promise<void>((r) => proc.once("exit", () => r()))
  if (process.platform === "win32") return void killTree(proc.pid)
  const signal = (s: NodeJS.Signals) => {
    try {
      process.kill(-proc.pid!, s)
    } catch {
      // already gone
    }
  }
  signal("SIGTERM")
  const timer = setTimeout(() => signal("SIGKILL"), graceMs)
  await exited
  clearTimeout(timer)
  signal("SIGKILL") // the group's other members (MCP servers) too
}

export const idOf = (text: string) => text.match(/ses_[A-Za-z0-9]+/)![0]

export async function until<T>(fn: () => Promise<T | undefined | false>, ms = 30_000, every = 200): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error("timed out waiting for condition")
    await new Promise((r) => setTimeout(r, every))
  }
}

/** Environment that isolates OpenCode and our state in a temp dir. */
export function isolatedEnv(tmp: string, repo: string): Record<string, string> {
  return {
    HORDE_OPENCODE_DIRECTORY: repo,
    HORDE_OPENCODE_STATE_DIR: path.join(tmp, "state"),
    HORDE_OPENCODE_WORKTREE_DIR: path.join(tmp, "worktrees"),
    XDG_DATA_HOME: path.join(tmp, "xdg-data"),
    XDG_STATE_HOME: path.join(tmp, "xdg-state"),
    XDG_CACHE_HOME: path.join(tmp, "xdg-cache"),
    XDG_CONFIG_HOME: path.join(tmp, "xdg-config"),
  }
}
