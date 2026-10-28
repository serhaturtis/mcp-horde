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

/**
 * The news file a Claude Code hook reads instead of asking the server: one per Claude Code
 * session, named by the CLAUDE_CODE_SESSION_ID that Claude Code gives its MCP servers.
 * Without that variable (another client, or a bare server) nothing is written.
 */
export class News {
  private readonly file?: string
  /** The last content written (without `at`), so an unchanged list is not rewritten. */
  private last?: string
  /** Writes are serialised, so an older snapshot can never rename over a newer one. */
  private writes: Promise<void> = Promise.resolve()

  constructor(stateDir: string, session = process.env.CLAUDE_CODE_SESSION_ID?.trim()) {
    if (session) this.file = path.join(stateDir, "news", `${session}.json`)
  }

  /** A fresh server for this session replaces the file an earlier one left behind. */
  async clear(): Promise<void> {
    if (!this.file) return
    this.last = undefined
    const file = this.file
    this.writes = this.writes
      .catch(() => undefined)
      .then(() => fs.rm(file, { force: true }))
      .catch(() => undefined)
    await this.writes
  }

  /**
   * Publish the current lists. Atomic (temp file in the same directory, then rename), because a
   * hook may read at any moment; skipped when the lists did not change.
   */
  update(waiting: NewsWait[], working: NewsWork[]): void {
    if (!this.file) return
    const key = JSON.stringify([waiting, working])
    if (key === this.last) return
    this.last = key
    const file = this.file
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
        if (this.last === key) this.last = undefined
      })
  }

  /** Remove the file when the server stops; a crash leaves it naming a pid readers ignore. */
  remove(): Promise<void> {
    return this.clear()
  }
}
