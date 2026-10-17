import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createOpencodeClient, type OpencodeClient, type V2Event } from "@opencode-ai/sdk/v2"
import { serverVersion } from "./compat.js"
import type { Config } from "./config.js"
import { pidAlive, type Store } from "./state.js"

/** OpenCode versions this server was tested against. Others work but get a warning. */
export const TESTED_OPENCODE = { major: 1, minor: 19 }

export interface ServerInfo {
  url: string
  mode: "attached" | "shared" | "private"
  /** Stable identity used to key agent records ("local" for servers we manage). */
  key: string
  version: string
  username: string
  password?: string
  /** File holding the password (mode 0600), for `opencode attach` without echoing it. */
  passwordFile?: string
  pid?: number
  warnings: string[]
}

/** A connection to an OpenCode server, spawned by us or attached to. */
export class Backend {
  readonly events = new EventEmitter()
  /** True once the event stream delivered an event; waiters poll faster when it is not. */
  streaming = false
  /** Set when the server is gone; the next tool call starts or reconnects a fresh one. */
  dead = false
  private closed = false
  private readonly abort = new AbortController()

  private constructor(
    readonly client: OpencodeClient,
    readonly info: ServerInfo,
    private readonly proc?: ChildProcess,
  ) {
    this.events.setMaxListeners(0)
    proc?.once("exit", () => this.markDead())
    void this.pump()
  }

  static async start(config: Config, store: Store): Promise<Backend> {
    const warnings: string[] = []
    if (config.url) {
      if (!config.password) {
        if (!isLoopback(new URL(config.url).hostname) && !config.allowInsecure) {
          throw new Error(
            `Refusing to use ${config.url} without OPENCODE_SERVER_PASSWORD: anyone who can reach it can run commands as you. Set the password, or HORDE_OPENCODE_ALLOW_INSECURE=1.`,
          )
        }
        warnings.push(`${config.url} is used without a password; any local process can drive it. Set OPENCODE_SERVER_PASSWORD on both sides.`)
      }
      const client = connect(config.url, config.username, config.password)
      const version = await health(client, config.url)
      return Backend.ready(
        client,
        { url: config.url, mode: "attached", key: config.url, version, username: config.username, password: config.password, warnings },
        config,
      )
    }

    if (config.serverMode === "shared") {
      const bin = resolveBinary(config.bin)
      const { client, info } = await store.lock("server", async (): Promise<{ client: OpencodeClient; info: ServerInfo }> => {
        const known = store.server // read fresh: another process may have started one
        if (known) {
          const client = connect(known.url, config.username, known.password)
          const probe = await probeHealth(client)
          if (probe.ok) {
            if (known.bin && known.bin !== bin.command) {
              warnings.push(`The shared server runs ${known.bin}, but this process is configured for ${bin.command}. Stop it (opencode_server stop) to switch.`)
            }
            return {
              client,
              info: {
                url: known.url,
                mode: "shared" as const,
                key: "local",
                version: probe.version,
                username: config.username,
                password: known.password,
                pid: known.pid,
                warnings,
              },
            }
          }
          if (probe.reachable) {
            throw new Error(
              `The recorded shared OpenCode server at ${known.url} (pid ${known.pid}) answers but is not usable: ${probe.reason}. ` +
                "Check OPENCODE_SERVER_USERNAME/PASSWORD, or stop it with opencode_server stop.",
            )
          }
          if (probe.timedOut && pidAlive(known.pid)) {
            throw new Error(
              `The recorded shared OpenCode server at ${known.url} (pid ${known.pid}) is not responding. Stop it with opencode_server stop, then retry.`,
            )
          }
          store.setServer(undefined) // gone: start a new one
        }
        const password = config.password ?? randomBytes(24).toString("hex")
        const { url, pid } = await spawnShared(config, store.dir, password)
        const client = connect(url, config.username, password)
        const version = await health(client, url)
        store.setServer({ url, password, pid, startedAt: Date.now(), bin: bin.command, version })
        return { client, info: { url, mode: "shared" as const, key: "local", version, username: config.username, password, pid, warnings } }
      })
      info.passwordFile = writePasswordFile(store.dir, info.password!)
      return Backend.ready(client, info, config)
    }

    const password = config.password ?? randomBytes(24).toString("hex")
    const { url, proc } = await spawnPrivate(config, password)
    const client = connect(url, config.username, password)
    const version = await health(client, url)
    return Backend.ready(
      client,
      {
        url,
        mode: "private",
        key: "local",
        version,
        username: config.username,
        password,
        passwordFile: writePasswordFile(store.dir, password),
        pid: proc.pid,
        warnings,
      },
      config,
      proc,
    )
  }

