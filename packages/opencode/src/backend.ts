import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { killTree, pidAlive, scopeAvailable, scopeCommand } from "@mcp-horde/core"
import { OpenCode, type OpenCodeClient } from "@opencode/client"
import type { Config } from "./config.js"
import type { ServerRecord, Store } from "./state.js"

/** The shared-server record; `username` is absent in records written before it was stored. */

/** OpenCode versions this server was tested against. Others work but get a warning. */
export const TESTED_OPENCODE = { major: 2, minor: 1 }

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
  /** A version mismatch with the configured binary, shown once per process (reconnect only). */
  versionWarning?: string
  /** The allowlisted environment a session gets for its shell, without the server's auth. */
  workerEnv?: Record<string, string>
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
    readonly client: OpenCodeClient,
    readonly info: ServerInfo,
    private readonly proc?: ChildProcess,
  ) {
    this.events.setMaxListeners(0)
    proc?.once("exit", () => this.markDead())
    this.isolateSessions()
    void this.pump()
  }

  /**
   * OpenCode runs the shell tool with the session's environment when it has one, else the server's
   * (which carries OPENCODE_SERVER_PASSWORD). Give every session this process creates the
   * allowlisted environment before it is used, and the same to the subagent sessions it spawns,
   * so a worker's shell never inherits the server's password or our own shell's secrets.
   */
  private isolateSessions() {
    const workerEnv = this.info.workerEnv
    if (!workerEnv) return
    const owned = new Set<string>()
    const set = (sessionID: string) => this.client.session.environment({ sessionID, variables: workerEnv }, { signal: AbortSignal.timeout(30_000) })
    const create = this.client.session.create.bind(this.client.session)
    this.client.session.create = async (...args: Parameters<typeof create>) => {
      const session = await create(...args)
      owned.add(session.id)
      await set(session.id)
      return session
    }
    // Subagents are created by OpenCode itself, not through our client: cover a session whose
    // parent we already own as soon as its creation event arrives (best effort).
    this.events.on("event", (e) => {
      const raw = e as { type?: string; data?: { sessionID?: unknown; parentID?: unknown } }
      if (raw.type !== "session.created") return
      const { sessionID, parentID } = raw.data ?? {}
      if (typeof sessionID !== "string" || typeof parentID !== "string" || !owned.has(parentID) || owned.has(sessionID)) return
      owned.add(sessionID)
      void set(sessionID).catch(() => undefined)
    })
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
      const env = serverEnv({ username: config.username, password: config.password, passEnv: config.passEnv })
      return Backend.ready(
        client,
        {
          url: config.url,
          mode: "attached",
          key: config.url,
          version,
          username: config.username,
          password: config.password,
          warnings,
          workerEnv: workerEnvironment(env),
        },
        config,
      )
    }

    if (config.serverMode === "shared") {
      const bin = resolveBinary(config.bin)
      const { client, info } = await store.lock("server", async (): Promise<{ client: OpenCodeClient; info: ServerInfo }> => {
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
            // The record's version is the binary the server was started with; warn once when the
            // configured binary is now a different version (a plugin or OpenCode upgrade).
            const versionWarning = versionMismatch(known.version, await binaryVersion(bin))
            const env = serverEnv({ username, password: known.password, passEnv: config.passEnv })
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
                versionWarning,
                workerEnv: workerEnvironment(env),
              },
            }
          }
          // The record's server answers but not with our password, reset the connection, or hung.
          // If its pid is still our `opencode serve` on the recorded port, stop it before starting
          // a new one, so it does not linger as an orphan nothing can stop or attach to.
          if (isOurSharedServer(known)) {
            await stopPid(known.pid, known.url)
            forgetShared(store, known)
          } else if (probe.reachable) {
            throw new Error(
              `The recorded shared OpenCode server at ${known.url} (pid ${known.pid}) answers but is not usable: ${probe.reason}. ` +
                "Check OPENCODE_SERVER_USERNAME/PASSWORD, or stop it with opencode_server stop.",
            )
          } else if (probe.timedOut && pidAlive(known.pid)) {
            throw new Error(
              `The recorded shared OpenCode server at ${known.url} (pid ${known.pid}) is not responding. Stop it with opencode_server stop, then retry.`,
            )
          } else {
            forgetShared(store, known) // gone: start a new one
          }
        }
        // A fresh password per server, never the one this process was started with: our own
        // OPENCODE_SERVER_PASSWORD is a secret, and reusing it would hand it to every worker shell.
        const password = randomBytes(24).toString("hex")
        const env = serverEnv({ username: config.username, password, passEnv: config.passEnv })
        const { url, pid } = await spawnShared(config, store.dir, password, env)
        const client = connect(url, config.username, password)
        const version = await health(client, url)
        const record: ServerRecord = { url, password, pid, startedAt: Date.now(), bin: bin.command, version, username: config.username }
        store.setServer(record)
        return {
          client,
          info: {
            url,
            mode: "shared" as const,
            key: "local",
            version,
            username: config.username,
            password,
            pid,
            warnings,
            workerEnv: workerEnvironment(env),
          },
        }
      })
      info.passwordFile = writePasswordFile(passwordFilePath(store.dir, "shared", info.url), info.password!)
      return Backend.ready(client, info, config)
    }

    // A fresh password, as above: the parent's OPENCODE_SERVER_PASSWORD is for attaching, not for
    // the server we spawn.
    const password = randomBytes(24).toString("hex")
    const env = serverEnv({ username: config.username, password, passEnv: config.passEnv })
    const { url, proc } = await spawnPrivate(config, env)
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
        workerEnv: workerEnvironment(env),
      },
      config,
      proc,
    )
  }

  private static async ready(client: OpenCodeClient, info: ServerInfo, config: Config, proc?: ChildProcess) {
    const [major, minor] = info.version.split(".").map(Number)
    if (info.version !== "unknown" && (major !== TESTED_OPENCODE.major || minor !== TESTED_OPENCODE.minor)) {
      info.warnings.push(`opencode ${info.version} is untested (tested: ${TESTED_OPENCODE.major}.${TESTED_OPENCODE.minor}.x); report issues.`)
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
        // A stream that ends without delivering anything counts as a failure, like a refused connection.
        for await (const event of this.client.event.subscribe({ signal: this.abort.signal })) {
          if (this.closed) return
          if (!received) {
            received = true
            this.streaming = true
            backoff = 250
            failures = 0
          }
          try {
            this.events.emit("event", event)
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
    // A server that times out while its pid lives is ours, hung: the record's URL was its port.
    const hung = !probe.ok && probe.timedOut && pidAlive(known.pid)
    // A pid that is still our `opencode serve` on the recorded port is ours even when it answers
    // with the wrong password or reset the connection: kill it rather than leave an orphan.
    const ours = !probe.ok && isOurSharedServer(known)
    if (!probe.ok && !hung && !ours) {
      forgetShared(store, known)
      return `The recorded shared server (${known.url}, pid ${known.pid}) is not answering with its password (${probe.reason || "no answer"}), so nothing was killed (the pid may belong to another process now). The record was cleared.`
    }
    // Stop the process before dropping the record, so the password file survives until it is dead.
    await stopPid(known.pid, known.url)
    forgetShared(store, known)
    const left = pidAlive(known.pid) ? ` Warning: pid ${known.pid} is still alive; kill it by hand.` : ""
    if (hung) {
      return `The shared OpenCode server (pid ${known.pid}, ${known.url}) was not responding, so it was killed and its record cleared. Running agents were stopped with it.${left}`
    }
    if (!probe.ok) {
      return `The shared OpenCode server (pid ${known.pid}, ${known.url}) was not answering with its password (${probe.reason || "no answer"}), so it was killed and its record cleared. Running agents were stopped with it.${left}`
    }
    return `Stopped the shared OpenCode server (pid ${known.pid}, ${known.url}). Running agents were stopped with it.${left}`
  })
}

/** Drop the shared-server record and its password file. */
function forgetShared(store: Store, known: ServerRecord) {
  store.setServer(undefined)
  fs.rmSync(passwordFilePath(store.dir, "shared", known.url), { force: true })
}

/** The recorded pid's command line (arguments), or undefined when it cannot be read. */
function processArgs(pid: number): string[] | undefined {
  if (isWindows) return undefined
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean)
  } catch {
    return undefined
  }
}

