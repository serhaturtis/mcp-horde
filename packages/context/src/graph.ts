import { createHash } from "node:crypto"
import path from "node:path"
import { isTestPath } from "@mcp-horde/core"
import { Lru, MAX_ROOTS } from "./cache.js"
import { onTextEvicted, type Project, readText } from "./files.js"
import { type Definition, importSpecs, type Lang, langOf, patternDefinitions } from "./lang.js"
import { type Parsed, parse, syntaxGeneration } from "./syntax.js"

export interface FileInfo {
  lang: Lang
  defs: Definition[]
  /** Import specifiers as written. */
  specs: string[]
  /** Comment and string spans, when the file was parsed (see syntax.isCode). */
  spans?: Parsed["spans"]
}

const infos = new Map<string, { text: string; generation: number; info: FileInfo }>()
// The text cache bounds memory: what it drops, the info cache drops too.
onTextEvicted((abs) => infos.delete(abs))

/** Below this size parsing is cheap, so no file is worth treating as a minified bundle. */
const MINIFIED_MIN_CHARS = 50_000
/** Bundles pack everything onto a few very long lines; ordinary source averages far less. */
const MINIFIED_MIN_AVG_LINE = 300

/** Definitions and imports of one source file (undefined for other files and minified bundles). Cached by content. */
export function fileInfo(project: Project, rel: string): FileInfo | undefined {
  const lang = langOf(rel)
  if (!lang) return undefined
  const text = readText(project, rel)
  if (text === undefined) return undefined
  // Parsing a bundle is slow and its one-letter definitions are noise; skip it like a non-source file.
  if (text.length > MINIFIED_MIN_CHARS && text.length / text.split("\n").length > MINIFIED_MIN_AVG_LINE) return undefined
  const key = path.join(project.root, rel)
  const hit = infos.get(key)
  // Computed before the grammars finished loading: compute again.
  const generation = syntaxGeneration()
  if (hit && hit.text === text && hit.generation === generation) return hit.info
  // Components mix <template> markup with <script>: read their imports but no definitions,
  // which the line/grammar rules would otherwise scatter across the markup.
  const component = /\.(vue|svelte|astro)$/.test(rel)
  const parsed = component ? undefined : parse(text, lang, rel)
  const info = {
    lang,
    defs: component ? [] : (parsed?.defs ?? patternDefinitions(text, lang)),
    specs: importSpecs(text, lang, { submodules: true }),
    spans: parsed?.spans,
  }
  infos.set(key, { text, generation, info })
  return info
}

const JS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]

/** Files that mark the root of a Python project. */
const PY_ROOTS = ["pyproject.toml", "setup.py", "setup.cfg"]

interface TsConfig {
  /** Directory non-relative imports resolve against (baseUrl), if set. */
  baseUrl?: string
  /** `paths` patterns with their targets, already joined to the directory they are relative to. */
  paths: { prefix: string; suffix: string; star: boolean; targets: string[] }[]
}

/**
 * What one import-graph build knows about the project, computed once per build: the file
 * set, files by directory and by name, workspace packages, go.mod, Python project roots and
 * tsconfig files. Every non-source file it reads is recorded, so a cached graph can tell when
 * to build again.
 */
class Resolver {
  readonly files: Set<string>
  readonly byDir = new Map<string, string[]>()
  readonly byName = new Map<string, string[]>()
  /** Directories by their last segment (Java/Kotlin packages). */
  readonly dirsByName = new Map<string, string[]>()
  /** Non-source files read while resolving, with the text seen. */
  readonly deps = new Map<string, string | undefined>()
  private packages?: Map<string, { dir: string; entry?: string }>
  private goModsAll?: { dir: string; mod: string }[]
  private readonly pyRoots = new Map<string, string | null>()
  private pyPkgs?: Map<string, string[]>
  private readonly tsConfigs = new Map<string, TsConfig | null>()

  constructor(readonly project: Project) {
    this.files = new Set(project.files)
    for (const f of project.files) {
      const dir = path.posix.dirname(f)
      push(this.byDir, dir, f)
      push(this.byName, path.posix.basename(f), f)
    }
    for (const d of this.byDir.keys()) push(this.dirsByName, path.posix.basename(d), d)
  }

