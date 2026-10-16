import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import net from "node:net"
import { createOpencodeClient, type OpencodeClient, type V2Event } from "@opencode-ai/sdk/v2"
import type { Config } from "./config.js"

/** A connection to an OpenCode server, spawned by us or attached to. */
export class Backend {
  readonly events = new EventEmitter()
  private closed = false
  private abort = new AbortController()

  private constructor(
    readonly client: OpencodeClient,
    readonly url: string,
    private readonly proc?: ChildProcess,
  ) {
    this.events.setMaxListeners(0)
    void this.pump()
  }

  static async start(config: Config): Promise<Backend> {
    if (config.url) {
      const client = connect(config.url, config.username, config.password)
      await assertHealthy(client, config.url)
      return new Backend(client, config.url)
    }
    const password = config.password ?? randomBytes(24).toString("hex")
    const { url, proc } = await spawnServer(config.bin, config.directory, password)
    const client = connect(url, config.username, password)
    await assertHealthy(client, url)
    return new Backend(client, url, proc)
  }

  /** Follow the server-wide event stream, reconnecting until closed. */
  private async pump() {
    let backoff = 250
    while (!this.closed) {
      try {
        const sub = await this.client.v2.event.subscribe({ signal: this.abort.signal, sseMaxRetryAttempts: 1 })
        backoff = 250
        for await (const event of sub.stream) {
          if (this.closed) return
          this.events.emit("event", event as V2Event)
        }
      } catch {
        // Fall through to reconnect; waiters keep polling in the meantime.
      }
      if (this.closed) return
      await new Promise((r) => setTimeout(r, backoff))
      backoff = Math.min(backoff * 2, 5000)
    }
  }

  close() {
    this.closed = true
    this.abort.abort()
    if (this.proc && this.proc.exitCode === null) this.proc.kill("SIGTERM")
  }
}

function connect(url: string, username: string, password?: string): OpencodeClient {
  const headers: Record<string, string> = {}
  if (password) headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  return createOpencodeClient({ baseUrl: url, headers })
}

async function assertHealthy(client: OpencodeClient, url: string) {
  const res = await client.v2.health.get().catch((e: unknown) => ({ error: e, response: undefined }))
  if (res.error || !res.response?.ok) {
    throw new Error(`OpenCode server at ${url} is not healthy: ${describe(res.error) || res.response?.status}`)
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

async function spawnServer(bin: string, cwd: string, password: string) {
  const port = await freePort()
  const proc = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd,
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const killChild = () => {
    if (proc.exitCode === null) proc.kill("SIGTERM")
  }
  process.once("exit", killChild)

  const url = await new Promise<string>((resolve, reject) => {
    let output = ""
    const timer = setTimeout(() => {
      killChild()
      reject(new Error(`Timed out waiting for \`${bin} serve\` to start.\n${output}`))
    }, 30_000)
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      const match = output.match(/opencode server listening on\s+(https?:\/\/\S+)/)
      if (match?.[1]) {
        clearTimeout(timer)
        resolve(match[1])
      }
    }
    proc.stdout?.on("data", onData)
    proc.stderr?.on("data", onData)
    proc.once("error", (err) => {
      clearTimeout(timer)
      reject(new Error(`Failed to launch \`${bin}\`: ${err.message}. Install opencode or set HORDE_OPENCODE_BIN / HORDE_OPENCODE_URL.`))
    })
    proc.once("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`\`${bin} serve\` exited with code ${code}.\n${output}`))
    })
  })
  // Drain output so the child never blocks on a full pipe.
  proc.stdout?.resume()
  proc.stderr?.resume()
  return { url, proc }
}
