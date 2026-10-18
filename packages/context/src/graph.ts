import path from "node:path"
import { isTestPath } from "@mcp-horde/core"
import { type Project, readText } from "./files.js"
import { type Definition, importSpecs, type Lang, langOf, patternDefinitions } from "./lang.js"
import { type Parsed, parse } from "./syntax.js"

export interface FileInfo {
  lang: Lang
  defs: Definition[]
  /** Import specifiers as written. */
  specs: string[]
  /** Comment and string spans, when the file was parsed (see syntax.isCode). */
  spans?: Parsed["spans"]
}

const infos = new Map<string, { text: string; info: FileInfo }>()

/** Definitions and imports of one source file (undefined for other files). Cached by content. */
export function fileInfo(project: Project, rel: string): FileInfo | undefined {
  const lang = langOf(rel)
  if (!lang) return undefined
  const text = readText(project, rel)
  if (text === undefined) return undefined
  const key = path.join(project.root, rel)
  const hit = infos.get(key)
  if (hit && hit.text === text) return hit.info
  const parsed = parse(text, lang, rel)
  const info = { lang, defs: parsed?.defs ?? patternDefinitions(text, lang), specs: importSpecs(text, lang), spans: parsed?.spans }
  if (infos.size > 20_000) infos.clear()
  infos.set(key, { text, info })
  return info
}

const JS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]