  private static async ready(client: OpencodeClient, info: ServerInfo, config: Config, proc?: ChildProcess) {
    const [major, minor] = info.version.split(".").map(Number)
    if (info.version !== "unknown" && (major !== TESTED_OPENCODE.major || minor !== TESTED_OPENCODE.minor)) {
      info.warnings.push(
        `opencode ${info.version} is untested (tested: ${TESTED_OPENCODE.major}.${TESTED_OPENCODE.minor}.x). The v2 API is still evolving; report issues.`,
      )
    }
    // A freshly started server answers with empty catalogs until it has
    // loaded the project, which would make model validation fail spuriously.
    await waitForCatalog(client, workingDir(config))
    return new Backend(client, info, proc)
  }

  /** Follow the server-wide event stream, reconnecting until closed. */
  private async pump() {
    let backoff = 250
    let failures = 0
    while (!this.closed) {
      let received = false
      try {
        // The SDK swallows connection errors and just ends the stream, so
        // success is judged by whether any event arrived.
        const sub = await this.client.v2.event.subscribe({ signal: this.abort.signal, sseMaxRetryAttempts: 1 })
        for await (const event of sub.stream) {
          if (this.closed) return
          if (!received) {
            received = true
            this.streaming = true
            backoff = 250
            failures = 0
          }
          try {
            this.events.emit("event", event as V2Event)
          } catch {
            // A listener bug must not tear down the stream.
          }
        }
      } catch {
        // Reconnect below; waiters keep polling in the meantime.
      }
      this.streaming = false
      if (this.closed) return
      if (!received && ++failures >= 3) {
        const probe = await probeHealth(this.client)
        if (!probe.ok) {
          this.markDead()
          return
        }
      }
      await new Promise((r) => setTimeout(r, backoff))
      backoff = Math.min(backoff * 2, 10_000)
    }
  }

  private markDead() {
    if (this.dead) return
    this.dead = true
    this.streaming = false
    this.events.emit("dead")
  }

  /** Stop listening. A shared server keeps running so agents survive restarts; a private one is stopped. */
  close() {
    this.closed = true
    this.abort.abort()
    if (this.proc && this.proc.exitCode === null) killTree(this.proc.pid!, false)
  }
}

/**
 * Stop the server for the current mode. A shared server is only killed after
 * its recorded password authenticates, so a recycled PID is never killed.
 */
export async function stopServer(config: Config, store: Store, backend?: Backend): Promise<string> {
  if (config.url) return `Not stopping ${config.url}: it is an attached server that this MCP server does not manage.`
  if (config.serverMode === "private") {
    if (!backend) return "No private OpenCode server is running."
    backend.close()
    return `Stopped the private OpenCode server (${backend.info.url}). Running agents were stopped with it.`
  }
  return store.lock("server", async () => {
    const known = store.server
    if (!known) return "No shared OpenCode server is recorded."
    const probe = await probeHealth(connect(known.url, config.username, known.password))
    store.setServer(undefined)
    if (!probe.ok) {
      return `The recorded shared server (${known.url}, pid ${known.pid}) is not answering with its password, so nothing was killed (the pid may belong to another process now). The record was cleared.`
    }
    killTree(known.pid, true)
    const deadline = Date.now() + 5_000
    while (pidAlive(known.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    if (pidAlive(known.pid) && !isWindows) {
      try {
        process.kill(-known.pid, "SIGKILL")
      } catch {
        // already gone
      }
    }
    return `Stopped the shared OpenCode server (pid ${known.pid}, ${known.url}). Running agents were stopped with it.`
  })
}

export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "")
  if (h === "localhost" || h === "::1") return true
  return net.isIPv4(h) && h.startsWith("127.")
}

