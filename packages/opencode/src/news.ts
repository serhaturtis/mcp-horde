import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

export interface NewsWait {
  id: string
  title: string
  kind: "finished" | "needs you"
}

export interface NewsWork {
  id: string
  title: string
}

export interface NewsFile {
  pid: number
  at: number
  waiting: NewsWait[]
  working: NewsWork[]
}

/** Rewrite an unchanged list at least this often, so the hook's 24 h rule never silences a waiting outcome. */
const HEARTBEAT_MS = 30 * 60_000
/** The session id names a file: a path or ".." would escape the news directory. */
const SESSION_ID = /^[A-Za-z0-9_-]+$/

/**
 * The news file a Claude Code hook reads instead of asking the server: one per Claude Code
 * session, named by the CLAUDE_CODE_SESSION_ID that Claude Code gives its MCP servers.
 * Without that variable (another client, or a bare server) nothing is written.
 */
export class News {
  private readonly file?: string
  private readonly heartbeatMs: number
  /** The last content written (without `at`), so an unchanged list is not rewritten before the heartbeat. */
  private last?: string
  /** When the file was last written (or queued), for the heartbeat. */
  private written = 0
  private waiting: NewsWait[] = []
  private working: NewsWork[] = []
  private timer?: NodeJS.Timeout
  /** Writes are serialised, so an older snapshot can never rename over a newer one. */
  private writes: Promise<void> = Promise.resolve()

  constructor(stateDir: string, session = process.env.CLAUDE_CODE_SESSION_ID?.trim(), opts: { heartbeatMs?: number } = {}) {
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS
    if (session && SESSION_ID.test(session)) this.file = path.join(stateDir, "news", `${session}.json`)
  }

  /** A fresh server for this session replaces the file an earlier one left behind. */
  async clear(): Promise<void> {
    if (!this.file) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.last = undefined
    this.written = 0
    this.waiting = []
    this.working = []
    const file = this.file
    this.writes = this.writes
      .catch(() => undefined)
      .then(() => fs.rm(file, { force: true }))
      .catch(() => undefined)
    await this.writes
  }

  /**
   * Publish the current lists. Atomic (temp file in the same directory, then rename), because a
   * hook may read at any moment; an unchanged list is refreshed after the heartbeat instead.
   */
  update(waiting: NewsWait[], working: NewsWork[]): void {
    if (!this.file) return
    this.waiting = waiting
    this.working = working
    const key = JSON.stringify([waiting, working])
    if (key === this.last && Date.now() - this.written < this.heartbeatMs) {
      this.arm()
      return
    }
    this.enqueue(key)
  }

  /** Remove the file when the server deliberately stops; a restart keeps it (close-for-restart). */
  remove(): Promise<void> {
    return this.clear()
  }

  private enqueue(key: string) {
    const file = this.file
    if (!file) return
    this.last = key
    this.written = Date.now()
    const waiting = this.waiting
    const working = this.working
    this.writes = this.writes
      .catch(() => undefined)
      .then(async () => {
        const body = JSON.stringify({ pid: process.pid, at: Date.now(), waiting, working })
        const dir = path.dirname(file)
        await fs.mkdir(dir, { recursive: true, mode: 0o700 })
        const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
        try {
          await fs.writeFile(tmp, body, { mode: 0o600 })
          await fs.rename(tmp, file)
        } catch (err) {
          await fs.rm(tmp, { force: true }).catch(() => undefined)
          throw err
        }
      })
      .catch(() => {
        // Best effort: the reminder is useful, but it must never break a tool call. Retry on the
        // next update instead of treating this content as written.
        if (this.last === key) {
          this.last = undefined
          this.written = 0
        }
      })
    this.arm()
  }

  /** Rewrite the same lists after the heartbeat, while there is something for the hook to read. */
  private arm() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.file || (!this.waiting.length && !this.working.length)) return
    const delay = Math.max(0, this.written + this.heartbeatMs - Date.now())
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.enqueue(JSON.stringify([this.waiting, this.working]))
    }, delay)
    this.timer.unref()
  }
}
