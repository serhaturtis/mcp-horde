import os from "node:os"
import path from "node:path"

/**
 * How permission requests (and questions) from an agent are handled.
 *   user  – ask the human through an MCP elicitation dialog (falls back to "ask"
 *           when the client does not support elicitation)
 *   ask   – surface them to the calling model as needs_input (opencode_respond)
 *   allow – approve automatically (questions are dismissed so the agent decides)
 *   deny  – reject automatically (questions are dismissed)
 */
export type PermissionPolicy = "user" | "ask" | "allow" | "deny"
export const POLICIES: readonly PermissionPolicy[] = ["user", "ask", "allow", "deny"]

export type ServerMode = "shared" | "private"

export interface Config {
  /** Attach to an already running `opencode serve` instead of managing one. */
  url?: string
  username: string
  password?: string
  /** Allow attaching to a non-loopback server without a password. */
  allowInsecure: boolean
  /** shared: one detached server reused across MCP restarts; private: one per MCP process. */
  serverMode: ServerMode
  /** Binary used when spawning `opencode serve`. */
  bin: string
  /** Default working directory for spawned agents. */
  directory: string
  defaultPermissions: PermissionPolicy
  /** Maximum number of agents running at the same time (0 = unlimited). */
  maxRunning: number
  /** Where agent metadata and the shared server record are stored. */
  stateDir: string
  /** Root for isolated worktrees. */
  worktreeDir: string
  /** Push a Claude Code channel notification whenever an agent settles. */
  channel: boolean
}

function policy(value: string | undefined): PermissionPolicy {
  if (!value) return "user"
  if ((POLICIES as readonly string[]).includes(value)) return value as PermissionPolicy
  throw new Error(`HORDE_OPENCODE_PERMISSIONS must be one of ${POLICIES.join("|")}, got "${value}"`)
}

function mode(value: string | undefined): ServerMode {
  if (!value || value === "shared") return "shared"
  if (value === "private") return "private"
  throw new Error(`HORDE_OPENCODE_SERVER must be shared or private, got "${value}"`)
}

function int(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${value}"`)
  return n
}

function bool(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes"
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = os.homedir()
  const stateHome = env.XDG_STATE_HOME || path.join(home, ".local", "state")
  const dataHome = env.XDG_DATA_HOME || path.join(home, ".local", "share")
  return {
    url: env.HORDE_OPENCODE_URL || undefined,
    username: env.OPENCODE_SERVER_USERNAME || "opencode",
    password: env.OPENCODE_SERVER_PASSWORD || undefined,
    allowInsecure: bool(env.HORDE_OPENCODE_ALLOW_INSECURE),
    serverMode: mode(env.HORDE_OPENCODE_SERVER),
    bin: env.HORDE_OPENCODE_BIN || "opencode",
    directory: path.resolve(env.HORDE_OPENCODE_DIRECTORY || process.cwd()),
    defaultPermissions: policy(env.HORDE_OPENCODE_PERMISSIONS),
    maxRunning: int(env.HORDE_OPENCODE_MAX_RUNNING, 8, "HORDE_OPENCODE_MAX_RUNNING"),
    stateDir: path.resolve(env.HORDE_OPENCODE_STATE_DIR || path.join(stateHome, "mcp-horde", "opencode")),
    worktreeDir: path.resolve(env.HORDE_OPENCODE_WORKTREE_DIR || path.join(dataHome, "mcp-horde", "worktrees")),
    channel: bool(env.HORDE_OPENCODE_CHANNEL),
  }
}
