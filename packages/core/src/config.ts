import fs from "node:fs"
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
 * root (the first directory containing `.git`). A malformed file throws: a
 * silently ignored typo in project rules is worse than an error.
 */
export function loadHordeFile(directory: string): HordeFile {
  let dir = path.resolve(directory)
  for (;;) {
    const file = path.join(dir, "horde.json")
    if (fs.existsSync(file)) {
      let data: unknown
      try {
        data = JSON.parse(fs.readFileSync(file, "utf8"))
      } catch (err) {
        throw new Error(`${file} is not valid JSON: ${(err as Error).message}`)
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${file} must contain a JSON object`)
      return { root: dir, file, data: data as Record<string, unknown> }
    }
    const parent = path.dirname(dir)
    if (fs.existsSync(path.join(dir, ".git")) || parent === dir) return { root: path.resolve(directory), data: {} }
    dir = parent
  }
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
  const { file, data } = loadHordeFile(directory)
  const raw = data.tiers
  if (raw === undefined) return []
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
