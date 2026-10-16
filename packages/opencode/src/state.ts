import fs from "node:fs"
import path from "node:path"
import type { PermissionPolicy } from "./config.js"
import type { Worktree } from "./worktree.js"

export interface Limits {
  maxSteps?: number
  maxCostUsd?: number
  timeoutMinutes?: number
}

/** What this server remembers about an agent, persisted across restarts. */
export interface AgentRecord {
  id: string
  name?: string
  /** Server the session lives on, so stale records from another server are ignored. */
  server: string
  directory: string
  policy: PermissionPolicy
  questions: "user" | "ask" | "dismiss"
  worktree?: Worktree
  limits: Limits
  /** Agent profile file we generated for this agent (removed on dispose). */
  agentFile?: string
  createdAt: number
  /** Finished turns starting at or before this history seq have been reported to the caller. */
  reportedSeq: number
  /** When the caller last received this agent's news. */
  reportedAt?: number
  /** When we interrupted the agent while it was running. */
  interruptedAt?: number
  /** Why the server stopped the agent on its own (limit reached, …). */
  stopReason?: string
  /** Interrupt once the current step finishes. */
  pauseAfterStep?: boolean
}

export interface ServerRecord {
  url: string
  password: string
  pid: number
  startedAt: number
}

interface StateFile {
  version: 1
  server?: ServerRecord
  agents: Record<string, AgentRecord>
}

/** A small JSON store; writes are atomic and private to the user. */
export class Store {
  private data: StateFile
  private readonly file: string

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.file = path.join(dir, "state.json")
    this.data = this.read()
  }

  private read(): StateFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as StateFile
      if (parsed.version === 1 && parsed.agents) return parsed
    } catch {
      // Missing or corrupt: start fresh.
    }
    return { version: 1, agents: {} }
  }

  /** Re-read from disk so concurrent MCP processes see each other's agents. */
  reload() {
    this.data = this.read()
  }

  private write() {
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  get server(): ServerRecord | undefined {
    return this.data.server
  }

  setServer(server: ServerRecord | undefined) {
    this.reload()
    this.data.server = server
    this.write()
  }

  agents(server: string): AgentRecord[] {
    return Object.values(this.data.agents).filter((a) => a.server === server)
  }

  get(id: string): AgentRecord | undefined {
    return this.data.agents[id]
  }

  put(record: AgentRecord) {
    this.reload()
    this.data.agents[record.id] = record
    this.write()
  }

  update(id: string, patch: Partial<AgentRecord>) {
    this.reload()
    const current = this.data.agents[id]
    if (!current) return
    this.data.agents[id] = { ...current, ...patch }
    this.write()
  }

  remove(id: string) {
    this.reload()
    delete this.data.agents[id]
    this.write()
  }

  /** Simple cross-process lock (used while starting the shared server). */
  async lock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const lockFile = path.join(this.dir, `${name}.lock`)
    const deadline = Date.now() + 60_000
    for (;;) {
      try {
        fs.writeFileSync(lockFile, String(process.pid), { flag: "wx" })
        break
      } catch {
        const age = Date.now() - (fs.statSync(lockFile, { throwIfNoEntry: false })?.mtimeMs ?? 0)
        if (age > 60_000) fs.rmSync(lockFile, { force: true })
        else if (Date.now() > deadline) throw new Error(`timed out waiting for ${lockFile}`)
        else await new Promise((r) => setTimeout(r, 200))
      }
    }
    try {
      return await fn()
    } finally {
      fs.rmSync(lockFile, { force: true })
    }
  }
}
