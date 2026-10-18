import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { GIT_ENV, globMatcher, loadHordeFile } from "@mcp-horde/core"
import { Lru, MAX_ROOTS } from "./cache.js"

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

const cache = new Lru<string, { at: number; project: Project }>(MAX_ROOTS)
const TTL_MS = 2000

/**
 * The project's files: tracked and untracked-but-not-ignored when `root` is in a git
 * repository (so .gitignore applies), a filtered walk otherwise (also when git lists
 * nothing, e.g. a directory a parent repository ignores). Cached briefly, since one tool
 * call often asks several questions of the same tree; `fresh` lists again.
 */
export function openProject(root: string, opts: { fresh?: boolean } = {}): Project {
  const abs = path.resolve(root)
  const hit = cache.get(abs)
  if (hit && !opts.fresh && Date.now() - hit.at < TTL_MS) return hit.project
  let isDir = false
  try {
    isDir = fs.statSync(abs).isDirectory()
  } catch {
    // reported below
  }
  if (!isDir) throw new Error(`no project directory ${abs}`)
  const settings = loadContextSettings(abs)
  const ignored = globMatcher(settings.ignore)
  const listed = gitFiles(abs)
  let files = listed?.length ? listed : walk(abs)
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

const fileSets = new WeakMap<string[], Set<string>>()
/** Whether `rel` is one of the project's listed files. */
export function isProjectFile(project: Project, rel: string): boolean {
  let set = fileSets.get(project.files)
  if (!set) {
    set = new Set(project.files)
    fileSets.set(project.files, set)
  }
  return set.has(rel)
}

const realRoots = new Lru<string, string>(MAX_ROOTS)
function realRoot(root: string): string {
  let r = realRoots.get(root)
  if (r === undefined) {
    try {
      r = fs.realpathSync.native(root)
    } catch {
      r = root
    }
    realRoots.set(root, r)
  }
  return r
}

/**
 * Why `rel` cannot be read as one of the project's files (undefined when it can): outside
 * the root, not listed, a symlink leaving the root, or not a regular file (a directory such
 * as a submodule's gitlink, a FIFO, a device).
 */
export function unreadable(project: Project, rel: string): string | undefined {
  return access(project, rel).error
}

function access(project: Project, rel: string): { abs: string; st: fs.Stats; error?: undefined } | { error: string } {
  const norm = path.posix.normalize(rel.replace(/\\/g, "/"))
  if (path.isAbsolute(rel) || path.posix.isAbsolute(norm) || norm === ".." || norm.startsWith("../")) return { error: `${rel} is outside ${project.root}` }
  if (!isProjectFile(project, rel)) return { error: `no file ${rel} in ${project.root}` }
  const abs = path.join(project.root, rel)
  let st: fs.Stats
  try {
    st = fs.lstatSync(abs)
    if (st.isSymbolicLink()) {
      const real = fs.realpathSync.native(abs)
      const r = path.relative(realRoot(project.root), real)
      if (!r || r.startsWith("..") || path.isAbsolute(r)) return { error: `${rel} links outside ${project.root}` }
      st = fs.statSync(abs)
    }
  } catch {
    return { error: `${rel} cannot be read` }
  }
  if (!st.isFile()) return { error: `${rel} is not a regular file` }
  return { abs, st }
}

/** Texts are kept up to this many bytes (UTF-16 code units × 2), least recently used dropped first. */
const MAX_TEXT_BYTES = 64 * 1024 * 1024
/** …and at most this many files (binaries and oversized files hold no text but an entry). */
const MAX_TEXTS = 100_000
const texts = new Map<string, { mtime: number; size: number; text: string | undefined }>()
let textBytes = 0
const evictions: ((abs: string) => void)[] = []

/** Call `fn` with the absolute path of every text dropped from the cache (derived caches follow). */
export function onTextEvicted(fn: (abs: string) => void): void {
  evictions.push(fn)
}

const bytesOf = (t: string | undefined) => (t?.length ?? 0) * 2

function dropText(abs: string) {
  const e = texts.get(abs)
  if (!e) return
  texts.delete(abs)
  textBytes -= bytesOf(e.text)
  for (const fn of evictions) fn(abs)
}

/**
 * A project file's text, or undefined for binaries, oversized files, anything that is not a
 * regular file, and paths outside the project's file list or root (see `unreadable`).
 * Cached by mtime and size.
 */
export function readText(project: Project, rel: string): string | undefined {
  const a = access(project, rel)
  if (a.error !== undefined) return undefined
  const { abs, st } = a
  const hit = texts.get(abs)
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) {
    // Most recently used last.
    texts.delete(abs)
    texts.set(abs, hit)
    return hit.text
  }
  let text: string | undefined
  if (st.size <= MAX_READ_BYTES) {
    try {
      const buf = fs.readFileSync(abs)
      text = buf.subarray(0, 8000).includes(0) ? undefined : buf.toString("utf8")
    } catch {
      text = undefined
    }
  }
  dropText(abs)
  texts.set(abs, { mtime: st.mtimeMs, size: st.size, text })
  textBytes += bytesOf(text)
  while ((textBytes > MAX_TEXT_BYTES || texts.size > MAX_TEXTS) && texts.size > 1) dropText(texts.keys().next().value as string)
  return text
}

/** Normalize a user-given path to the project's form (relative, forward slashes; "" for the root). */
export function relPath(project: Project, p: string): string {
  const rel = path.isAbsolute(p) ? path.relative(project.root, p) : p
  const out = rel
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "")
  return out === "." ? "" : out
}

const GLOB_CHARS = /[*?[\]{}]/

/**
 * Files matching any of the globs or paths. A plain path (no glob characters) is anchored at
 * the root and covers everything below it; ".", "./" and "" mean every file.
 */
export function select(project: Project, patterns: string[] | undefined): string[] {
  if (!patterns?.length) return project.files
  const rels = patterns.map((p) => relPath(project, p))
  if (rels.includes("")) return project.files
  const plain = rels.filter((p) => !GLOB_CHARS.test(p))
  const globs = rels.filter((p) => GLOB_CHARS.test(p))
  const m = globs.length ? globMatcher(globs) : () => false
  return project.files.filter((f) => plain.some((p) => f === p || f.startsWith(`${p}/`)) || m(f))
}
