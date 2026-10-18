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
