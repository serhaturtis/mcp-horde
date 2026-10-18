import { type ChildProcess, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { killTree, pidAlive } from "@mcp-horde/core"
import { createOpencodeClient, type OpencodeClient, type V2Event } from "@opencode-ai/sdk/v2"
import { serverVersion } from "./compat.js"
import type { Config } from "./config.js"
import type { ServerRecord, Store } from "./state.js"

/** The shared-server record; `username` is absent in records written before it was stored. */

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
      const target = new URL(config.url)
      if (config.password && target.protocol === "http:" && !isLoopback(target.hostname) && !config.allowInsecure) {
        warnings.push(
          `${config.url} uses plain http to a non-loopback host: the password is sent in clear text with every request. Use https (or a tunnel), or set HORDE_OPENCODE_ALLOW_INSECURE=1 to silence this.`,
        )
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
        const known: ServerRecord | undefined = store.server // read fresh: another process may have started one
        if (known) {
          // The server checks the username it was started with, which may differ from ours.
          const username = known.username ?? config.username
          const client = connect(known.url, username, known.password)
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
                username,
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
          forgetShared(store, known) // gone: start a new one
        }
        const password = config.password ?? randomBytes(24).toString("hex")
        const { url, pid } = await spawnShared(config, store.dir, password)
        const client = connect(url, config.username, password)
        const version = await health(client, url)
        const record: ServerRecord = { url, password, pid, startedAt: Date.now(), bin: bin.command, version, username: config.username }
        store.setServer(record)
        return { client, info: { url, mode: "shared" as const, key: "local", version, username: config.username, password, pid, warnings } }
      })
      info.passwordFile = writePasswordFile(passwordFilePath(store.dir, "shared", info.url), info.password!)
      return Backend.ready(client, info, config)
    }

    const password = config.password ?? randomBytes(24).toString("hex")
    const { url, proc } = await spawnPrivate(config, password)
    const client = connect(url, config.username, password)
    const version = await health(client, url)
    // One file per private server, removed when this process exits (stale ones of dead processes are swept).
    sweepPrivatePasswordFiles(store.dir)
    const passwordFile = writePasswordFile(passwordFilePath(store.dir, "private", url), password)
    process.once("exit", () => fs.rmSync(passwordFile, { force: true }))
    proc.once("exit", () => fs.rmSync(passwordFile, { force: true }))
    return Backend.ready(
      client,
      {
        url,
        mode: "private",
        key: "local",
        version,
        username: config.username,
        password,
        passwordFile,
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
    const known: ServerRecord | undefined = store.server
    if (!known) return "No shared OpenCode server is recorded."
    const probe = await probeHealth(connect(known.url, known.username ?? config.username, known.password))
    forgetShared(store, known)
    // A server that times out while its pid lives is ours, hung: the record's URL was its port.
    const hung = !probe.ok && probe.timedOut && pidAlive(known.pid)
    if (!probe.ok && !hung) {
      return `The recorded shared server (${known.url}, pid ${known.pid}) is not answering with its password (${probe.reason || "no answer"}), so nothing was killed (the pid may belong to another process now). The record was cleared.`
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
    const left = pidAlive(known.pid) ? ` Warning: pid ${known.pid} is still alive; kill it by hand.` : ""
    if (hung) {
      return `The shared OpenCode server (pid ${known.pid}, ${known.url}) was not responding, so it was killed and its record cleared. Running agents were stopped with it.${left}`
    }
    return `Stopped the shared OpenCode server (pid ${known.pid}, ${known.url}). Running agents were stopped with it.${left}`
  })
}

/** Drop the shared-server record and its password file. */
function forgetShared(store: Store, known: ServerRecord) {
  store.setServer(undefined)
  fs.rmSync(passwordFilePath(store.dir, "shared", known.url), { force: true })
}

/** Whether the recorded shared server answers its (v2) health check with its password; never starts one. */
export async function sharedServerAlive(config: Config, known: ServerRecord, timeoutMs = 2_000): Promise<boolean> {
  const client = connect(known.url, known.username ?? config.username, known.password)
  try {
    const res = await client.v2.health.get({ signal: AbortSignal.timeout(timeoutMs) })
    return res.data?.healthy === true
  } catch {
    return false
  }
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
      // The SDK reports a timed-out request as an error result, not by throwing.
      timedOut: status === undefined && isTimeout(res.error),
      reason: status === 401 ? "unauthorized (wrong OPENCODE_SERVER_PASSWORD or USERNAME?)" : `HTTP ${status ?? "error"}: ${describe(res.error)}`,
    }
  } catch (err) {
    return { ok: false, version: "", reachable: false, timedOut: isTimeout(err), reason: describe(err) }
  }
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: string } | undefined)?.name
  return name === "TimeoutError" || name === "AbortError" || /timed? ?out|aborted due to timeout/i.test(describe(err))
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

/**
 * Where a server's password is kept for `opencode attach`: one file per server, so a private
 * server never overwrites another's (by port; private ones also by the pid of the MCP process that owns them).
 */
export function passwordFilePath(dir: string, mode: "shared" | "private", url: string): string {
  const port = new URL(url).port
  return path.join(dir, mode === "private" ? `server-password-private-${process.pid}-${port}` : `server-password-shared-${port}`)
}

function writePasswordFile(file: string, password: string): string {
  fs.writeFileSync(file, password, { mode: 0o600 })
  // writeFileSync keeps the mode of an existing file.
  fs.chmodSync(file, 0o600)
  return file
}

/** Remove the password files of private servers whose MCP process is gone (killed before it could clean up). */
function sweepPrivatePasswordFiles(dir: string) {
  try {
    for (const f of fs.readdirSync(dir)) {
      const pid = Number(/^server-password-private-(\d+)-\d+$/.exec(f)?.[1])
      if (pid && pid !== process.pid && !pidAlive(pid)) fs.rmSync(path.join(dir, f), { force: true })
    }
  } catch {
    // best effort
  }
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
      env: { ...process.env, OPENCODE_SERVER_USERNAME: config.username, OPENCODE_SERVER_PASSWORD: password },
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
    env: { ...process.env, OPENCODE_SERVER_USERNAME: config.username, OPENCODE_SERVER_PASSWORD: password, HORDE_SUPERVISED_CWD: workingDir(config) },
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