function connect(url: string, username: string, password?: string): OpencodeClient {
  const headers: Record<string, string> = {}
  if (password) headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  return createOpencodeClient({ baseUrl: url, headers })
}

interface Probe {
  ok: boolean
  version: string
  /** Something answered HTTP at that address. */
  reachable: boolean
  timedOut: boolean
  reason: string
}

async function probeHealth(client: OpencodeClient, timeoutMs = 5_000): Promise<Probe> {
  try {
    const res = await client.v2.health.get({ signal: AbortSignal.timeout(timeoutMs) })
    if (res.data?.healthy) {
      // v2 health has no version; it only matters for the tested-version warning.
      const version = (await serverVersion(client, timeoutMs)) ?? "unknown"
      return { ok: true, version, reachable: true, timedOut: false, reason: "" }
    }
    const status = res.response?.status
    return {
      ok: false,
      version: "",
      reachable: status !== undefined,
      timedOut: false,
      reason: status === 401 ? "unauthorized (wrong OPENCODE_SERVER_PASSWORD or USERNAME?)" : `HTTP ${status ?? "error"}: ${describe(res.error)}`,
    }
  } catch (err) {
    const name = (err as { name?: string }).name
    return { ok: false, version: "", reachable: false, timedOut: name === "TimeoutError" || name === "AbortError", reason: describe(err) }
  }
}

async function health(client: OpencodeClient, url: string): Promise<string> {
  const probe = await probeHealth(client)
  if (!probe.ok) throw new Error(`OpenCode server at ${url} is not reachable: ${probe.reason}`)
  return probe.version
}

async function waitForCatalog(client: OpencodeClient, directory: string) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const res = await client.v2.agent.list({ location: { directory } }, { signal: AbortSignal.timeout(5_000) }).catch(() => undefined)
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

function writePasswordFile(dir: string, password: string): string {
  const file = path.join(dir, "server-password")
  fs.writeFileSync(file, password, { mode: 0o600 })
  return file
}

/** The configured directory, or home if it does not exist (the error then comes from spawn, not launch). */
function workingDir(config: Config): string {
  return fs.existsSync(config.directory) ? config.directory : os.homedir()
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

/**
 * On Windows, npm installs `opencode.cmd`, a shim around the native
 * opencode.exe. Spawning the shim needs a shell and leaves the real server
 * running when the shim is killed, so resolve it to the executable.
 */
export function resolveBinary(bin: string, platform = process.platform, env = process.env): { command: string; shell: boolean } {
  if (platform !== "win32") return { command: bin, shell: false }
  const candidates = /[\\/]/.test(bin)
    ? [bin]
    : (env.PATH ?? "")
        .split(path.win32.delimiter)
        .flatMap((dir) => [path.win32.join(dir, `${bin}.exe`), path.win32.join(dir, `${bin}.cmd`), path.win32.join(dir, bin)])
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue
    if (candidate.toLowerCase().endsWith(".exe")) return { command: candidate, shell: false }
    if (candidate.toLowerCase().endsWith(".cmd")) {
      const exe = shimTarget(fs.readFileSync(candidate, "utf8"))
      if (exe) {
        const full = path.win32.join(path.win32.dirname(candidate), exe)
        if (fs.existsSync(full)) return { command: full, shell: false }
      }
      return { command: candidate, shell: true }
    }
  }
  return { command: bin, shell: true }
}

/** The program an npm .cmd shim runs (ignoring the `IF EXIST node.exe` probe of JS shims). */
export function shimTarget(shim: string): string | undefined {
  const matches = [...shim.matchAll(/"%~?dp0%?\\([^"]+?\.exe)"/gi)].map((m) => m[1]!)
  return matches.filter((m) => !/(^|\\)node\.exe$/i.test(m)).pop()
}

