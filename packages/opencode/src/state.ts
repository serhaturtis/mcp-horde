import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { SELF as PROCESS, pidAlive, readJson, sleepSync, withLock, writeAtomic } from "@mcp-horde/core"
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
  /**
   * Gate runs per instruction, the first one included. A failing run with rounds left is sent
   * back to the agent to fix (so there are at most maxRounds − 1 fix rounds); the failure of the
   * last run is the result.
   */
  maxRounds: number
  /** Run only the tests related to the agent's changes when that is safe (default true; absent in older records). */
  related?: boolean
  /** Audit base outside a worktree: HEAD when the agent was spawned. */
  base?: string
  /** Once the checks pass, review the change against the task's acceptance criteria (task-bound agents). */
  review?: boolean
}

/** A gate's review of a task's change: per criterion, what the reviewer decided. */
export interface ReviewSummary {
  model: string
  cost: number
  total: number
  met: number
  notMet: { n: number; text: string; note: string }[]
  unclear: { n: number; text: string; note: string }[]
  /** Why there is no review (it could not run); the checks' verdict stands. */
  error?: string
}

export interface GateState {
  /** Gate runs since the last instruction from the caller. */
  round: number
  /**
   * Start seq of a turn whose gate was superseded (the tree changed under it by a sync or a
   * revert): it is not gated again; the next turn is.
   */
  superseded?: number
  verdict?: {
    /** Start seq of the turn this verdict judged. */
    turn: number
    pass: boolean
    /** No more rounds: this verdict is the result. */
    final: boolean
    text: string
    at: number
    /** The checks that ran, one line each, for compact outcomes. */
    checks?: { name: string; pass: boolean; summary: string; baseline?: { label: string; pass: boolean; known: number } }[]
    review?: ReviewSummary
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
  createdAt: number
  owner?: Owner
  /** When the owner last confirmed it is alive (its heartbeat); a stale one means a dead owner. */
  ownerSeen?: number
  /** Not spawned by this server (e.g. started in the TUI): nothing is answered on a human's behalf. */
  adopted?: boolean
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
  /** Paths its edits are confined to (enforced by its profile). */
  scope?: { paths: string[]; outside?: "deny" | "ask" }
  /** The board task this agent works (opencode_spawn task). */
  task?: { id: string; title: string; attempt: number }
}

export interface ServerRecord {
  url: string
  password: string
  pid: number
  startedAt: number
  /** Binary and version the server was started with, to warn about upgrades. */
  bin?: string
  version?: string
  /** Basic-auth user the server was started with. */
  username?: string
}

/** This process, as an agent owner. */
export const SELF: Owner = { ...PROCESS }

/** An owner whose heartbeat is older than this is gone (or its PID was reused). */
export const OWNER_STALE_MS = 2 * 60_000

/**
 * Whether the owner process is still running. A record with a heartbeat (`seen`) is alive only
 * while the heartbeat is fresh, so a reused PID or a process on another host is not mistaken for
 * a live owner; older records fall back to the PID check (on this host).
 */
export function ownerAlive(owner: Owner | undefined, seen?: number, now = Date.now()): boolean {
  if (!owner) return false
  if (owner.token === SELF.token) return true
  if (seen !== undefined && now - seen > OWNER_STALE_MS) return false
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
    try {
      fs.renameSync(legacy, `${legacy}.migrated`)
    } catch (err) {
      // Another process may have migrated it between the read and the rename.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    }
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

  /**
   * Merge a patch into the stored record. Under the claim lock, so a claim cannot land between
   * our read and write; a record another process owns is left alone. Takes the lock for at most
   * 200 ms: persistence is best effort and a heartbeat retries later.
   */
  update(id: string, patch: Partial<AgentRecord>) {
    this.lockSync(
      "claim",
      () => {
        const current = this.get(id)
        if (!current) return
        if (current.owner && current.owner.token !== SELF.token) return
        const next = { ...current, ...patch }
        for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (next as Record<string, unknown>)[k]
        this.put(next)
      },
      200,
    )
  }

  remove(id: string) {
    fs.rmSync(this.agentFile(id), { force: true })
  }

  /**
   * Take a record over for `owner` if it is still claimable when re-read under the claim lock,
   * so two processes never both claim the same orphan. Undefined when it is not (any more).
   */
  claim(id: string, owner: Owner, claimable: (r: AgentRecord) => boolean): AgentRecord | undefined {
    return this.lockSync("claim", () => {
      const r = this.get(id)
      if (!r || !claimable(r)) return undefined
      const claimed = { ...r, owner, ownerSeen: Date.now() }
      this.put(claimed)
      return claimed
    })
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

  /**
   * The same lock (same file, same takeover rules), held synchronously for a short critical
   * section such as a read-check-write of one record. Throws when it cannot be had in time.
   */
  lockSync<T>(name: string, fn: () => T, timeoutMs = 1_000): T {
    const file = path.join(this.dir, `${name}.lock`)
    const mine = JSON.stringify({ pid: process.pid, host: PROCESS.host, token: randomBytes(8).toString("hex") })
    const deadline = Date.now() + timeoutMs
    for (;;) {
      try {
        fs.writeFileSync(file, mine, { flag: "wx", mode: 0o600 })
        break
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      }
      let content: string
      let age: number
      try {
        content = fs.readFileSync(file, "utf8")
        age = Date.now() - fs.statSync(file).mtimeMs
      } catch {
        continue // released between our attempts
      }
      let holder: { pid?: number; host?: string } | undefined
      try {
        holder = JSON.parse(content)
      } catch {
        holder = undefined
      }
      const dead = holder?.pid ? holder.host === PROCESS.host && !pidAlive(holder.pid) : age > 5_000
      if (dead || age > 30_000) {
        const tomb = `${file}.stale.${process.pid}.${randomBytes(4).toString("hex")}`
        try {
          fs.renameSync(file, tomb)
          if (fs.readFileSync(tomb, "utf8") === content) fs.rmSync(tomb, { force: true })
          else {
            // A fresh lock was moved by mistake: put it back unless someone took the lock meanwhile.
            try {
              fs.linkSync(tomb, file)
            } catch {
              // Taken meanwhile (or no hard links): the newer holder wins.
            }
            fs.rmSync(tomb, { force: true })
          }
        } catch {
          // Another contender took it over first.
        }
        continue
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${file} (held by ${content})`)
      sleepSync(20)
    }
    try {
      return fn()
    } finally {
      try {
        if (fs.readFileSync(file, "utf8") === mine) fs.rmSync(file, { force: true })
      } catch {
        // Already gone.
      }
    }
  }
}