/** Whether the recorded pid is still our `opencode serve` on the recorded port. */
function isOurSharedServer(known: ServerRecord): boolean {
  if (!pidAlive(known.pid)) return false
  const args = processArgs(known.pid)
  if (args === undefined) return true // cannot read the command line (macOS): the pid check is all we have
  const port = String(new URL(known.url).port)
  return args.includes("serve") && args.includes("--port") && args.includes(port)
}

/**
 * Stop the transient scope a shared server runs in. The recorded pid is opencode itself, not its
 * process-group leader, so killTree cannot reach the tool shells, LSPs and MCP servers it started;
 * stopping the scope stops every process in it. Missing systemd support and failures are ignored.
 */
function stopScope(url: string | undefined) {
  if (isWindows || !url || !scopeAvailable({ ...process.env, HORDE_SCOPE: "on" })) return
  const port = new URL(url).port
  if (!port) return
  try {
    spawnSync("systemctl", ["--user", "stop", `horde-opencode-${port}.scope`], { stdio: "ignore", timeout: 5_000 })
  } catch {
    // No user manager or no such scope: the pid signal above is all we can do.
  }
}

/** Stop a pid (SIGTERM, then SIGKILL after a grace period), and its scope, waiting for it to exit. */
async function stopPid(pid: number, url?: string): Promise<void> {
  killTree(pid, true)
  stopScope(url)
  const deadline = Date.now() + 5_000
  while (pidAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  if (pidAlive(pid) && !isWindows) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
}

/** Whether the recorded shared server answers with its password; never starts one. */
export async function sharedServerAlive(config: Config, known: ServerRecord, timeoutMs = 2_000): Promise<boolean> {
  return (await probeHealth(connect(known.url, known.username ?? config.username, known.password), timeoutMs)).ok
}

export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "")
  if (h === "localhost" || h === "::1") return true
  return net.isIPv4(h) && h.startsWith("127.")
}