/** Stop a process and everything it started (`group`: it leads its own process group). */
export function killTree(pid: number, group: boolean) {
  try {
    if (isWindows) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    else process.kill(group ? -pid : pid, "SIGTERM")
  } catch {
    try {
      if (!isWindows && group) process.kill(pid, "SIGTERM")
    } catch {
      // Already gone.
    }
  }
}

function serveArgs(port: number) {
  return ["serve", "--hostname", "127.0.0.1", "--port", String(port)]
}

/** A detached server that outlives this process; its output goes to a log file. */
async function spawnShared(config: Config, stateDir: string, password: string): Promise<{ url: string; pid: number }> {
  const logPath = path.join(stateDir, "opencode-server.log")
  let lastError: Error | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort()
    const log = fs.openSync(logPath, "w", 0o600)
    const bin = resolveBinary(config.bin)
    const proc = spawn(bin.command, serveArgs(port), {
      cwd: workingDir(config),
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
      stdio: ["ignore", log, log],
      detached: true,
      windowsHide: true,
      shell: bin.shell,
    })
    fs.closeSync(log)
    proc.unref()
    const url = `http://127.0.0.1:${port}`
    const client = connect(url, config.username, password)
    try {
      await new Promise<void>((resolve, reject) => {
        proc.once("error", (err) =>
          reject(new Error(`Failed to launch \`${config.bin}\`: ${err.message}. Install opencode or set HORDE_OPENCODE_BIN / HORDE_OPENCODE_URL.`)),
        )
        void (async () => {
          // We chose the port, so poll it (with our password: another process
          // grabbing the port must not count) instead of parsing output.
          const deadline = Date.now() + 60_000
          while (Date.now() < deadline) {
            if (proc.exitCode !== null) return reject(new Error(`\`${config.bin} serve\` exited with code ${proc.exitCode}.\n${readTail(logPath)}`))
            const probe = await probeHealth(client, 2_000)
            if (probe.ok && proc.exitCode === null) return resolve()
            await new Promise((r) => setTimeout(r, 200))
          }
          killTree(proc.pid!, true)
          reject(new Error(`Timed out waiting for \`${config.bin} serve\`; see ${logPath}`))
        })()
      })
      return { url, pid: proc.pid! }
    } catch (err) {
      lastError = err as Error
      if (/Failed to launch/.test(lastError.message)) break
    }
  }
  throw lastError ?? new Error("could not start opencode serve")
}

function readTail(file: string): string {
  try {
    return fs.readFileSync(file, "utf8").slice(-4000)
  } catch {
    return ""
  }
}

/** A server owned by this process, stopped by a watchdog even if we are killed. */
async function spawnPrivate(config: Config, password: string) {
  const port = await freePort()
  // Built: supervisor.js next to this file. From source (tsx): supervisor.ts with our loader flags.
  const js = fileURLToPath(new URL("./supervisor.js", import.meta.url))
  const supervisor = fs.existsSync(js) ? [js] : [...process.execArgv, fileURLToPath(new URL("./supervisor.ts", import.meta.url))]
  const proc = spawn(process.execPath, [...supervisor, String(process.pid), resolveBinary(config.bin).command, ...serveArgs(port)], {
    // Our own directory, so loader flags resolve; the supervisor starts OpenCode in the agent directory.
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password, HORDE_SUPERVISED_CWD: workingDir(config) },
    // stdin stays open as a lifeline: the supervisor stops OpenCode when it closes.
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  const killChild = () => {
    if (proc.exitCode === null) killTree(proc.pid!, false)
  }
  process.once("exit", killChild)

  const url = await new Promise<string>((resolve, reject) => {
    let output = ""
    const timer = setTimeout(() => {
      killChild()
      reject(new Error(`Timed out waiting for \`${config.bin} serve\` to start.\n${output}`))
    }, 60_000)
    const onData = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000)
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
