import fs from "node:fs"
import path from "node:path"
import { langOf, openProject, stripJsonComments, testsFor } from "@mcp-horde/context"
import { git, gitRaw, isTestPath, splitZ } from "@mcp-horde/core"
import { diffBase, isRunnableTest } from "./audit.js"
import type { Check } from "./detect.js"

/** How a test check was narrowed to the tests related to the changed files. */
export interface Narrowing {
  /** The command that ran instead of the check's own. */
  command?: string
  /** Related test files, relative to the check's directory. */
  tests: string[]
  /** Set when the check was not run at all. */
  skipped?: string
  /** Why the full suite ran instead (when it did). */
  full?: string
}

/** A path as one shell word: single quotes on POSIX shells (nothing expands inside), double quotes for cmd.exe. */
const quote = (p: string) => (/^[\w./@-]+$/.test(p) ? p : process.platform === "win32" ? `"${p.replace(/"/g, '\\"')}"` : `'${p.replace(/'/g, "'\\''")}'`)

const PYTEST = /(^|[\s/])(pytest|py\.test)(\s|$)|-m\s+pytest\b/
/** Pytest options whose value is the next word when written without `=`. */
const PYTEST_VALUES = new Set([
  "--ignore",
  "--ignore-glob",
  "--deselect",
  "--rootdir",
  "-c",
  "--confcutdir",
  "--basetemp",
  "--cov",
  "--cov-config",
  "-p",
  "-k",
  "-m",
  "-n",
  "--capture",
  "--color",
  "--durations",
  "--import-mode",
  "--junitxml",
  "--maxfail",
  "-o",
  "--override-ini",
  "-r",
  "--tb",
  "--timeout",
  "-W",
])
/** Shell syntax that whitespace splitting cannot take apart safely. */
const UNSAFE = /['"$;&|<>`]/
/** Files that mark the root of a Python project (as in the code map). */
const PY_ROOTS = ["pyproject.toml", "setup.py", "setup.cfg"]
const TSCONFIG = /^(tsconfig|jsconfig)([.\w-]*)\.json$/
const BUNDLER_CONFIG = /^(vite|vitest|webpack|rollup|rspack)\.config\.[cm]?[jt]s$/

/**
 * The check's command restricted to `tests` (paths relative to its directory), for runners
 * that take test paths: pytest, vitest, jest, `go test` (by package), and an npm `test`
 * script that is a plain vitest or jest call. Undefined when the runner cannot be narrowed.
 */
export function narrowCommand(check: Check, tests: string[]): string | undefined {
  const cmd = check.command.trim()
  const py = tests.filter((t) => t.endsWith(".py"))
  const js = tests.filter((t) => /\.[cm]?[jt]sx?$/.test(t))
  const go = [...new Set(tests.filter((t) => t.endsWith("_test.go")).map((t) => `./${path.posix.dirname(t)}`.replace(/^\.\/\.$/, ".")))]
  if (PYTEST.test(cmd)) return narrowPytest(check, cmd, py)
  // jest takes its arguments as regular expressions unless told they are paths.
  const runner = cmd.match(/(?:^|\s)(?:npx\s+)?(vitest|jest)(?:\s|$)/)?.[1]
  const byPath = (r: string | undefined) => (r === "jest" ? "--runTestsByPath " : "")
  if (runner && !/[;&|]/.test(cmd)) return js.length ? `${cmd} ${byPath(runner)}${js.map(quote).join(" ")}` : undefined
  if (/^go\s+test\b/.test(cmd) && /\s\.\/\.\.\.(\s|$)/.test(cmd)) return go.length ? cmd.replace(/\s\.\/\.\.\.(?=\s|$)/, ` ${go.join(" ")}`) : undefined
  if (/^npm\s+(test|run\s+test)$/.test(cmd) && js.length) {
    const script = npmScript(check.cwd, "test")
    // Only a single vitest/jest call with flags: anything else (chained commands, node --test
    // with its own file list, wrappers) cannot take extra paths safely.
    const m = script?.trim().match(/^(?:npx\s+)?(vitest(?:\s+run)?|jest)(?:\s+--?[\w-]+(?:=\S+)?)*$/)
    if (m) return `${cmd} -- ${byPath(m[1])}${js.map(quote).join(" ")}`
  }
  return undefined
}

/**
 * Narrow a pytest command: positional paths it already names are dropped, and only related
 * tests inside one of them are appended. A command that names no paths gets them all.
 */
function narrowPytest(check: Check, cmd: string, py: string[]): string | undefined {
  const tokens = cmd.split(/\s+/).filter(Boolean)
  const at = tokens.findIndex((t) => /(?:^|[\\/])(pytest|py\.test)$/.test(t))
  if (at < 0) return undefined
  const exists = (t: string) => fs.existsSync(path.resolve(check.cwd, t))
  const named = new Set<number>()
  if (!UNSAFE.test(cmd)) {
    for (let i = at + 1; i < tokens.length; i++) {
      const t = tokens[i]!
      if (t.startsWith("-")) {
        if (!t.includes("=") && PYTEST_VALUES.has(t)) i++
      } else if (exists(t)) named.add(i)
    }
  } else if (tokens.slice(at + 1).some((t) => !t.startsWith("-") && exists(t))) {
    // Quotes or operators: the words cannot be trusted, so a path-looking one means no narrowing.
    return undefined
  }
  if (!named.size) return py.length ? `${cmd} ${py.map(quote).join(" ")}` : undefined
  const paths = [...named].map((i) => path.relative(check.cwd, path.resolve(check.cwd, tokens[i]!)).replace(/\\/g, "/") || ".")
  const inside = (t: string) => paths.some((p) => p === "." || t === p || t.startsWith(`${p}/`))
  const keep = py.filter(inside)
  const rest = tokens.filter((_, i) => !named.has(i)).join(" ")
  return keep.length ? `${rest} ${keep.map(quote).join(" ")}` : undefined
}

function npmScript(dir: string, name: string): string | undefined {
  try {
    return (JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts?.[name]
  } catch {
    return undefined
  }
}

/**
 * Files changed from base (its merge-base with HEAD) to the working tree, tracked and untracked,
 * relative to the repository root. Without renames: a moved file is a deletion and an addition,
 * and both sides matter.
 */
export async function changedFiles(directory: string, base: string): Promise<{ root: string; files: string[] }> {
  const root = await git(directory, "rev-parse", "--show-toplevel")
  base = await diffBase(root, base)
  const Q = ["-c", "core.quotePath=false"]
  const diff = splitZ(await gitRaw(root, [...Q, "diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", base]))
  const untracked = splitZ(await gitRaw(root, [...Q, "ls-files", "--others", "--exclude-standard", "-z"]))
  return { root, files: [...new Set([...diff, ...untracked])] }
}

/**
 * Plan related-test runs for the test checks. The narrowing is conservative: the full suite
 * runs when any changed file is neither a test nor a source file with a known test (config,
 * manifests, fixtures, untested code), or when the runner cannot take paths. A test check
 * whose directory has no changes and no related tests is skipped. `untested` lists changed
 * source files no test covers.
 */
export function planRelated(root: string, changed: string[], checks: Check[]): { plans: Map<Check, Narrowing>; untested: string[] } {
  const plans = new Map<Check, Narrowing>()
  const tests = checks.filter((c) => c.kind === "test")
  // Nothing changed: nothing to narrow to, so the checks run as usual.
  if (!tests.length || !changed.length) return { plans, untested: [] }
  const project = openProject(root, { fresh: true })
  // What static imports cannot see makes every narrowing unsafe: run everything.
  if (project.capped) {
    for (const check of tests) plans.set(check, { tests: [], full: "the project has more files than the code map reads" })
    return { plans, untested: [] }
  }
  // Transitive: a test that reaches a changed file through any chain of imports runs too.
  const links = testsFor(
    project,
    changed.filter((f) => project.files.includes(f)),
    { transitive: true },
  )
  // Only runnable test files: a helper or fixture a link points at is not something to hand a runner.
  for (const [f, list] of links)
    links.set(
      f,
      list.filter((l) => isRunnableTest(l.test)),
    )
  const uncovered = changed.filter((f) => {
    // Only a test file the runner runs is its own test; conftest.py, helpers, fixtures and snapshots change others: run everything.
    if (isTestPath(f)) return !isRunnableTest(f)
    return !langOf(f) || !(links.get(f)?.length ?? 0)
  })
  const related = [...new Set([...links.values()].flat().map((l) => l.test))].filter((t) => project.files.includes(t))
  // Compare real paths: git reports long names, a check's cwd may carry a short (8.3) one on Windows.
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p)
    } catch {
      return path.resolve(p)
    }
  }
  const realRoot = real(root)
  const withinRoot = (p: string) => {
    const r = path.relative(realRoot, p)
    return r === "" || (r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r))
  }
  /** Is there a go.mod in `cwd` or a directory above it, up to the repository root? */
  const goMod = (cwd: string) => {
    for (let d = real(cwd); withinRoot(d); d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, "go.mod"))) return true
      if (d === realRoot) break
    }
    return false
  }
  const rel = (cwd: string, f: string) => path.relative(real(cwd), path.join(realRoot, f)).replace(/\\/g, "/")
  const inside = (cwd: string, f: string) => {
    const r = rel(cwd, f)
    return !r.startsWith("../") && r !== ".." && !path.isAbsolute(r)
  }
  for (const check of tests) {
    const aliases = jsRunner(check) ? aliasUnsafe(root, check) : undefined
    if (aliases) {
      plans.set(check, { tests: [], full: aliases })
      continue
    }
    const go = /^go\s+test\b/.test(check.command.trim())
    const mine = related
      .filter((t) => inside(check.cwd, t))
      .map((t) => rel(check.cwd, t))
      // A nested Go module is not part of this one's `./...`: its tests are another check's.
      .filter((t) => !go || !nestedModule(check.cwd, t, "go.mod"))
    if (uncovered.length) {
      plans.set(check, {
        tests: mine,
        full: `${uncovered.length} changed file(s) without related tests (${uncovered.slice(0, 3).join(", ")}${uncovered.length > 3 ? ", …" : ""})`,
      })
      continue
    }
    if (!mine.length) {
      if (changed.some((f) => inside(check.cwd, f))) plans.set(check, { tests: [], full: "no related tests in this check's directory" })
      else plans.set(check, { tests: [], skipped: "no changes and no related tests under its directory" })
      continue
    }
    // The code map resolves Go imports from the nearest go.mod and Python imports from the
    // nearest project root: narrowing is safe only when the check runs at one of them.
    const pyCheck = PYTEST.test(check.command)
    const pyRoot = real(check.cwd) === realRoot || PY_ROOTS.some((n) => fs.existsSync(path.join(check.cwd, n)))
    if (go ? !goMod(check.cwd) : pyCheck && !pyRoot) {
      plans.set(check, { tests: mine, full: go ? "no go.mod at or above its directory" : "its directory is not a Python project root" })
      continue
    }
    const command = narrowCommand(check, mine)
    plans.set(check, command ? { command, tests: mine } : { tests: mine, full: "its runner cannot be narrowed to test paths" })
  }
  // Source files the change touched that no test covers (and no test was changed for them).
  const untested = uncovered.filter((f) => langOf(f) && !isTestPath(f) && project.files.includes(f))
  return { plans, untested }
}