function connect(url: string, username: string, password?: string): OpenCodeClient {
  const headers: Record<string, string> = {}
  if (password) headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  return OpenCode.make({ baseUrl: url, headers })
}

interface Probe {
  ok: boolean
  version: string
  /** Something answered HTTP at that address. */
  reachable: boolean
  timedOut: boolean
  reason: string
}

async function probeHealth(client: OpenCodeClient, timeoutMs = 5_000): Promise<Probe> {
  try {
    const info = await client.server.info({ signal: AbortSignal.timeout(timeoutMs) })
    if (typeof info?.version === "string") return { ok: true, version: info.version, reachable: true, timedOut: false, reason: "" }
    return { ok: false, version: "", reachable: true, timedOut: false, reason: "not an OpenCode 2 server (no version in /api/info)" }
  } catch (err) {
    const e = err as { name?: string; reason?: string; cause?: unknown }
    // The client throws a ClientError for transport failures and undeclared statuses, and the
    // server's own tagged error (e.g. UnauthorizedError) for declared ones.
    const transport = e.name === "ClientError" && e.reason === "Transport"
    return {
      ok: false,
      version: "",
      reachable: !transport,
      timedOut: transport && isTimeout(e.cause),
      reason: e.name === "UnauthorizedError" ? "unauthorized (wrong OPENCODE_SERVER_PASSWORD or USERNAME?)" : describe(err),
    }
  }
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: string } | undefined)?.name
  return name === "TimeoutError" || name === "AbortError" || /timed? ?out|aborted due to timeout/i.test(describe(err))
}

