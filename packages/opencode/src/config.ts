import os from "node:os"
import path from "node:path"
import { defaultWorktreeDir, loadHordeFile, loadUserHordeFile, memoryHigh, scopeEnabled } from "@mcp-horde/core"

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
  /** Where maxRunning came from, for error messages. */
  maxRunningFrom: string
  /** Where agent metadata and the shared server record are stored. */
  stateDir: string
  /** Root for isolated worktrees. */
  worktreeDir: string
  /** Push a Claude Code channel notification whenever an agent settles. */
  channel: boolean
  /** How long a permission/question dialog may stay open before the request goes to the calling model. */
  elicitTimeoutMs: number
  /** Names/globs of extra environment variables to pass to the backend (and its worker shells). */
  passEnv: string[]
  /** Run backends and checks in transient systemd user scopes; HORDE_SCOPE=off turns this off. */
  scope?: boolean
  /** HORDE_MEMORY_HIGH for those scopes (e.g. "32G", or a percentage); undefined sets no property. */
  memoryHigh?: string
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

function bool(value: string | undefined, name: string): boolean {
  const v = value?.trim().toLowerCase()
  if (!v) return false
  if (["1", "true", "yes", "on"].includes(v)) return true
  if (["0", "false", "no", "off"].includes(v)) return false
  throw new Error(`${name} must be a boolean (1/0, true/false, yes/no, on/off), got "${value}"`)
}

/**
 * The default running limit follows the machine: one task per two cores, capped at 8 so a big
 * host does not start a horde of its own, and at least 2 so a small one still runs a pair.
 */
export function defaultMaxRunning(cores: number): number {
  return Math.min(8, Math.max(2, Math.floor(cores / 2)))
}

/**
 * The running-agent limit: HORDE_OPENCODE_MAX_RUNNING, else horde.json `opencode.maxRunning`
 * (found from the default directory), else the user-level horde.json's, else the core count's.
 */
function maxRunning(env: NodeJS.ProcessEnv, directory: string, cores: number): { maxRunning: number; maxRunningFrom: string } {
  const fallback = defaultMaxRunning(cores)
  if (env.HORDE_OPENCODE_MAX_RUNNING)
    return { maxRunning: int(env.HORDE_OPENCODE_MAX_RUNNING, fallback, "HORDE_OPENCODE_MAX_RUNNING"), maxRunningFrom: "HORDE_OPENCODE_MAX_RUNNING" }
  const project = loadHordeFile(directory)
  const user = project.data.opencode === undefined ? loadUserHordeFile({ ...process.env, ...env }) : undefined
  const file = project.data.opencode === undefined ? user?.file : project.file
  const section = project.data.opencode === undefined ? user?.data.opencode : project.data.opencode
  if (section === undefined) return { maxRunning: fallback, maxRunningFrom: "default" }
  if (!section || typeof section !== "object" || Array.isArray(section)) throw new Error(`${file}: "opencode" must be an object`)
  const n = (section as Record<string, unknown>).maxRunning
  if (n === undefined) return { maxRunning: fallback, maxRunningFrom: "default" }
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new Error(`${file}: "opencode.maxRunning" must be a non-negative integer (0 = unlimited)`)
  return { maxRunning: n, maxRunningFrom: project.data.opencode === undefined ? `${file} opencode.maxRunning` : "horde.json opencode.maxRunning" }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: { cores?: number } = {}): Config {
  const home = os.homedir()
  const stateHome = env.XDG_STATE_HOME || path.join(home, ".local", "state")
  const directory = path.resolve(env.HORDE_OPENCODE_DIRECTORY || process.cwd())
  return {
    url: env.HORDE_OPENCODE_URL || undefined,
    username: env.OPENCODE_SERVER_USERNAME || "opencode",
    password: env.OPENCODE_SERVER_PASSWORD || undefined,
    allowInsecure: bool(env.HORDE_OPENCODE_ALLOW_INSECURE, "HORDE_OPENCODE_ALLOW_INSECURE"),
    serverMode: mode(env.HORDE_OPENCODE_SERVER),
    bin: env.HORDE_OPENCODE_BIN || "opencode",
    directory,
    defaultPermissions: policy(env.HORDE_OPENCODE_PERMISSIONS),
    ...maxRunning(env, directory, opts.cores ?? os.cpus().length),
    stateDir: path.resolve(env.HORDE_OPENCODE_STATE_DIR || path.join(stateHome, "mcp-horde", "opencode")),
    worktreeDir: defaultWorktreeDir(env),
    channel: bool(env.HORDE_OPENCODE_CHANNEL, "HORDE_OPENCODE_CHANNEL"),
    elicitTimeoutMs: int(env.HORDE_OPENCODE_DIALOG_TIMEOUT, 600, "HORDE_OPENCODE_DIALOG_TIMEOUT") * 1000,
    // Comma-separated names or globs (e.g. `*_API_KEY`) the backend passes through to `opencode serve`
    // and so to worker shells, on top of the fixed allowlist. Anything else secret-looking is dropped.
    passEnv: (env.HORDE_OPENCODE_PASS_ENV ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // The Claude Code session must not own the horde's builds: their page cache would make its
    // cgroup the one systemd-oomd kills. HORDE_SCOPE=off opts out; HORDE_MEMORY_HIGH is validated.
    scope: scopeEnabled(env),
    memoryHigh: memoryHigh(env),
  }
}

/**
 * Whether an agent belongs to the project rooted at `root`: its directory, or the main
 * checkout of its worktree, is inside it.
 */
export function inProject(record: { directory: string; worktree?: { repo: string } }, root: string): boolean {
  const within = (dir: string) => {
    const rel = path.relative(path.resolve(root), path.resolve(dir))
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  }
  return within(record.directory) || (record.worktree !== undefined && within(record.worktree.repo))
}