/** Does a directory between `cwd` (exclusive) and the file hold its own `manifest`? */
function nestedModule(cwd: string, file: string, manifest: string): boolean {
  for (let d = path.posix.dirname(file); d !== "." && d !== "/"; d = path.posix.dirname(d)) {
    if (fs.existsSync(path.join(cwd, d, manifest))) return true
  }
  return false
}

/** The runners whose module resolution follows import aliases; the others cannot be affected by them. */
function jsRunner(check: Check): boolean {
  const cmd = check.command.trim()
  if (PYTEST.test(cmd)) return false
  if (/(?:^|\s)(?:npx\s+)?(vitest|jest)(?:\s|$)/.test(cmd)) return true
  if (!/^npm\s+(test|run\s+test)$/.test(cmd)) return false
  return !!npmScript(check.cwd, "test")
    ?.trim()
    .match(/^(?:npx\s+)?(vitest(?:\s+run)?|jest)(?:\s+--?[\w-]+(?:=\S+)?)*$/)
}

/**
 * Import aliases the code map cannot follow, in the repository root or the check's own
 * directory. `compilerOptions.paths` in tsconfig.json/jsconfig.json is resolved by the code
 * map, and so is a bundler alias whose keys those paths cover.
 */
function aliasUnsafe(root: string, check: Check): string | undefined {
  for (const dir of new Set([root, check.cwd])) {
    const problem = aliasesAt(dir)
    if (!problem) continue
    const file = path.relative(root, problem.file).replace(/\\/g, "/") || path.basename(problem.file)
    return `check "${check.name}" is affected by import aliases in ${file}: ${problem.why}`
  }
  return undefined
}