async function health(client: OpenCodeClient, url: string): Promise<string> {
  const probe = await probeHealth(client)
  if (!probe.ok) throw new Error(`OpenCode server at ${url} is not reachable: ${probe.reason}`)
  return probe.version
}

async function waitForCatalog(client: OpenCodeClient, directory: string) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const res = await client.agent.list({ location: { directory } }, { signal: AbortSignal.timeout(5_000) }).catch(() => undefined)
    if (res?.data.length) return
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

const LISTENING = /server listening on\s+(https?:\/\/\S+)/
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

/**
 * The environment `opencode serve` is started with, and so the environment every worker shell
 * inherits. Built from an allowlist, never from `...process.env`: this MCP server's own shell
 * carries credentials (Claude Code's messaging token/socket and session id, provider API keys,
 * the OPENCODE_SERVER_PASSWORD it attaches with) that a worker must not see. The board CLI a
 * worker runs needs none of these: its state directory is passed through the brief's `--state`.
 */
export function serverEnv(
  opts: { username: string; password?: string; passEnv?: string[] },
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): Record<string, string | undefined> {
  const kept: Record<string, string | undefined> = {}
  const always = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|TZ|TMPDIR|TEMP|TMP)$/
  const proxyAndTls = /^(HTTPS?_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/i
  const windows = /^(SystemRoot|ComSpec|APPDATA|LOCALAPPDATA|USERPROFILE)$/
  const pass = (opts.passEnv ?? []).map(
    (p) =>
      new RegExp(
        `^${p
          .split("*")
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
      ),
  )
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    // The server's auth is added back below with the values it was started with, never ours.
    if (name === "OPENCODE_SERVER_PASSWORD" || name === "OPENCODE_SERVER_USERNAME") continue
    if (
      always.test(name) ||
      proxyAndTls.test(name) ||
      name.startsWith("LC_") ||
      name.startsWith("XDG_") ||
      name.startsWith("OPENCODE_") ||
      (platform === "win32" && windows.test(name)) ||
      pass.some((re) => re.test(name))
    ) {
      kept[name] = value
    }
    // Everything else is dropped: CLAUDE_*, HORDE_*, MCP_*, and any secret-looking name
    // (KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL) the user did not opt in via HORDE_OPENCODE_PASS_ENV.
  }
  kept.OPENCODE_SERVER_USERNAME = opts.username
  kept.OPENCODE_SERVER_PASSWORD = opts.password
  return kept
}

/** The shell environment a session gets: the allowlist without the server's auth. */
function workerEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && name !== "OPENCODE_SERVER_PASSWORD" && name !== "OPENCODE_SERVER_USERNAME") out[name] = value
  }
  return out
}

/**
 * The one-line warning when the shared server was started with a different OpenCode version than
 * the configured binary, or undefined when they match (or one is unknown).
 */
export function versionMismatch(serverVersion: string | undefined, configuredVersion: string | undefined): string | undefined {
  if (!serverVersion || !configuredVersion || serverVersion === configuredVersion) return undefined
  return `the shared OpenCode server runs ${serverVersion}, the configured binary is ${configuredVersion}; opencode_server stop then any call restarts it`
}

/** The bare "2.1.4" from `opencode --version` output ("opencode v2.1.4"). */
function parseVersion(output: string | undefined): string | undefined {
  return /(\d+\.\d+(?:\.\d+)?)/.exec(output ?? "")?.[1]
}

/** The configured binary's version, read once per reconnect (cheap: `opencode --version`). */
function binaryVersion(bin: { command: string; shell: boolean }): string | undefined {
  try {
    const res = spawnSync(bin.command, ["--version"], { shell: bin.shell, encoding: "utf8" })
    return parseVersion(res.stdout)
  } catch {
    return undefined
  }
}

function serveArgs(port: number) {
  return ["serve", "--hostname", "127.0.0.1", "--port", String(port)]
}

/** Quote one argument for the /bin/sh -c wrapper that records the server's pid. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Write our own pid before exec'ing the server, so systemd-run's pid is not the one recorded. */
function pidCommand(pidFile: string, command: string[]): string[] {
  return ["/bin/sh", "-c", `echo $$ > ${shellQuote(pidFile)}; exec ${command.map(shellQuote).join(" ")}`]
}

/** The wrapper's pid; systemd-run execs it, so its own pid is the same when the file is late. */
async function scopedPid(proc: ChildProcess, pidFile: string): Promise<number> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      const pid = Number(fs.readFileSync(pidFile, "utf8").trim())
      if (Number.isInteger(pid) && pid > 0) {
        fs.rmSync(pidFile, { force: true })
        return pid
      }
    } catch {
      // Not written yet.
    }
    if (proc.exitCode !== null || proc.signalCode !== null) break
    await new Promise((r) => setTimeout(r, 20))
  }
  fs.rmSync(pidFile, { force: true })
  return proc.pid!
}

/** A detached server that outlives this process; its output goes to a log file. */
async function spawnShared(config: Config, stateDir: string, password: string, env: Record<string, string | undefined>): Promise<{ url: string; pid: number }> {
  const logPath = path.join(stateDir, "opencode-server.log")
  let lastError: Error | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort()
    const log = fs.openSync(logPath, "w", 0o600)
    const bin = resolveBinary(config.bin)
    // The Claude Code session must not be the scope that owns the horde's builds: a systemd user
    // scope keeps the server and its memory out of the terminal scope systemd-oomd would kill.
    const scoped = config.scope !== false && scopeAvailable(process.env)
    const pidFile = path.join(stateDir, `server-${port}.pid`)
    const command = [bin.command, ...serveArgs(port)]
    if (scoped) fs.rmSync(pidFile, { force: true })
    const launch = scoped
      ? scopeCommand(pidCommand(pidFile, command), { unit: `horde-opencode-${port}`, memoryHigh: config.memoryHigh, available: true })
      : { command: bin.command, args: serveArgs(port) }
    const proc = spawn(launch.command, launch.args, {
      cwd: workingDir(config),
      env,
      stdio: ["ignore", log, log],
      detached: true,
      windowsHide: true,
      shell: scoped ? false : bin.shell,
    })
    fs.closeSync(log)
    proc.unref()
    const pid = scoped ? await scopedPid(proc, pidFile) : proc.pid!
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
          killTree(pid, true)
          reject(new Error(`Timed out waiting for \`${config.bin} serve\`; see ${logPath}`))
        })()
      })
      return { url, pid }
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
async function spawnPrivate(config: Config, env: Record<string, string | undefined>) {
  const port = await freePort()
  // Built: supervisor.js next to this file. From source (tsx): supervisor.ts with our loader flags.
  const js = fileURLToPath(new URL("./supervisor.js", import.meta.url))
  const supervisor = fs.existsSync(js) ? [js] : [...process.execArgv, fileURLToPath(new URL("./supervisor.ts", import.meta.url))]
  const proc = spawn(process.execPath, [...supervisor, String(process.pid), resolveBinary(config.bin).command, ...serveArgs(port)], {
    // Our own directory, so loader flags resolve; the supervisor starts OpenCode in the agent directory.
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    // The supervisor runs the private server in a scope: the Claude Code session must not own the
    // horde's builds (its cgroup is the one systemd-oomd kills when page cache grows).
    env: {
      ...env,
      HORDE_SUPERVISED_CWD: workingDir(config),
      HORDE_SCOPE: config.scope === false ? "off" : "on",
      ...(config.memoryHigh ? { HORDE_MEMORY_HIGH: config.memoryHigh } : {}),
    },
    // stdin stays open as a lifeline: the supervisor stops OpenCode when it closes.
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // Its own group, so a kill of our group misses it and it can stop OpenCode after we die.
    detached: !isWindows,
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
