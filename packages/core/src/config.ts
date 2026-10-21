import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * `horde.json` at a repository root holds project behaviour shared by every
 * horde server (checks, audit rules, tiers, …). Each package reads and
 * validates its own section; this only finds and parses the file.
 */
export interface HordeFile {
  /** Directory containing horde.json, or the search start when there is none. */
  root: string
  /** The file's path, when one was found. */
  file?: string
  data: Record<string, unknown>
}

/**
 * Look for horde.json from `directory` upwards, stopping at the repository
 * root (the first directory containing `.git`). Outside a repository only
 * `directory` itself is looked at, so an unrelated horde.json higher up (say in
 * the home directory) never applies. A malformed file throws: a silently
 * ignored typo in project rules is worse than an error.
 */
export function loadHordeFile(directory: string): HordeFile {
  const start = path.resolve(directory)
  const candidates: string[] = []
  for (let dir = start; ; ) {
    candidates.push(dir)
    const parent = path.dirname(dir)
    if (fs.existsSync(path.join(dir, ".git"))) break
    if (parent === dir) {
      candidates.splice(1)
      break
    }
    dir = parent
  }
  for (const dir of candidates) {
    const file = path.join(dir, "horde.json")
    if (!fs.existsSync(file)) continue
    let data: unknown
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"))
    } catch (err) {
      throw new Error(`${file} is not valid JSON: ${(err as Error).message}`)
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${file} must contain a JSON object`)
    return { root: dir, file, data: data as Record<string, unknown> }
  }
  return { root: start, data: {} }
}

declare const HORDE_VERSION: string | undefined

/**
 * The running package's version: baked in by the plugin bundler (`HORDE_VERSION`), else
 * read from the package.json next to the module's directory.
 */
export function packageVersion(moduleUrl: string): string {
  if (typeof HORDE_VERSION === "string") return HORDE_VERSION
  try {
    return (JSON.parse(fs.readFileSync(new URL("../package.json", moduleUrl), "utf8")) as { version: string }).version
  } catch {
    return "0.0.0"
  }
}

/**
 * The user-level horde.json: `$XDG_CONFIG_HOME/mcp-horde/horde.json`, or
 * `~/.config/mcp-horde/horde.json` when XDG_CONFIG_HOME is unset. Only `tiers`
 * and `opencode` apply from it, and only where the repository's file leaves
 * them unset; everything else describes a project. A malformed file throws.
 */
export function loadUserHordeFile(env: NodeJS.ProcessEnv = process.env): { file: string; data: Record<string, unknown> } {
  const home = env.HOME || os.homedir()
  const file = path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "mcp-horde", "horde.json")
  if (!fs.existsSync(file)) return { file, data: {} }
  let data: unknown
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`)
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${file} must contain a JSON object`)
  return { file, data: data as Record<string, unknown> }
}

/** One model tier: what a task at this tier runs on. Tier 0 is the cheapest. */
export interface Tier {
  /** "provider/model", as opencode_models lists it. */
  model: string
  /** Effort variant, e.g. "high". */
  variant?: string
}

/**
 * `horde.json` → `tiers`: the models tasks run on, cheapest first. A task's tier indexes
 * this list; escalating a task moves it to the next one. Past the last tier, the
 * orchestrator does the work itself. Empty when there is no list.
 */
export function loadTiers(directory: string): Tier[] {
  const project = loadHordeFile(directory)
  const user = project.data.tiers === undefined ? loadUserHordeFile() : undefined
  const raw = project.data.tiers === undefined ? user?.data.tiers : project.data.tiers
  if (raw === undefined) return []
  const file = project.data.tiers === undefined ? user?.file : project.file
  const where = `${file}: "tiers"`
  if (!Array.isArray(raw)) throw new Error(`${where} must be an array of { "model": "provider/model", "variant"?: "…" }`)
  return raw.map((t, i) => {
    const entry = typeof t === "string" ? { model: t } : t
    if (!entry || typeof entry !== "object" || typeof (entry as Tier).model !== "string" || !/^[^/\s]+\/\S+$/.test((entry as Tier).model))
      throw new Error(`${where}[${i}] needs "model": "provider/model"`)
    const { model, variant } = entry as Tier
    if (variant !== undefined && typeof variant !== "string") throw new Error(`${where}[${i}].variant must be a string`)
    return variant ? { model, variant } : { model }
  })
}

/** How workers' worktrees are prepared, from horde.json "workers"; unset fields keep their defaults. */
export interface Workers {
  /** Paths to link from the checkout (default: the dependency directories git ignores). */
  link?: string[]
  /** A command run at the new worktree's repository root before the worker starts, e.g. "npm run build". */
  setup?: string
  /** Repository-relative files every worker brief includes in full (house rules). */
  brief?: string[]
  /** A command run at the worktree root while landing, after the rebase onto the branch's tip; files it changes are committed on top and landed with the task. */
  land?: string | { command: string; message?: string }
}

export function loadWorkers(directory: string): Workers {
  const { file, data } = loadHordeFile(directory)
  const raw = data.workers
  if (raw === undefined) return {}
  const where = `${file}: "workers"`
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where} must be an object { "link"?: [...], "setup"?: "…", "brief"?: [...] }`)
  const { link, setup, brief, land } = raw as Workers
  if (link !== undefined && (!Array.isArray(link) || link.some((l) => typeof l !== "string"))) throw new Error(`${where}.link must be an array of paths`)
  if (setup !== undefined && typeof setup !== "string") throw new Error(`${where}.setup must be a command string`)
  if (brief !== undefined && (!Array.isArray(brief) || brief.some((f) => typeof f !== "string"))) throw new Error(`${where}.brief must be an array of paths`)
  if (land !== undefined && typeof land !== "string") {
    if (!land || typeof land !== "object" || Array.isArray(land) || typeof (land as { command?: unknown }).command !== "string")
      throw new Error(`${where}.land must be a command string or { "command": "…", "message"?: "…" }`)
    if ((land as { message?: unknown }).message !== undefined && typeof (land as { message?: unknown }).message !== "string")
      throw new Error(`${where}.land.message must be a string`)
  }
  return { ...(link ? { link } : {}), ...(setup ? { setup } : {}), ...(brief ? { brief } : {}), ...(land ? { land } : {}) }
}

/** "tier 1 (deepseek/deepseek-chat high)", or just "tier 1" without a model for it. */
export function tierLabel(tier: number, tiers: Tier[]): string {
  const t = tiers[tier]
  if (t) return `tier ${tier} (${t.model}${t.variant ? ` ${t.variant}` : ""})`
  return tiers.length && tier >= tiers.length ? `tier ${tier} (past the last model tier: yours)` : `tier ${tier}`
}

/** The model for a task's tier, or an error that says what to do when there is none. */
export function tierModel(tier: number, tiers: Tier[], task: string): Tier | undefined {
  if (!tiers.length) return undefined
  const t = tiers[tier]
  if (!t)
    throw new Error(
      `${task} is at tier ${tier}, past the last of the ${tiers.length} tier(s) in horde.json: the last tier is you. Do it yourself, pass a model, or add a tier.`,
    )
  return t
}
