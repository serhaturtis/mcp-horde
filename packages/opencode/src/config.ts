import path from "node:path"

export type PermissionPolicy = "ask" | "allow" | "deny"

export interface Config {
  /** Attach to an already running `opencode serve` instead of spawning one. */
  url?: string
  username: string
  password?: string
  /** Binary used when spawning `opencode serve`. */
  bin: string
  /** Default working directory for spawned agents. */
  directory: string
  defaultModel?: string
  defaultVariant?: string
  defaultAgent?: string
  defaultPermissions: PermissionPolicy
}

function policy(value: string | undefined): PermissionPolicy {
  if (value === undefined || value === "") return "ask"
  if (value === "ask" || value === "allow" || value === "deny") return value
  throw new Error(`HORDE_OPENCODE_PERMISSIONS must be one of ask|allow|deny, got "${value}"`)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    url: env.HORDE_OPENCODE_URL || undefined,
    username: env.OPENCODE_SERVER_USERNAME || "opencode",
    password: env.OPENCODE_SERVER_PASSWORD || undefined,
    bin: env.HORDE_OPENCODE_BIN || "opencode",
    directory: path.resolve(env.HORDE_OPENCODE_DIRECTORY || process.cwd()),
    defaultModel: env.HORDE_OPENCODE_MODEL || undefined,
    defaultVariant: env.HORDE_OPENCODE_VARIANT || undefined,
    defaultAgent: env.HORDE_OPENCODE_AGENT || undefined,
    defaultPermissions: policy(env.HORDE_OPENCODE_PERMISSIONS),
  }
}