function aliasesAt(dir: string): { file: string; why: string } | undefined {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return undefined
  }
  for (const n of names) {
    if (n === "tsconfig.json" || n === "jsconfig.json" || !TSCONFIG.test(n)) continue
    if (/"paths"\s*:/.test(read(path.join(dir, n)))) return { file: path.join(dir, n), why: "paths in a tsconfig file the code map does not read" }
  }
  const pkg = path.join(dir, "package.json")
  try {
    if ((JSON.parse(read(pkg)) as { imports?: unknown }).imports) return { file: pkg, why: "package.json imports are not resolved by the code map" }
  } catch {
    // No package.json, or not ours to judge.
  }
  const paths = tsPaths(dir)
  for (const n of names) {
    if (!BUNDLER_CONFIG.test(n)) continue
    const why = bundlerAlias(read(path.join(dir, n)), paths)
    if (why) return { file: path.join(dir, n), why }
  }
  return undefined
}

/** The `paths` patterns of the nearest tsconfig.json/jsconfig.json, which the code map reads. */
function tsPaths(dir: string): string[] {
  for (const n of ["tsconfig.json", "jsconfig.json"]) {
    const file = path.join(dir, n)
    if (!fs.existsSync(file)) continue
    try {
      const data = JSON.parse(stripJsonComments(read(file))) as { compilerOptions?: { paths?: unknown } }
      const paths = data.compilerOptions?.paths
      // The code map reads only an object of patterns; anything else covers nothing.
      return paths && typeof paths === "object" && !Array.isArray(paths) ? Object.keys(paths) : []
    } catch {
      return []
    }
  }
  return []
}

