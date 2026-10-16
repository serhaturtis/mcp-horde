import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createOpencodeClient, type OpencodeClient, type V2Event } from "@opencode-ai/sdk/v2"
import type { Config } from "./config.js"
import type { Store } from "./state.js"

/** OpenCode versions this server was tested against. Others work but get a warning. */
export const TESTED_OPENCODE = { major: 1, minor: 19 }

export interface ServerInfo {
  url: string
  mode: "attached" | "shared" | "private"
  version: string
  /** Credentials, so the user can `opencode attach` to watch agents live. */
  username: string
  password?: string
  pid?: number
  warnings: string[]
}

/** A connection to an OpenCode server, spawned by us or attached to. */
export class Backend {
  readonly events = new EventEmitter()
  /** True while the event stream is connected; waiters poll faster when it is not. */
  streaming = false
  private closed = false
  private readonly abort = new AbortController()

  private constructor(
    readonly client: OpencodeClient,
    readonly info: ServerInfo,
    private readonly proc?: ChildProcess,
  ) {
    this.events.setMaxListeners(0)
    void this.pump()
  }

  static async start(config: Config, store: Store): Promise<Backend> {
    const warnings: string[] = []
    if (config.url) {
      if (!config.password) {
        const host = new URL(config.url).hostname
        const loopback = host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.")
        if (!loopback && !config.allowInsecure) {
          throw new Error(
            `Refusing to use ${config.url} without OPENCODE_SERVER_PASSWORD: anyone who can reach it can run commands as you. Set the password, or HORDE_OPENCODE_ALLOW_INSECURE=1.`,
          )
        }
        warnings.push(`${config.url} is used without a password; any local process can drive it. Set OPENCODE_SERVER_PASSWORD on both sides.`)
      }
      const client = connect(config.url, config.username, config.password)
      const version = await health(client, config.url)
      return Backend.ready(client, { url: config.url, mode: "attached", version, username: config.username, password: config.password, warnings }, config)
    }

    if (config.serverMode === "shared") {
      return store.lock("server", async () => {
        const known = store.server
        if (known) {
          const client = connect(known.url, config.username, known.password)
          const version = await health(client, known.url).catch(() => undefined)
          if (version) {
            return Backend.ready(
              client,
              { url: known.url, mode: "shared", version, username: config.username, password: known.password, pid: known.pid, warnings },
              config,
            )
          }
        }
        const password = config.password ?? randomBytes(24).toString("hex")
        const { url, pid } = await spawnShared(config, store.dir, password)
        store.setServer({ url, password, pid, startedAt: Date.now() })
        const client = connect(url, config.username, password)
        const version = await health(client, url)
        return Backend.ready(client, { url, mode: "shared", version, username: config.username, password, pid, warnings }, config)
      })
    }

    const password = config.password ?? randomBytes(24).toString("hex")
    const { url, proc } = await spawnPrivate(config, password)
    const client = connect(url, config.username, password)
    const version = await health(client, url)
    return Backend.ready(client, { url, mode: "private", version, username: config.username, password, pid: proc.pid, warnings }, config, proc)
  }

  private static async ready(client: OpencodeClient, info: ServerInfo, config: Config, proc?: ChildProcess) {
    const [major, minor] = info.version.split(".").map(Number)
    if (major !== TESTED_OPENCODE.major || minor !== TESTED_OPENCODE.minor) {
      info.warnings.push(
        `opencode ${info.version} is untested (tested: ${TESTED_OPENCODE.major}.${TESTED_OPENCODE.minor}.x). The v2 API is still evolving; report issues.`,
      )
    }
    // A freshly started server answers with empty catalogs until it has
    // loaded the project, which would make model validation fail spuriously.
    await waitForCatalog(client, config.directory)
    return new Backend(client, info, proc)
  }

  /** Follow the server-wide event stream, reconnecting until closed. */
  private async pump() {
    let backoff = 250
    while (!this.closed) {
      try {
        const sub = await this.client.v2.event.subscribe({ signal: this.abort.signal, sseMaxRetryAttempts: 1 })
        this.streaming = true
        backoff = 250
        for await (const event of sub.stream) {
          if (this.closed) return
          this.events.emit("event", event as V2Event)
        }
      } catch {
        // Reconnect below; waiters keep polling in the meantime.
      }
      this.streaming = false
      if (this.closed) return
      await new Promise((r) => setTimeout(r, backoff))
      backoff = Math.min(backoff * 2, 5000)
    }
  }

  /** Stop listening. A shared server keeps running so agents survive restarts. */
  close() {
    this.closed = true
    this.abort.abort()
    if (this.proc && this.proc.exitCode === null) killTree(this.proc.pid!)
  }
}

export async function stopSharedServer(store: Store): Promise<string> {
  const known = store.server
  if (!known) return "No shared OpenCode server is recorded."
  killTree(known.pid)
  store.setServer(undefined)
  return `Stopped the shared OpenCode server (pid ${known.pid}, ${known.url}). Running agents were stopped with it.`
}

