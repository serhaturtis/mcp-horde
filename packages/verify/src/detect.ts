import fs from "node:fs"
import path from "node:path"
import { git, gitRaw, type HordeFile, loadHordeFile, validateHordeFile } from "@mcp-horde/core"

export type CheckKind = "test" | "typecheck" | "lint" | "build" | "other"

export interface Check {
  name: string
  command: string
  kind: CheckKind
  /** Directory the command runs in. */
  cwd: string
  /** Where the check came from, for the detect report. */
  source: string
  /** Variables set for this check (detected Python checks pin PYTHONPATH to the project). */
  env?: Record<string, string>
  /** Inherited variable prefixes removed for this check. */
  stripEnv?: string[]
  /** "land": skipped while a task works, run before landing (a slow suite that the related tests stand in for). */
  when?: "land"
  /** At most this many runs of the check at once, across every horde process using the repository. */
  slots?: number
  /** A resource the check needs alone (a dev stack, a recording): checks naming the same one never overlap. */
  exclusive?: string
}

export type AuditCategory = "scope" | "tests" | "suppressions" | "dependencies" | "secrets" | "binaries" | "git"
export const AUDIT_CATEGORIES: readonly AuditCategory[] = ["scope", "tests", "suppressions", "dependencies", "secrets", "binaries", "git"]

export interface VerifySettings {
  /** Directory horde.json was found in (or the project directory). */
  root: string
  configFile?: string
  checks?: Check[]
  timeoutMs: number
  audit: {
    block: AuditCategory[]
    warn: AuditCategory[]
    /** Paths every change must stay within; empty means no scope restriction. */
    allowed: string[]
    /** Generated output (bundles): no binary, size, secret or suppression findings, though scope still applies. */
    generated: string[]
  }
}

const DEFAULT_BLOCK: AuditCategory[] = ["scope", "tests", "secrets", "binaries"]
const DEFAULT_WARN: AuditCategory[] = ["suppressions", "dependencies", "git"]

function categories(value: unknown, where: string): AuditCategory[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((v) => !(AUDIT_CATEGORIES as readonly unknown[]).includes(v))) {
    throw new Error(`${where} must be a list of: ${AUDIT_CATEGORIES.join(", ")}`)
  }
  return value as AuditCategory[]
}

/** The `verify` section of horde.json, validated, with defaults. */
export function loadSettings(directory: string): VerifySettings {
  return parseSettings(loadHordeFile(directory), repositoryRoot(directory))
}

/**
 * Settings as horde.json had them at `commit`, so a worker cannot loosen the rules its own
 * gate applies (drop a check, unblock a category) by editing horde.json. The gate passes the
 * commit whose rules apply: base by default, or the target branch's tip when it moved on. The
 * same files loadHordeFile would find are looked up in that commit; when none existed there,
 * the defaults apply: a working-tree horde.json is the work's own change (the audit flags it),
 * not a rule the gate may run.
 */