/** Why a bundler config's aliases are unsafe, or undefined when it has none or all are covered. */
function bundlerAlias(text: string, paths: string[]): string | undefined {
  const src = stripJsonComments(text)
  // Only a flat object literal is readable; nested braces leave the alias word outside a match.
  const alias = /\balias\s*:\s*\{([^{}]*)\}/g
  let last = 0
  while (true) {
    const m = alias.exec(src)
    if (!m) break
    if (/\balias\b/.test(src.slice(last, m.index))) return "an alias that is not a plain object literal"
    const body = m[1]!
    if (/\.\.\.|\[/.test(body)) return "an alias that is not a plain object literal"
    const keys = [...body.matchAll(/(?:^|,)\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$-]*))\s*:/g)].map((k) => k[1] ?? k[2] ?? k[3])
    if (!keys.length && body.trim()) return "an alias that is not a plain object literal"
    if (!keys.every((key) => paths.some((p) => covers(p, key!))))
      return paths.length ? "a bundler alias not covered by tsconfig.json paths" : "a bundler alias without tsconfig.json paths"
    last = alias.lastIndex
  }
  if (/\balias\b/.test(src.slice(last))) return "an alias that is not a plain object literal"
  return undefined
}

/** Is alias key `key` covered by tsconfig `paths` pattern `pattern` (`@` by `@/*` or `@`)? */
function covers(pattern: string, key: string): boolean {
  if (pattern === key) return true
  const star = pattern.indexOf("*")
  if (star < 0) return false
  const prefix = pattern.slice(0, star)
  const suffix = pattern.slice(star + 1)
  if (prefix.endsWith("/") && !suffix && key === prefix.slice(0, -1)) return true
  return key.length >= prefix.length + suffix.length && key.startsWith(prefix) && key.endsWith(suffix)
}

function read(file: string): string {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return ""
  }
}