  read(rel: string): string | undefined {
    const text = readText(this.project, rel)
    this.deps.set(rel, text)
    return text
  }

  /** Files of package `pkg` (path below `dir`), on whatever directory it maps to. */
  workspacePackages(): Map<string, { dir: string; entry?: string }> {
    if (this.packages) return this.packages
    const packages = new Map<string, { dir: string; entry?: string }>()
    for (const pj of this.byName.get("package.json") ?? []) {
      let data: { name?: string; main?: string; types?: string; exports?: unknown }
      try {
        data = JSON.parse(this.read(pj) ?? "{}")
      } catch {
        continue
      }
      if (!data.name) continue
      const dir = path.posix.dirname(pj)
      const root = (p: string) => path.posix.normalize(path.posix.join(dir, p))
      const dot = (
        data.exports && typeof data.exports === "object" && !Array.isArray(data.exports)
          ? ((data.exports as Record<string, unknown>)["."] ?? data.exports)
          : data.exports
      ) as string | Record<string, unknown> | undefined
      const conds = typeof dot === "string" ? [dot] : dot && typeof dot === "object" ? [dot.source, dot.import, dot.default, dot.require, dot.types] : []
      const candidates = [...conds, data.main, data.types].filter((x): x is string => typeof x === "string")
      let entry: string | undefined
      for (const c of candidates) {
        const p = root(c)
        entry = jsFile(p.replace(/^(.*?)(dist|build|lib)\//, "$1src/").replace(/\.d\.ts$/, ".ts"), this.files) ?? jsFile(p, this.files)
        if (entry) break
      }
      packages.set(data.name, { dir: dir === "." ? "" : dir, entry: entry ?? jsFile(root("src/index"), this.files) ?? jsFile(root("index"), this.files) })
    }
    this.packages = packages
    return packages
  }

  /** Every go.mod module path with its directory (go.work resolves imports across modules). */
  allGoModules(): { dir: string; mod: string }[] {
    if (this.goModsAll) return this.goModsAll
    const out: { dir: string; mod: string }[] = []
    for (const f of this.byName.get("go.mod") ?? []) {
      const mod = /^module\s+(\S+)/m.exec(this.read(f) ?? "")?.[1]
      if (mod) out.push({ dir: path.posix.dirname(f), mod })
    }
    this.goModsAll = out
    return out
  }

  /** The root of the nearest Python project (pyproject.toml, setup.py or setup.cfg) at or above `dir`. */
  pyRoot(dir: string): string | undefined {
    const memo = this.pyRoots.get(dir)
    if (memo !== undefined) return memo ?? undefined
    let found: string | null = null
    if (PY_ROOTS.some((name) => this.files.has(dir === "." ? name : `${dir}/${name}`))) found = dir
    if (!found && dir !== ".") found = this.pyRoot(path.posix.dirname(dir)) ?? null
    this.pyRoots.set(dir, found)
    return found ?? undefined
  }

  /** Top-level package name → its directory, for every Python project root (uv workspaces). */
  pyPackages(): Map<string, string[]> {
    if (this.pyPkgs) return this.pyPkgs
    const roots = new Set<string>()
    for (const name of PY_ROOTS) for (const f of this.byName.get(name) ?? []) roots.add(path.posix.dirname(f))
    const pkgs = new Map<string, string[]>()
    for (const init of this.byName.get("__init__.py") ?? []) {
      const d = path.posix.dirname(init)
      if (d === ".") continue
      const parent = path.posix.dirname(d)
      // A top-level package of a project root: <root>/<pkg>/ or <root>/src/<pkg>/.
      const top = roots.has(parent) || (path.posix.basename(parent) === "src" && roots.has(path.posix.dirname(parent)))
      if (top) push(pkgs, path.posix.basename(d), d)
    }
    this.pyPkgs = pkgs
    return pkgs
  }

  /** compilerOptions.paths and baseUrl from the nearest tsconfig.json or jsconfig.json at or above `dir`. */
  tsConfig(dir: string): TsConfig | undefined {
    const memo = this.tsConfigs.get(dir)
    if (memo !== undefined) return memo ?? undefined
    let found: TsConfig | null = null
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const rel = dir === "." ? name : `${dir}/${name}`
      if (this.files.has(rel)) {
        found = this.loadTsConfig(rel)
        break
      }
    }
    if (!found && dir !== ".") found = this.tsConfig(path.posix.dirname(dir)) ?? null
    this.tsConfigs.set(dir, found)
    return found ?? undefined
  }

  private loadTsConfig(rel: string): TsConfig | null {
    type Options = { baseUrl?: unknown; paths?: unknown }
    const load = (f: string): { extends?: unknown; compilerOptions?: Options } | undefined => {
      try {
        return JSON.parse(stripJsonComments(this.read(f) ?? ""))
      } catch {
        return undefined
      }
    }
    const own = load(rel)
    if (!own) return null
    const at = (d: string, p: string) => path.posix.normalize(path.posix.join(d, p))
    // Follow `extends` to its end (nearest config first), guarding against cycles and depth.
    const chain: { dir: string; options: Options }[] = []
    const seen = new Set<string>()
    let f: string | undefined = rel
    for (let depth = 0; f && depth <= 10 && !seen.has(f); depth++) {
      seen.add(f)
      const config = load(f)
      if (!config) break
      chain.push({ dir: path.posix.dirname(f), options: config.compilerOptions ?? {} })
      const ext = config.extends
      if (typeof ext !== "string" || !ext.startsWith(".")) break
      f = at(path.posix.dirname(f), ext)
      if (!f.endsWith(".json") && !this.files.has(f)) f += ".json"
      if (!this.files.has(f)) break
    }
    // A nearer config's compilerOptions override a farther one's (as TypeScript inheritance).
    const base = chain.find((c) => typeof c.options.baseUrl === "string")
    const baseUrl = base ? at(base.dir, base.options.baseUrl as string) : undefined
    const pathsSrc = chain.find((c) => c.options.paths && typeof c.options.paths === "object")
    const paths = pathsSrc?.options.paths as Record<string, unknown> | undefined
    // Paths are relative to baseUrl, or else to the config that declares them.
    const pathsDir = baseUrl ?? pathsSrc?.dir ?? path.posix.dirname(rel)
    const out: TsConfig = { baseUrl, paths: [] }
    if (paths && typeof paths === "object")
      for (const [pattern, targets] of Object.entries(paths)) {
        if (!Array.isArray(targets)) continue
        const star = pattern.indexOf("*")
        out.paths.push({
          prefix: star >= 0 ? pattern.slice(0, star) : pattern,
          suffix: star >= 0 ? pattern.slice(star + 1) : "",
          star: star >= 0,
          targets: targets.filter((t): t is string => typeof t === "string").map((t) => at(pathsDir, t)),
        })
      }
    // The longest prefix wins, as in TypeScript.
    out.paths.sort((a, b) => b.prefix.length - a.prefix.length)
    return out.baseUrl || out.paths.length ? out : null
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k)
  if (list) list.push(v)
  else m.set(k, [v])
}

/** JSON with comments and trailing commas (tsconfig.json) as plain JSON; strings are kept as they are. */
export function stripJsonComments(text: string): string {
  let out = ""
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      i = end < 0 ? text.length : end + 1
    } else out += c
  }
  return out.replace(/,(\s*[}\]])/g, "$1")
}