/** Resolve one import specifier of `from` to project files (empty for packages outside the project). */
export function resolve(project: Project, from: string, spec: string, lang: Lang, files: Set<string>): string[] {
  const dir = path.posix.dirname(from)
  const first = (cands: string[]) => {
    const hit = cands.map((c) => path.posix.normalize(c)).find((c) => files.has(c))
    return hit ? [hit] : []
  }
  switch (lang) {
    case "ts":
    case "js": {
      if (!spec.startsWith(".") && !spec.startsWith("/")) return workspaceImport(project, spec, files)
      // TypeScript ESM imports name the emitted .js file; jsFile tries the sources.
      const hit = jsFile(path.posix.join(dir, spec), files)
      return hit ? [hit] : []
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
      // Absolute imports: from the root, a src/ layout, or the importing file's package.
      return first(["", "src/", "lib/", `${dir}/`].flatMap((p) => [`${p}${tail}.py`, `${p}${tail}/__init__.py`]))
    }
    case "go": {
      const mod = goModule(project)
      if (!mod || !(spec === mod || spec.startsWith(`${mod}/`))) return []
      const pkg = spec.slice(mod.length).replace(/^\//, "")
      return [...files].filter((f) => path.posix.dirname(f) === (pkg || ".") && f.endsWith(".go") && !f.endsWith("_test.go"))
    }
    case "rs": {
      if (spec.startsWith("mod:")) {
        const name = spec.slice(4)
        // `mod x;` in a/mod.rs, a/lib.rs or a/main.rs means a/x.rs; in a/b.rs it means a/b/x.rs.
        const owner = /(^|\/)(mod|lib|main)\.rs$/.test(from) ? dir : from.replace(/\.rs$/, "")
        return first([`${owner}/${name}.rs`, `${owner}/${name}/mod.rs`])
      }
      const [head, ...rest] = spec.split("::")
      const base = head === "crate" ? srcRoot(from) : head === "super" ? path.posix.dirname(dir) : dir
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
      const p = spec.replace(/\./g, "/")
      return [...files].filter((f) => /\.(java|kt)$/.test(f) && (f.endsWith(`/${p}.java`) || f.endsWith(`/${p}.kt`)))
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

const workspaces = new Map<string, { files: string[]; packages: Map<string, { dir: string; entry?: string }> }>()

/**
 * Packages of this project imported by name (monorepo workspaces): `@scope/pkg` resolves to
 * its source entry (an exports "source" condition, or the source twin of main/types/exports),
 * `@scope/pkg/sub` to that path inside the package.
 */
function workspaceImport(project: Project, spec: string, files: Set<string>): string[] {
  let ws = workspaces.get(project.root)
  if (!ws || ws.files !== project.files) {
    const packages = new Map<string, { dir: string; entry?: string }>()
    for (const pj of project.files.filter((f) => /(^|\/)package\.json$/.test(f))) {
      let data: { name?: string; main?: string; types?: string; exports?: unknown }
      try {
        data = JSON.parse(readText(project, pj) ?? "{}")
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
        entry = jsFile(p.replace(/^(.*?)(dist|build|lib)\//, "$1src/").replace(/\.d\.ts$/, ".ts"), files) ?? jsFile(p, files)
        if (entry) break
      }
      packages.set(data.name, { dir: dir === "." ? "" : dir, entry: entry ?? jsFile(root("src/index"), files) ?? jsFile(root("index"), files) })
    }
    ws = { files: project.files, packages }
    workspaces.set(project.root, ws)
  }
  const m = /^((?:@[^/]+\/)?[^/]+)(?:\/(.+))?$/.exec(spec)
  const pkg = m && ws.packages.get(m[1]!)
  if (!pkg) return []
  if (!m![2]) return pkg.entry ? [pkg.entry] : []
  const sub = path.posix.join(pkg.dir, m![2])
  const hit = jsFile(sub, files) ?? jsFile(path.posix.join(pkg.dir, "src", m![2]), files)
  return hit ? [hit] : []
}

const srcRoot = (from: string) => {
  const i = from.lastIndexOf("src/")
  return i >= 0 ? from.slice(0, i + 3) : "src"
}

const goMods = new Map<string, string | undefined>()
function goModule(project: Project): string | undefined {
  if (goMods.has(project.root)) return goMods.get(project.root)
  const text = readText(project, "go.mod")
  const mod = text ? /^module\s+(\S+)/m.exec(text)?.[1] : undefined
  goMods.set(project.root, mod)
  return mod
}

export interface Graph {
  out: Map<string, string[]>
  in: Map<string, string[]>
}

const graphs = new Map<string, { files: string[]; graph: Graph }>()

/** The project's import graph (files → files they import, and the reverse). */
export function importGraph(project: Project): Graph {
  const hit = graphs.get(project.root)
  if (hit && hit.files === project.files) return hit.graph
  const files = new Set(project.files)
  const graph: Graph = { out: new Map(), in: new Map() }
  for (const f of project.files) {
    const info = fileInfo(project, f)
    if (!info) continue
    const targets = [...new Set(info.specs.flatMap((s) => resolve(project, f, s, info.lang, files)))].filter((t) => t !== f)
    graph.out.set(f, targets)
    for (const t of targets) {
      const list = graph.in.get(t) ?? []
      list.push(f)
      graph.in.set(t, list)
    }
  }
  graphs.set(project.root, { files: project.files, graph })
  return graph
}

export interface TestLink {
  test: string
  /** "is a test", "naming", "mirror", "imports it", "imports it via <barrel>", "same package" or "inline tests". */
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

/**
 * The test files that cover each file: the file itself when it is a test; tests named
 * after it next to it or in a mirrored test directory; tests that import it (directly or
 * through re-exporting index/lib files, or, with `transitive`, through any chain of
 * imports); for Go, the package's tests; for Rust, the file's own `#[cfg(test)]` module.
 */
export function testsFor(project: Project, files: string[], opts: { transitive?: boolean } = {}): Map<string, TestLink[]> {
  const tests = project.files.filter((f) => isTestPath(f) && langOf(f))
  const graph = importGraph(project)
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
      else if (stemOf(t) === stem && !GENERIC.has(stem) && mirrors(t, inner)) add(t, "mirror")
    }
    // Importers, and importers of re-exporting barrels (index.ts, lib.ts, __init__.py, mod.rs).
    // Breadth first, so each test is credited to its shortest import path.
    const seen = new Set([file])
    let frontier: { f: string; via?: string }[] = [{ f: file }]
    for (let depth = 0; frontier.length && depth < (opts.transitive ? 50 : 3); depth++) {
      const next: { f: string; via?: string }[] = []
      for (const { f, via } of frontier) {
        for (const importer of graph.in.get(f) ?? []) {
          if (seen.has(importer)) continue
          seen.add(importer)
          if (isTestPath(importer)) add(importer, via ? `imports it via ${via}` : "imports it")
          else if (opts.transitive || BARREL.test(importer)) next.push({ f: importer, via: via ?? importer })
        }
      }
      frontier = next
    }
    if (lang === "go") for (const t of tests) if (t.endsWith("_test.go") && path.posix.dirname(t) === dir) add(t, "same package")
    if (lang === "rs" && /#\[cfg\(test\)\]/.test(readText(project, file) ?? "")) add(file, "inline tests")
    result.set(
      file,
      [...links].map(([test, why]) => ({ test, why })),
    )
  }
  return result
}

/** Does test path `t` mirror `inner` (a/b) under a test directory, ignoring test naming? */
function mirrors(t: string, inner: string): boolean {
  const m = /(?:^|\/)(?:__tests__|tests?|spec)\/(.*)$/.exec(t)
  if (!m) return false
  const rel = m[1]!.replace(/\.[^.]+$/, "").replace(/\.(test|spec)$/, "")
  const name = (p: string) =>
    p
      .replace(/(^|\/)test_([^/]+)$/, "$1$2")
      .replace(/_test$/, "")
      .replace(/([^/])Tests?$/, "$1")
  const a = name(rel)
  // Same relative path, or the same file name when the test tree is flat.
  return a === inner || a === path.posix.basename(inner) || inner.endsWith(`/${a}`)
}
