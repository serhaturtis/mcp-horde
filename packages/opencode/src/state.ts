import fs from "node:fs"
import path from "node:path"
import { SELF as PROCESS, pidAlive, readJson, withLock, writeAtomic } from "@mcp-horde/core"
import type { PermissionPolicy } from "./config.js"
import type { Worktree } from "./worktree.js"

export interface Limits {
  maxSteps?: number
  maxCostUsd?: number
  timeoutMinutes?: number
}

/** The MCP process that drives an agent (applies its policies, limits, dialogs and pushes). */
export interface Owner {
  pid: number
  host: string
  /** Random per-process token, so a reused PID is not mistaken for the owner. */
  token: string
}

/** Mechanical checks run when the agent finishes a turn (see @mcp-horde/verify). */
export interface GateConfig {
  /** Check names to run (default: all detected or configured). */
  checks?: string[]
  /** Audit the agent's diff (default: on in a worktree, off in a shared directory). */
  audit: boolean
  /** Scope globs (repo-relative) for the audit. */
  allowed?: string[]
  /** Gate runs per task before the failure is reported (each failure is sent back to the agent first). */
  maxRounds: number
  /** Run only the tests related to the agent's changes when that is safe (default true; absent in older records). */
  related?: boolean
  /** Audit base outside a worktree: HEAD when the agent was spawned. */
  base?: string
}

export interface GateState {
  /** Gate runs since the last instruction from the caller. */
  round: number
  verdict?: {
    /** Start seq of the turn this verdict judged. */
    turn: number
    pass: boolean
    /** No more rounds: this verdict is the result. */
    final: boolean
    text: string
    at: number
  }
}

/** What this server remembers about an agent, persisted across restarts. */
export interface AgentRecord {
  id: string
  name?: string
  /** Stable identity of the OpenCode server the session lives on ("local" for managed servers). */
  server: string
  directory: string
  policy: PermissionPolicy
  questions: "user" | "ask" | "dismiss"
  worktree?: Worktree
  limits: Limits
  /** Agent profile file we generated for this agent (removed on dispose). */
  agentFile?: string
  createdAt: number
  owner?: Owner
  /** Finished turns starting at or before this history seq have been reported to the caller. */
  reportedSeq: number
  /** When the caller last received this agent's news. */
  reportedAt?: number
  /** Set while an adopted session's history has not been read yet. */
  adoptPending?: boolean
  /** History seq at the time we interrupted the agent; superseded by any later prompt. */
  interruptedSeq?: number
  /** Why the agent was stopped (interrupt reason, limit reached, …). */
  stopReason?: string
  /** Interrupt once the current step finishes. */
  pauseAfterStep?: boolean
  gate?: GateConfig
  gateState?: GateState
}

export interface ServerRecord {
  url: string
  password: string
  pid: number
  startedAt: number
  /** Binary and version the server was started with, to warn about upgrades. */
  bin?: string
  version?: string
}

/** This process, as an agent owner. */
export const SELF: Owner = { ...PROCESS }

/** Whether the owner process is still running (on this host). */
export function ownerAlive(owner: Owner | undefined): boolean {
  if (!owner) return false
  if (owner.token === SELF.token) return true
  if (owner.host !== SELF.host) return true // cannot check another host; assume alive
  return pidAlive(owner.pid)
}

/**
 * Persistent state: one file per agent (so concurrent MCP processes never
 * overwrite each other's records), plus the shared-server record.
 */
export class Store {
  private readonly agentsDir: string
  private readonly serverFile: string

  constructor(readonly dir: string) {
    this.agentsDir = path.join(dir, "agents")
    this.serverFile = path.join(dir, "server.json")
    fs.mkdirSync(this.agentsDir, { recursive: true, mode: 0o700 })
    this.migrate()
  }

  /** Version 0.2 kept everything in one state.json keyed by server URL. */
  private migrate() {
    const legacy = path.join(this.dir, "state.json")
    const old = readJson<{ server?: ServerRecord; agents?: Record<string, AgentRecord & { interruptedAt?: number }> }>(legacy)
    if (!old) return
    if (old.server && !fs.existsSync(this.serverFile)) writeAtomic(this.serverFile, JSON.stringify(old.server, null, 2))
    for (const r of Object.values(old.agents ?? {})) {
      const file = this.agentFile(r.id)
      if (fs.existsSync(file)) continue
      const { interruptedAt: _drop, ...rest } = r
      const server = /^https?:\/\/(127\.|localhost)/.test(r.server) ? "local" : r.server
      writeAtomic(file, JSON.stringify({ ...rest, server }, null, 2))
    }
    fs.renameSync(legacy, `${legacy}.migrated`)
  }

  private agentFile(id: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`invalid session id "${id}"`)
    return path.join(this.agentsDir, `${id}.json`)
  }

  // ------------------------------------------------------------- agents

  agents(server: string): AgentRecord[] {
    const out: AgentRecord[] = []
    for (const f of fs.readdirSync(this.agentsDir)) {
      if (!f.endsWith(".json")) continue
      const r = readJson<AgentRecord>(path.join(this.agentsDir, f))
      if (r?.id && r.server === server) out.push(r)
    }
    return out
  }

  get(id: string): AgentRecord | undefined {
    return readJson<AgentRecord>(this.agentFile(id))
  }

  put(record: AgentRecord) {
    writeAtomic(this.agentFile(record.id), JSON.stringify(record, null, 2))
  }

  /** Merge a patch into the stored record (only its owner writes it, so there is no race). */
  update(id: string, patch: Partial<AgentRecord>) {
    const current = this.get(id)
    if (!current) return
    const next = { ...current, ...patch }
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (next as Record<string, unknown>)[k]
    this.put(next)
  }

  remove(id: string) {
    fs.rmSync(this.agentFile(id), { force: true })
  }

  // ------------------------------------------------------------- server

  get server(): ServerRecord | undefined {
    return readJson<ServerRecord>(this.serverFile)
  }

  setServer(server: ServerRecord | undefined) {
    if (server) writeAtomic(this.serverFile, JSON.stringify(server, null, 2))
    else fs.rmSync(this.serverFile, { force: true })
  }

  // ------------------------------------------------------------- locking

  /**
   * Cross-process lock. The holder keeps the lock file fresh; a lock is only
   * taken over when its holder process is gone or it has not been refreshed
   * for 30 s. Release only removes our own lock.
   */
  lock<T>(name: string, fn: () => Promise<T>, timeoutMs = 120_000): Promise<T> {
    return withLock(this.dir, name, fn, timeoutMs)
  }
}