/** Resolve one import specifier of `from` to project files (empty for packages outside the project). */
function resolve(r: Resolver, from: string, spec: string, lang: Lang): string[] {
  const { files } = r
  const dir = path.posix.dirname(from)
  const first = (cands: string[]) => {
    const hit = cands.map((c) => path.posix.normalize(c)).find((c) => files.has(c))
    return hit ? [hit] : []
  }
  switch (lang) {
    case "ts":
    case "js": {
      // TypeScript ESM imports name the emitted .js file; jsFile tries the sources.
      if (spec.startsWith(".") || spec.startsWith("/")) {
        const hit = jsFile(path.posix.join(dir, spec), files)
        return hit ? [hit] : []
      }
      const ts = r.tsConfig(dir)
      if (ts) {
        for (const p of ts.paths) {
          const match = p.star ? spec.length >= p.prefix.length + p.suffix.length && spec.startsWith(p.prefix) && spec.endsWith(p.suffix) : spec === p.prefix
          if (!match) continue
          const rest = p.star ? spec.slice(p.prefix.length, spec.length - p.suffix.length) : ""
          for (const t of p.targets) {
            const hit = jsFile(t.replace("*", rest), files)
            if (hit) return [hit]
          }
        }
        if (ts.baseUrl) {
          const hit = jsFile(path.posix.join(ts.baseUrl, spec), files)
          if (hit) return [hit]
        }
      }
      return workspaceImport(r, spec)
    }
    case "py": {
      const dots = /^\.*/.exec(spec)![0].length
      const parts = spec.slice(dots).split(".").filter(Boolean)
      const tail = parts.join("/")
      if (dots) {
        let d = dir
        for (let i = 1; i < dots; i++) d = path.posix.dirname(d)
        const b = tail ? path.posix.join(d, tail) : d
        return first([`${b}.py`, `${b}/__init__.py`])
      }
      // Absolute imports: a project in a monorepo subdirectory owns its imports, so its root and
      // src/ layout come first; then the root, a src/ layout and the importing file's package.
      const root = r.pyRoot(dir)
      const bases = ["", "src/", "lib/", `${dir}/`]
      if (root && root !== ".") bases.unshift(`${root}/`, `${root}/src/`)
      for (const base of bases) {
        const hit = first([`${base}${tail}.py`, `${base}${tail}/__init__.py`])
        if (!hit.length) continue
        // Python runs each parent package's __init__.py before the module, so link those too.
        const inits = parts
          .slice(0, -1)
          .map((_, i) => path.posix.normalize(`${base}${parts.slice(0, i + 1).join("/")}/__init__.py`))
          .filter((p) => files.has(p))
        return [hit[0]!, ...inits]
      }
      // A top-level package owned by another project in a workspace (uv members): <pkg>.sub.
      const top = parts[0]
      for (const pkgDir of r.pyPackages().get(top ?? "") ?? []) {
        const rest = parts.slice(1).join("/")
        const h = first(rest ? [`${pkgDir}/${rest}.py`, `${pkgDir}/${rest}/__init__.py`] : [`${pkgDir}/__init__.py`])
        if (h.length) return h
      }
      return []
    }
    case "go": {
      // The longest matching module path wins; in a go.work layout that module may not be this file's.
      const mod = r
        .allGoModules()
        .filter((x) => spec === x.mod || spec.startsWith(`${x.mod}/`))
        .sort((a, b) => b.mod.length - a.mod.length)[0]
      if (!mod) return []
      const pkg = path.posix.join(mod.dir, spec.slice(mod.mod.length).replace(/^\//, ""))
      return (r.byDir.get(pkg) ?? []).filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"))
    }
    case "rs": {
      // The directory of this file's own module: a/mod.rs, a/lib.rs, a/main.rs are module a/; a/b.rs is a/b/.
      const owner = /(^|\/)(mod|lib|main)\.rs$/.test(from) ? dir : from.replace(/\.rs$/, "")
      if (spec.startsWith("mod:")) {
        const name = spec.slice(4)
        return first([`${owner}/${name}.rs`, `${owner}/${name}/mod.rs`])
      }
      const [head, ...rest] = spec.split("::")
      const base = head === "crate" ? srcRoot(from) : head === "super" ? path.posix.dirname(owner) : owner
      // `use crate::a::b::C` is a/b.rs or a/b/mod.rs (C is an item), or a.rs.
      for (let n = rest.length; n > 0; n--) {
        const p = path.posix.join(base, ...rest.slice(0, n))
        const hit = first([`${p}.rs`, `${p}/mod.rs`])
        if (hit.length) return hit
      }
      return []
    }
    case "java":
    case "kt": {
      const segs = spec.split(".")
      // `import a.b.*`: every Java/Kotlin file of package directory a/b.
      if (segs[segs.length - 1] === "*") {
        const pkg = segs.slice(0, -1).join("/")
        const dirs = (r.dirsByName.get(segs[segs.length - 2] ?? "") ?? []).filter((d) => d === pkg || d.endsWith(`/${pkg}`))
        const hit = dirs.flatMap((d) => (r.byDir.get(d) ?? []).filter((f) => /\.(java|kt)$/.test(f)))
        if (hit.length) return hit
        segs.pop() // `import static a.b.C.*`: members of class C
      }
      // A class `a.b.C`, or a member of one (`import static a.b.C.m`, nested `a.b.C.Inner`).
      for (let n = segs.length; n >= Math.min(2, segs.length); n--) {
        const p = segs.slice(0, n).join("/")
        const name = segs[n - 1]!
        const hit = [".java", ".kt"].flatMap((ext) => (r.byName.get(name + ext) ?? []).filter((f) => f === p + ext || f.endsWith(`/${p}${ext}`)))
        if (hit.length) return hit
      }
      return []
    }
    case "cs":
      // Namespaces do not map to files; C# files are not linked by imports in v1.
      return []
  }
}

/** Resolve a JS/TS path (with or without extension, or a directory) to a project file. */
function jsFile(base: string, files: Set<string>): string | undefined {
  const stem = base.replace(/\.(m|c)?js$/, "")
  return [base, ...JS_EXTS.map((e) => stem + e), ...JS_EXTS.map((e) => `${base}/index${e}`)].map((c) => path.posix.normalize(c)).find((c) => files.has(c))
}

/**
 * Packages of this project imported by name (monorepo workspaces): `@scope/pkg` resolves to
 * its source entry (an exports "source" condition, or the source twin of main/types/exports),
 * `@scope/pkg/sub` to that path inside the package.
 */
function workspaceImport(r: Resolver, spec: string): string[] {
  const m = /^((?:@[^/]+\/)?[^/]+)(?:\/(.+))?$/.exec(spec)
  const pkg = m && r.workspacePackages().get(m[1]!)
  if (!pkg) return []
  if (!m![2]) return pkg.entry ? [pkg.entry] : []
  const sub = path.posix.join(pkg.dir, m![2])
  const hit = jsFile(sub, r.files) ?? jsFile(path.posix.join(pkg.dir, "src", m![2]), r.files)
  return hit ? [hit] : []
}

const srcRoot = (from: string) => {
  const i = from.lastIndexOf("src/")
  return i >= 0 ? from.slice(0, i + 3) : "src"
}

export interface Graph {
  out: Map<string, string[]>
  in: Map<string, string[]>
}

interface CachedGraph {
  listKey: string
  /** The file info each file had (identity: unchanged content gives the same object). */
  infos: (FileInfo | undefined)[]
  deps: Map<string, string | undefined>
  graph: Graph
}

const graphs = new Lru<string, CachedGraph>(MAX_ROOTS)
const listKeys = new WeakMap<string[], string>()

/** A key for a file list's content, so a fresh listing of the same files reuses the graph. */
function listKey(files: string[]): string {
  let k = listKeys.get(files)
  if (k === undefined) {
    k = `${files.length}:${createHash("sha1").update(files.join("\0")).digest("hex")}`
    listKeys.set(files, k)
  }
  return k
}

/** The project's import graph (files → files they import, and the reverse). */
export function importGraph(project: Project): Graph {
  const key = listKey(project.files)
  const infos = project.files.map((f) => fileInfo(project, f))
  const hit = graphs.get(project.root)
  if (hit && hit.listKey === key && hit.infos.every((x, i) => x === infos[i]) && [...hit.deps].every(([f, text]) => readText(project, f) === text))
    return hit.graph
  const r = new Resolver(project)
  const graph: Graph = { out: new Map(), in: new Map() }
  project.files.forEach((f, i) => {
    const info = infos[i]
    if (!info) return
    const targets = [...new Set(info.specs.flatMap((s) => resolve(r, f, s, info.lang)))].filter((t) => t !== f)
    graph.out.set(f, targets)
    for (const t of targets) push(graph.in, t, f)
  })
  graphs.set(project.root, { listKey: key, infos, deps: r.deps, graph })
  return graph
}

export interface TestLink {
  test: string
  /** "is a test", "naming", "mirror", "imports it", "imports it via <importer>", "same package", "conftest.py fixtures" or "inline tests". */
  why: string
}

const BARREL = /(^|\/)(index|lib|mod|__init__)\.[a-z]+$/

/** Stems too generic to match tests by name alone outside the file's own directory. */
const GENERIC = new Set(["index", "main", "mod", "lib", "__init__", "utils", "util", "types", "helpers", "common", "app"])

const stemOf = (f: string) =>
  path.posix
    .basename(f)
    .replace(/\.[^.]+$/, "")
    .replace(/\.(test|spec)$/, "")
    .replace(/^test_/, "")
    .replace(/_test$/, "")
    .replace(/Tests?$/, "")

/** A test a runner executes directly (not a helper or fixture); mirrors verify's isRunnableTest. */
const isRunnableTest = (p: string) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) ||
  /(^|\/)__tests__\/.+\.[cm]?[jt]sx?$/.test(p) ||
  /(^|\/)test_[^/]+\.py$/.test(p) ||
  /[^/]_test\.(py|go)$/.test(p) ||
  /(^|\/)tests\/[^/]+\.rs$/.test(p) ||
  /[^/]Tests?\.(java|kt|cs)$/.test(p)

/**
 * The test files that cover each file: the file itself when it is a test; tests named
 * after it next to it or in a mirrored test directory; tests that import it (directly or
 * through re-exporting index/lib files, or, with `transitive`, through any chain of
 * imports including test helpers); the tests pytest loads a conftest.py for; for Go, the
 * package's tests; for Rust, the file's own `#[cfg(test)]` module.
 */
export function testsFor(project: Project, files: string[], opts: { transitive?: boolean } = {}): Map<string, TestLink[]> {
  const tests = project.files.filter((f) => isTestPath(f) && langOf(f))
  const graph = importGraph(project)
  // Non-test source files by stem, so a flat test name mirrors only an unambiguous file.
  const stemCount = new Map<string, number>()
  for (const f of project.files) {
    if (isTestPath(f) || !langOf(f)) continue
    const s = stemOf(f)
    stemCount.set(s, (stemCount.get(s) ?? 0) + 1)
  }
  const result = new Map<string, TestLink[]>()
  for (const file of files) {
    const links = new Map<string, string>()
    const add = (t: string, why: string) => {
      if (!links.has(t)) links.set(t, why)
    }
    if (isTestPath(file)) add(file, "is a test")
    const dir = path.posix.dirname(file)
    const stem = stemOf(file)
    const lang = langOf(file)
    // Path below a source root: src/a/b.ts → a/b, mirrored as test/a/b.test.ts, tests/a/test_b.py, …
    const inner = file.replace(/^(src|lib|app|pkg|internal)\//, "").replace(/\.[^.]+$/, "")
    for (const t of tests) {
      if (t === file) continue
      const tdir = path.posix.dirname(t)
      if (stemOf(t) === stem && (tdir === dir || tdir === `${dir}/__tests__` || tdir === `${dir}/tests` || tdir === `${dir}/test`)) add(t, "naming")
      else if (stemOf(t) === stem && !GENERIC.has(stem) && (mirrors(t, inner, stemCount.get(stem) ?? 0, file) || (lang === "cs" && csMirrors(t, file))))
        add(t, "mirror")
    }
    // Importers, and importers of re-exporting barrels (index.ts, lib.ts, __init__.py, mod.rs).
    // Breadth first, so each test is credited to its shortest import path.
    const seen = new Set([file])
    let frontier: { f: string; via?: string }[] = [{ f: file }]
    for (let depth = 0; frontier.length && depth < (opts.transitive ? 50 : 3); depth++) {
      const next: { f: string; via?: string }[] = []
      for (const { f, via } of frontier) {
        // A Go package's tests live next to it and never import their package: cover every
        // non-test Go file the walk visits, the changed file and each importer it walks through.
        if (langOf(f) === "go" && !isTestPath(f))
          for (const t of tests) if (t.endsWith("_test.go") && path.posix.dirname(t) === path.posix.dirname(f)) add(t, "same package")
        for (const importer of graph.in.get(f) ?? []) {
          if (seen.has(importer)) continue
          seen.add(importer)
          if (path.posix.basename(importer) === "conftest.py") {
            // pytest loads a conftest.py for every test under its directory, so a fixture it
            // defines covers tests that never import it.
            add(importer, via ? `imports it via ${via}` : "imports it")
            const cdir = path.posix.dirname(importer)
            for (const t of tests) if (t !== importer && (cdir === "." || t.startsWith(`${cdir}/`))) add(t, "conftest.py fixtures")
          } else if (isTestPath(importer)) {
            add(importer, via ? `imports it via ${via}` : "imports it")
            // Walk through a helper (test/helpers.ts), not a runnable test, to the tests importing it.
            if (opts.transitive && !isRunnableTest(importer)) next.push({ f: importer, via: via ?? importer })
          } else if (opts.transitive || BARREL.test(importer)) {
            next.push({ f: importer, via: via ?? importer })
          }
        }
      }
      frontier = next
    }
    if (lang === "rs" && /#\[cfg\(test\)\]/.test(readText(project, file) ?? "")) add(file, "inline tests")
    result.set(
      file,
      [...links].map(([test, why]) => ({ test, why })),
    )
  }
  return result
}

/** Does test path `t` mirror `inner` (a/b) under a test directory, ignoring test naming? */
function mirrors(t: string, inner: string, stemCount: number, file: string): boolean {
  const m = /(?:^|\/)(?:__tests__|tests?|spec)\/(.*)$/.exec(t)
  if (!m) return false
  const rel = m[1]!.replace(/\.[^.]+$/, "").replace(/\.(test|spec)$/, "")
  const name = (p: string) =>
    p
      .replace(/(^|\/)test_([^/]+)$/, "$1$2")
      .replace(/_test$/, "")
      .replace(/([^/])Tests?$/, "$1")
  const a = name(rel)
  // Same relative path always mirrors.
  if (a === inner) return true
  // The same file name when the test tree is flat: a bare name mirrors only an unambiguous
  // source — one file with that stem, or the test and source sharing their top-level directory.
  const flat = !a.includes("/")
  if (a === path.posix.basename(inner) || inner.endsWith(`/${a}`)) return !flat || stemCount === 1 || topDir(t) === topDir(file)
  return false
}

/** The first path segment ("a/b.ts" → "a"). */
const topDir = (p: string) => {
  const i = p.indexOf("/")
  return i < 0 ? p : p.slice(0, i)
}

/**
 * C# test projects mirror the project they test: `X.Tests/A/FooTests.cs` (or `X.Test/…`,
 * `Tests/…`, under `tests/` or `test/`) tests `X/A/Foo.cs` (under `src/` or not).
 */
function csMirrors(t: string, file: string): boolean {
  const norm = (p: string, test: boolean) => {
    let segs = p.replace(/\.cs$/i, "").split("/")
    if (segs.length > 1 && /^(src|tests?)$/i.test(segs[0]!)) segs = segs.slice(1)
    if (test) {
      const name = segs.pop()!.replace(/Tests?$/, "")
      segs = [...segs.filter((s) => !/^tests?$/i.test(s)).map((s) => s.replace(/\.Tests?$/i, "")), name]
    }
    return segs
  }
  const a = norm(t, true)
  const b = norm(file, false)
  if (a.join("/") === b.join("/")) return true
  // A flat test project: X.Tests/FooTests.cs for X/…/Foo.cs.
  return a.length === 2 && b.length > 2 && a[0] === b[0] && a[1] === b[b.length - 1]
}