function connect(url: string, username: string, password?: string): OpencodeClient {
  const headers: Record<string, string> = {}
  if (password) headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  return createOpencodeClient({ baseUrl: url, headers })
}

async function health(client: OpencodeClient, url: string): Promise<string> {
  const res = await client.global.health().catch((e: unknown) => ({ data: undefined, error: e, response: undefined }))
  if (!res.data?.healthy) {
    const status = res.response?.status
    const why = status === 401 ? "unauthorized (wrong OPENCODE_SERVER_PASSWORD?)" : describe(res.error) || `HTTP ${status}`
    throw new Error(`OpenCode server at ${url} is not reachable: ${why}`)
  }
  return res.data.version
}

async function waitForCatalog(client: OpencodeClient, directory: string) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const res = await client.v2.agent.list({ location: { directory } }).catch(() => undefined)
    if (res?.data?.data.length) return
    await new Promise((r) => setTimeout(r, 300))
  }
}

function describe(error: unknown): string {
  if (!error) return ""
  if (error instanceof Error) return error.message
  if (typeof error === "object" && "message" in error) return String((error as { message: unknown }).message)
  return JSON.stringify(error)
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

const LISTENING = /opencode server listening on\s+(https?:\/\/\S+)/
const isWindows = process.platform === "win32"

/** Stop a process and everything it started (on Windows the binary runs behind a .cmd shim). */
export function killTree(pid: number) {
  try {
    if (isWindows) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    else process.kill(pid, "SIGTERM")
  } catch {
    // Already gone.
  }
}

function serveArgs(port: number) {
  return ["serve", "--hostname", "127.0.0.1", "--port", String(port)]
}

/** A detached server that outlives this process; its output goes to a log file. */
async function spawnShared(config: Config, stateDir: string, password: string) {
  const port = await freePort()
  const logPath = path.join(stateDir, "opencode-server.log")
  const log = fs.openSync(logPath, "w", 0o600)
  const proc = spawn(config.bin, serveArgs(port), {
    cwd: config.directory,
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
    stdio: ["ignore", log, log],
    detached: true,
    windowsHide: true,
    shell: isWindows,
  })
  fs.closeSync(log)
  const launchError = new Promise<never>((_, reject) =>
    proc.once("error", (err) =>
      reject(new Error(`Failed to launch \`${config.bin}\`: ${err.message}. Install opencode or set HORDE_OPENCODE_BIN / HORDE_OPENCODE_URL.`)),
    ),
  )
  proc.unref()
  // We chose the port, so poll it instead of parsing output (a detached
  // process on Windows does not reliably write to the redirected log).
  const url = `http://127.0.0.1:${port}`
  await Promise.race([
    launchError,
    (async () => {
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        const res = await fetch(`${url}/global/health`, { signal: AbortSignal.timeout(2000) }).catch(() => undefined)
        if (res) return
        if (proc.exitCode !== null) {
          throw new Error(`\`${config.bin} serve\` exited with code ${proc.exitCode}.\n${fs.readFileSync(logPath, "utf8")}`)
        }
        await new Promise((r) => setTimeout(r, 200))
      }
      killTree(proc.pid!)
      throw new Error(`Timed out waiting for \`${config.bin} serve\`; see ${logPath}`)
    })(),
  ])
  return { url, pid: proc.pid! }
}

/** A server owned by this process, stopped by a watchdog even if we are killed. */
async function spawnPrivate(config: Config, password: string) {
  const port = await freePort()
  // Built: supervisor.js next to this file. From source (tsx): supervisor.ts with our loader flags.
  const js = fileURLToPath(new URL("./supervisor.js", import.meta.url))
  const supervisor = fs.existsSync(js) ? [js] : [...process.execArgv, fileURLToPath(new URL("./supervisor.ts", import.meta.url))]
  const proc = spawn(process.execPath, [...supervisor, String(process.pid), config.bin, ...serveArgs(port)], {
    // Our own directory, so loader flags resolve; the supervisor starts OpenCode in config.directory.
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password, HORDE_SUPERVISED_CWD: config.directory },
    // stdin stays open as a lifeline: the supervisor stops OpenCode when it closes.
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  const killChild = () => {
    if (proc.exitCode === null) killTree(proc.pid!)
  }
  process.once("exit", killChild)

  const url = await new Promise<string>((resolve, reject) => {
    let output = ""
    const timer = setTimeout(() => {
      killChild()
      reject(new Error(`Timed out waiting for \`${config.bin} serve\` to start.\n${output}`))
    }, 30_000)
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      const match = output.match(LISTENING)
      if (match?.[1]) {
        clearTimeout(timer)
        resolve(match[1])
      }
    }
    proc.stdout?.on("data", onData)
    proc.stderr?.on("data", onData)
    proc.once("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`\`${config.bin} serve\` exited with code ${code}.\n${output}`))
    })
  })
  // Drain output so the child never blocks on a full pipe.
  proc.stdout?.resume()
  proc.stderr?.resume()
  return { url, proc }
}