export async function loadSettingsAt(directory: string, commit: string): Promise<VerifySettings> {
  const top = await git(directory, "rev-parse", "--show-toplevel").catch(() => undefined)
  if (!top) return loadSettings(directory)
  const realTop = realpath(top)
  for (let dir = realpath(directory); ; dir = path.dirname(dir)) {
    const rel = path.relative(realTop, dir).replace(/\\/g, "/")
    if (rel.startsWith("..") || path.isAbsolute(rel)) break
    const file = rel ? `${rel}/horde.json` : "horde.json"
    const text = await gitRaw(realTop, ["show", `${commit}:${file}`]).catch(() => undefined)
    if (text !== undefined) {
      let data: unknown
      try {
        data = JSON.parse(text)
      } catch (err) {
        throw new Error(`${file} at ${commit} is not valid JSON: ${(err as Error).message}`)
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${file} at ${commit} must contain a JSON object`)
      validateHordeFile(data as Record<string, unknown>, `${file} at ${commit}`)
      return parseSettings({ root: dir, file: path.join(dir, "horde.json"), data: data as Record<string, unknown> }, realTop)
    }
    if (!rel) break
  }
  return parseSettings({ root: path.resolve(directory), data: {} }, repositoryRoot(directory))
}

/** The repository root (the nearest ancestor with `.git`), or the directory itself when there is none. */
function repositoryRoot(directory: string): string {
  const start = path.resolve(directory)
  for (let dir = start; ; ) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

function inside(root: string, p: string): boolean {
  const rel = path.relative(root, p)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

function parseSettings(horde: HordeFile, repoRoot = horde.root): VerifySettings {
  const v = (horde.data.verify ?? {}) as Record<string, unknown>
  const where = `${horde.file ?? "horde.json"} verify`
  let checks: Check[] | undefined
  if (v.checks !== undefined) {
    if (!v.checks || typeof v.checks !== "object" || Array.isArray(v.checks)) throw new Error(`${where}.checks must be an object of name → command`)
    checks = Object.entries(v.checks as Record<string, unknown>).map(([name, spec]) => {
      const s = (typeof spec === "string" ? { command: spec } : spec) as Record<string, unknown> | null
      const at = `${where}.checks.${name}`
      if (!s || typeof s.command !== "string" || !s.command.trim()) throw new Error(`${at} needs a command`)
      const kind = (s.kind ?? kindOf(name, s.command)) as CheckKind
      if (!["test", "typecheck", "lint", "build", "other"].includes(kind)) throw new Error(`${at}.kind is invalid`)
      if (s.cwd !== undefined && typeof s.cwd !== "string") throw new Error(`${at}.cwd must be a string`)
      const cwd = typeof s.cwd === "string" ? path.resolve(horde.root, s.cwd) : horde.root
      if (s.cwd !== undefined && !inside(realpath(repoRoot), realpath(cwd)))
        throw new Error(`${at}.cwd must stay inside the repository ${realpath(repoRoot)}: "${s.cwd}" resolves outside it`)
      const env = s.env
      if (env !== undefined && (!env || typeof env !== "object" || Array.isArray(env) || Object.values(env).some((v) => typeof v !== "string")))
        throw new Error(`${at}.env must be an object of name → string`)
      if (s.when !== undefined && s.when !== "land" && s.when !== "always") throw new Error(`${at}.when must be "land" or "always"`)
      if (s.slots !== undefined && !(Number.isInteger(s.slots) && (s.slots as number) > 0)) throw new Error(`${at}.slots must be a positive integer`)
      if (s.exclusive !== undefined && !(typeof s.exclusive === "string" && /^[\w.-]+$/.test(s.exclusive)))
        throw new Error(`${at}.exclusive must be a name (letters, digits, . _ -)`)
      return {
        name,
        command: s.command,
        kind,
        cwd,
        source: "horde.json",
        ...(env ? { env: env as Record<string, string> } : {}),
        ...(s.when === "land" ? { when: "land" as const } : {}),
        ...(s.slots ? { slots: s.slots as number } : {}),
        ...(s.exclusive ? { exclusive: s.exclusive as string } : {}),
      }
    })
  }
  const audit = (v.audit ?? {}) as Record<string, unknown>
  const warned = categories(audit.warn, `${where}.audit.warn`)
  // An explicit warn list takes a category out of the default block; an explicit block still wins.
  const block = categories(audit.block, `${where}.audit.block`) ?? DEFAULT_BLOCK.filter((c) => !warned?.includes(c))
  const warn = [...(warned ?? DEFAULT_WARN)]
  const off = categories(audit.off, `${where}.audit.off`) ?? []
  // A category named nowhere warns: listing only `block` must not switch the rest off (that is what `off` is for).
  for (const c of AUDIT_CATEGORIES) if (!block.includes(c) && !off.includes(c) && !warn.includes(c)) warn.push(c)
  const allowed = audit.allowed ?? []
  if (!Array.isArray(allowed) || allowed.some((a) => typeof a !== "string")) throw new Error(`${where}.audit.allowed must be a list of globs`)
  const generated = audit.generated ?? []
  if (!Array.isArray(generated) || generated.some((a) => typeof a !== "string")) throw new Error(`${where}.audit.generated must be a list of globs`)
  const timeout = v.timeoutSeconds ?? 600
  if (typeof timeout !== "number" || timeout <= 0) throw new Error(`${where}.timeoutSeconds must be a positive number`)
  return {
    root: horde.root,
    configFile: horde.file,
    checks,
    timeoutMs: timeout * 1000,
    audit: {
      block: block.filter((c) => !off.includes(c)),
      warn: warn.filter((c) => !block.includes(c) && !off.includes(c)),
      allowed: allowed as string[],
      generated: generated as string[],
    },
  }
}

/** Test runners a command calls: they tell a test check apart when its name does not (`go`, `runtime`). */
const TEST_RUNNER =
  /(^|[\s/])(pytest|py\.test|vitest|jest|mocha)(\s|$)|-m\s+pytest\b|\bgo\s+test\b|\bcargo\s+(test|nextest)\b|\bnpm\s+(run\s+)?test\b|\bnode\s+--test\b/

/** A compound command runs more than one program, so a test runner in it is not the whole check. */
const COMPOUND = /[\n\r;&|]/

function kindOf(name: string, command: string): CheckKind {
  if (/test|spec|unit|integration|e2e/i.test(name)) return "test"
  if (/type|tsc|mypy|pyright/i.test(name)) return "typecheck"
  if (/lint|ruff|clippy|vet|format|fmt/i.test(name)) return "lint"
  if (/build|compile/i.test(name)) return "build"
  return TEST_RUNNER.test(command) && !COMPOUND.test(command) ? "test" : "other"
}

const ORDER: Record<CheckKind, number> = { typecheck: 0, lint: 1, build: 2, test: 3, other: 4 }

const realpath = (p: string): string => {
  try {
    return fs.realpathSync.native(p)
  } catch {
    const parent = path.dirname(p)
    return parent === p ? path.resolve(p) : path.join(realpath(parent), path.basename(p))
  }
}

/**
 * The checks for a directory: horde.json's when it defines any, otherwise
 * detected from the manifests of the nearest project root (walking up to the
 * repository root, so an agent in a subdirectory of a monorepo package still
 * finds that package's scripts). With `commit` (the gate's rulesAt), the
 * manifests are read from that commit, never the working tree, so a worker
 * cannot rename the scripts its own gate runs.
 */
export async function detectChecks(directory: string, settings = loadSettings(directory), commit?: string): Promise<Check[]> {
  if (settings.checks) return settings.checks
  const top = await git(directory, "rev-parse", "--show-toplevel").catch(() => undefined)
  // Real paths on both sides: a symlinked or 8.3-named directory must still meet the top.
  const stop = top ? realpath(top) : undefined
  const ctx = detectCtx(stop, commit)
  let dir = realpath(directory)
  for (;;) {
    const found = await detectIn(dir, stop, ctx)
    if (found.length) return found.sort((a, b) => ORDER[a.kind] - ORDER[b.kind])
    if (isTop(dir, stop)) return []
    dir = path.dirname(dir)
  }
}

/** The repository root (or a nested repository's, which has its own `.git`), or the filesystem root. */
const isTop = (dir: string, stop: string | undefined) => dir === stop || fs.existsSync(path.join(dir, ".git")) || path.dirname(dir) === dir

/** package.json script names a check runs (`npm test`, `pnpm run lint`, …), so the audit can tell when they change. */
export function checkScripts(checks: Check[]): string[] {
  return checks.flatMap((c) => {
    const m = c.command.match(/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/)
    return m ? [m[1]!] : []
  })
}

const PLACEHOLDER_TEST = /no test specified/

/** The package manager: `packageManager` in package.json, else the nearest lockfile, up to the repository root. */
async function packageManager(dir: string, stop: string | undefined, ctx: DetectCtx): Promise<string> {
  for (let d = dir; ; d = path.dirname(d)) {
    try {
      const pm = (JSON.parse(await ctx.read(d, "package.json")) as { packageManager?: unknown }).packageManager
      const name = typeof pm === "string" ? pm.match(/^(npm|pnpm|yarn|bun)@/)?.[1] : undefined
      if (name) return name
    } catch {
      // No (readable) package.json here.
    }
    if ((await ctx.has(d, "pnpm-lock.yaml")) || (await ctx.has(d, "pnpm-workspace.yaml"))) return "pnpm"
    if (await ctx.has(d, "yarn.lock")) return "yarn"
    if ((await ctx.has(d, "bun.lockb")) || (await ctx.has(d, "bun.lock"))) return "bun"
    if ((await ctx.has(d, "package-lock.json")) || (await ctx.has(d, "npm-shrinkwrap.json"))) return "npm"
    if (isTop(d, stop)) return "npm"
  }
}

/** Is `cmd` an executable on PATH? */
function onPath(cmd: string): boolean {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]
  return (process.env.PATH ?? "").split(path.delimiter).some((d) => d && exts.some((e) => fs.existsSync(path.join(d, cmd + e))))
}

const SKIP_DIRS = new Set(["node_modules", "vendor", "testdata", "target", "dist", "build", "venv", "__pycache__", "site-packages"])

/** Paths (relative, forward slashes) of files named like `match`, a few levels deep, skipping dependency and hidden directories. */
function findFiles(root: string, match: (name: string) => boolean, opts: { depth?: number; limit?: number } = {}): string[] {
  const out: string[] = []
  const limit = opts.limit ?? 100
  let budget = 5000 // directory entries looked at, so a huge tree cannot stall detection
  const walk = (rel: string, depth: number) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= limit || --budget < 0) return
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (depth > 0 && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) walk(p, depth - 1)
      } else if (match(e.name)) out.push(p)
    }
  }
  walk("", opts.depth ?? 4)
  return out
}

/** The manifests detection consults, read from the working tree or from a commit (the gate's rulesAt). */
interface DetectCtx {
  has(dir: string, file: string): Promise<boolean>
  read(dir: string, file: string): Promise<string>
  /** Files under `dir` (relative to it) whose name matches, skipping dependency and hidden directories. */
  find(dir: string, match: (name: string) => boolean, opts?: { depth?: number; limit?: number }): Promise<string[]>
}

function detectCtx(top: string | undefined, commit?: string): DetectCtx {
  if (!top || !commit)
    return {
      has: async (dir, file) => fs.existsSync(path.join(dir, file)),
      read: async (dir, file) => {
        try {
          return fs.readFileSync(path.join(dir, file), "utf8")
        } catch {
          return ""
        }
      },
      find: async (dir, match, opts = {}) => findFiles(dir, match, opts),
    }
  // `git show <commit>:<rel>` for a file, `git ls-tree` for a listing, so a worker's rewrite of a
  // manifest never changes what the gate detects.
  const rel = (dir: string, file: string) => path.relative(top, path.join(dir, file)).replace(/\\/g, "/")
  const inside = (p: string) => p !== "" && !p.startsWith("..") && !path.isAbsolute(p)
  return {
    has: async (dir, file) => {
      const p = rel(dir, file)
      return inside(p)
        ? gitRaw(top, ["show", `${commit}:${p}`]).then(
            () => true,
            () => false,
          )
        : false
    },
    read: async (dir, file) => {
      const p = rel(dir, file)
      return inside(p) ? gitRaw(top, ["show", `${commit}:${p}`]).catch(() => "") : ""
    },
    find: async (dir, match, opts = {}) => {
      const prefix = path.relative(top, dir).replace(/\\/g, "/")
      if (prefix.startsWith("..") || path.isAbsolute(prefix)) return []
      const args = ["ls-tree", "-r", "--name-only", commit]
      if (prefix) args.push(prefix)
      const listing = await gitRaw(top, args).catch(() => "")
      const limit = opts.limit ?? 100
      const depth = opts.depth ?? 4
      const out: string[] = []
      for (const p of listing.split("\n")) {
        const relp = prefix ? p.slice(prefix.length + 1) : p
        if (!relp) continue
        const parts = relp.split("/")
        if (parts.length - 1 > depth || parts.some((s) => s.startsWith(".") || SKIP_DIRS.has(s))) continue
        if (match(path.posix.basename(p))) out.push(relp)
        if (out.length >= limit) break
      }
      return out
    },
  }
}

/** Module directories a go.work uses (`use ./a` and `use ( ./a ./b )`). */
function goWorkUses(text: string): string[] {
  const body = text.replace(/\/\/.*$/gm, "")
  const uses: string[] = []
  for (const m of body.matchAll(/^\s*use\s*(?:\(([^)]*)\)|(\S+))/gm)) uses.push(...(m[1] ?? m[2]!).split(/\s+/).filter(Boolean))
  return uses.map((u) => u.replace(/^"|"$/g, ""))
}

async function detectIn(dir: string, stop: string | undefined, ctx: DetectCtx): Promise<Check[]> {
  const out: Check[] = []
  const has = (f: string) => ctx.has(dir, f)
  const read = (f: string) => ctx.read(dir, f)
  const add = (name: string, command: string, kind: CheckKind, source: string, extra: Partial<Check> = {}) =>
    out.push({ name, command, kind, cwd: dir, source, ...extra })

  // JavaScript / TypeScript
  if (await has("package.json")) {
    let scripts: Record<string, string> = {}
    try {
      scripts = (JSON.parse(await read("package.json")) as { scripts?: Record<string, string> }).scripts ?? {}
    } catch {
      // A broken package.json is the project's problem; detect the rest.
    }
    const pm = await packageManager(dir, stop, ctx)
    const run = (s: string) => (pm === "npm" ? (s === "test" ? "npm test" : `npm run ${s}`) : `${pm} run ${s}`)
    const typecheck = ["typecheck", "type-check", "check-types", "tsc"].find((s) => scripts[s])
    if (typecheck) add("typecheck", run(typecheck), "typecheck", `package.json scripts.${typecheck}`)
    const lint = ["lint", "check"].find((s) => scripts[s])
    if (lint) add("lint", run(lint), "lint", `package.json scripts.${lint}`)
    if (!typecheck && scripts.build) add("build", run("build"), "build", "package.json scripts.build")
    if (scripts.test && !PLACEHOLDER_TEST.test(scripts.test)) add("test", run("test"), "test", "package.json scripts.test")
  }

  // Python
  const pyproject = await read("pyproject.toml")
  if (pyproject || (await has("setup.py")) || (await has("setup.cfg")) || (await has("pytest.ini")) || (await has("tox.ini"))) {
    let venv: string | undefined
    for (const v of [".venv/bin/python", "venv/bin/python", ".venv/Scripts/python.exe"]) if (await has(v)) venv = v
    // The project's own environment manager when it has a lockfile for one (and it is installed).
    const py =
      (await has("uv.lock")) && onPath("uv")
        ? "uv run python"
        : (await has("poetry.lock")) && onPath("poetry")
          ? "poetry run python"
          : venv
            ? `"${path.join(dir, venv)}"`
            : process.platform === "win32"
              ? "python"
              : "python3"
    // The project's code, not whatever an inherited PYTHONPATH or activated virtualenv points at.
    const env = { PYTHONPATH: [...((await has("src")) ? [path.join(dir, "src")] : []), dir].join(path.delimiter) }
    const pyCheck = { env, stripEnv: ["VIRTUAL_ENV"] }
    if (/\[tool\.mypy\]/.test(pyproject) || (await has("mypy.ini"))) add("typecheck", `${py} -m mypy .`, "typecheck", "mypy config", pyCheck)
    if (/\[tool\.ruff/.test(pyproject) || (await has("ruff.toml")) || (await has(".ruff.toml")))
      add("lint", `${py} -m ruff check .`, "lint", "ruff config", pyCheck)
    const configured =
      /\[tool\.pytest/.test(pyproject) ||
      (await has("pytest.ini")) ||
      /\[tool:pytest\]/.test(await read("setup.cfg")) ||
      /^\[pytest\]/m.test(await read("tox.ini"))
    // A tests/ directory alone is not a pytest suite (it may hold fixtures for another runner).
    if (configured || (await has("conftest.py")) || (await ctx.find(dir, (n) => /^test_.+\.py$|.+_test\.py$/.test(n), { limit: 1 })).length) {
      add("test", `${py} -m pytest -q`, "test", "pytest", pyCheck)
    }
  }

  // Rust
  if (await has("Cargo.toml")) {
    const workspace = /^\[workspace\]/m.test(await read("Cargo.toml"))
    add("test", `cargo test${workspace ? " --workspace" : ""} --color never`, "test", workspace ? "Cargo.toml [workspace]" : "Cargo.toml")
  }

  // Go: `./...` stops at nested modules, so each module (a go.work's, or every go.mod below this one) gets its own checks.
  const hasGoWork = await has("go.work")
  if (hasGoWork || (await has("go.mod"))) {
    const modules = hasGoWork
      ? goWorkUses(await read("go.work"))
      : [".", ...(await ctx.find(dir, (n) => n === "go.mod", { depth: 6 })).map((f) => path.posix.dirname(f)).filter((d) => d !== ".")]
    for (const m of [...new Set(modules.map((u) => path.posix.normalize(u.replace(/\\/g, "/")).replace(/\/$/, "")))]) {
      const cwd = path.resolve(dir, m)
      if (!(await ctx.has(dir, m === "." ? "go.mod" : `${m}/go.mod`))) continue
      const suffix = m === "." ? "" : `:${m}`
      const source = m === "." ? "go.mod" : hasGoWork ? `go.work (${m})` : `${m}/go.mod`
      add(`vet${suffix}`, "go vet ./...", "lint", source, { cwd })
      add(`test${suffix}`, "go test ./...", "test", source, { cwd })
    }
  }

  // Make, only when nothing more specific was found.
  if (!out.length && ((await has("Makefile")) || (await has("makefile")))) {
    const mk = (await read("Makefile")) || (await read("makefile"))
    for (const [target, kind] of [
      ["lint", "lint"],
      ["check", "test"],
      ["test", "test"],
    ] as const) {
      if (new RegExp(`^${target}:`, "m").test(mk)) add(target, `make ${target}`, kind, "Makefile")
    }
  }
  return dedupeNames(out)
}

/** Two ecosystems can both contribute a "test": keep names unique. */
function dedupeNames(checks: Check[]): Check[] {
  const seen = new Map<string, number>()
  return checks.map((c) => {
    const n = (seen.get(c.name) ?? 0) + 1
    seen.set(c.name, n)
    return n === 1 ? c : { ...c, name: `${c.name}-${n}` }
  })
}
