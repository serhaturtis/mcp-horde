import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { GIT_ENV, globMatcher, loadHordeFile } from "@mcp-horde/core"

/** Files larger than this are listed but never read. */
export const MAX_READ_BYTES = 1024 * 1024
/** Stop listing beyond this many files (huge monorepos: narrow with `paths`). */
export const MAX_FILES = 50_000

const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "target", "dist", "build", ".next", ".turbo", "vendor", ".gradle", "obj"])

export interface ContextSettings {
  ignore: string[]
  entrypoints: string[]
}

/** `horde.json` → `context`: `ignore` extends .gitignore, `entrypoints` are always worth listing. */
export function loadContextSettings(dir: string): ContextSettings {
  const raw = loadHordeFile(dir).data.context
  if (raw === undefined) return { ignore: [], entrypoints: [] }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error('horde.json: "context" must be an object')
  const r = raw as Record<string, unknown>
  const strings = (k: string): string[] => {
    const v = r[k]
    if (v === undefined) return []
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`horde.json: "context.${k}" must be an array of strings`)
    return v as string[]
  }
  return { ignore: strings("ignore"), entrypoints: strings("entrypoints") }
}

export interface Project {
  /** Absolute directory everything is relative to. */
  root: string
  /** Forward-slash paths relative to root, sorted. */
  files: string[]
  /** True when the listing stopped at MAX_FILES. */
  capped: boolean
  settings: ContextSettings
}

const cache = new Map<string, { at: number; project: Project }>()
const TTL_MS = 2000

/**
 * The project's files: tracked and untracked-but-not-ignored when `root` is in a git
 * repository (so .gitignore applies), a filtered walk otherwise. Cached briefly, since
 * one tool call often asks several questions of the same tree; `fresh` lists again.
 */
export function openProject(root: string, opts: { fresh?: boolean } = {}): Project {
  const abs = path.resolve(root)
  const hit = cache.get(abs)
  if (hit && !opts.fresh && Date.now() - hit.at < TTL_MS) return hit.project
  const settings = loadContextSettings(abs)
  const ignored = globMatcher(settings.ignore)
  let files = gitFiles(abs) ?? walk(abs)
  files = files.filter((f) => !ignored(f))
  const capped = files.length > MAX_FILES
  if (capped) files = files.slice(0, MAX_FILES)
  const project = { root: abs, files: files.sort(), capped, settings }
  cache.set(abs, { at: Date.now(), project })
  return project
}

function gitFiles(dir: string): string[] | undefined {
  const r = spawnSync("git", ["-c", "core.quotePath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: dir,
    env: GIT_ENV,
    maxBuffer: 256 * 1024 * 1024,
    encoding: "utf8",
  })
  if (r.status !== 0 || r.error) return undefined
  // Deleted-but-tracked files are still listed by --cached; keep what exists.
  return [...new Set(r.stdout.split("\0").filter(Boolean))].filter((f) => fs.existsSync(path.join(dir, f)))
}

function walk(dir: string): string[] {
  const out: string[] = []
  const visit = (rel: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length > MAX_FILES) return
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) visit(p)
      } else if (e.isFile()) out.push(p)
    }
  }
  visit("")
  return out
}

const texts = new Map<string, { mtime: number; size: number; text: string | undefined }>()

/** A file's text, or undefined for binaries, unreadable and oversized files. Cached by mtime. */
export function readText(project: Project, rel: string): string | undefined {
  const abs = path.join(project.root, rel)
  let st: fs.Stats
  try {
    st = fs.statSync(abs)
  } catch {
    return undefined
  }
  const hit = texts.get(abs)
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.text
  let text: string | undefined
  if (st.size <= MAX_READ_BYTES) {
    const buf = fs.readFileSync(abs)
    text = buf.subarray(0, 8000).includes(0) ? undefined : buf.toString("utf8")
  }
  if (texts.size > 20_000) texts.clear()
  texts.set(abs, { mtime: st.mtimeMs, size: st.size, text })
  return text
}

/** Normalize a user-given path to the project's form (relative, forward slashes). */
export function relPath(project: Project, p: string): string {
  const rel = path.isAbsolute(p) ? path.relative(project.root, p) : p
  return rel.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")
}

/** Files matching any of the globs or paths (a plain directory path covers everything below it). */
export function select(project: Project, patterns: string[] | undefined): string[] {
  if (!patterns?.length) return project.files
  const m = globMatcher(patterns.map((p) => relPath(project, p)))
  return project.files.filter(m)
}
