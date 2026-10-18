import fs from "node:fs"
import path from "node:path"
import { langOf, openProject, testsFor } from "@mcp-horde/context"
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
  if (PYTEST.test(cmd)) return py.length ? `${cmd} ${py.map(quote).join(" ")}` : undefined
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
  const unsafe = project.capped
    ? `the project has more files than the code map reads`
    : usesAliases(
          root,
          tests.map((c) => c.cwd),
        )
      ? "the project uses import aliases"
      : undefined
  if (unsafe) {
    for (const check of tests) plans.set(check, { tests: [], full: unsafe })
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
  const rel = (cwd: string, f: string) => path.relative(real(cwd), path.join(realRoot, f)).replace(/\\/g, "/")
  const inside = (cwd: string, f: string) => {
    const r = rel(cwd, f)
    return !r.startsWith("../") && r !== ".." && !path.isAbsolute(r)
  }
  for (const check of tests) {
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
    // The code map resolves Python and Go imports from the repository root (and its go.mod):
    // a project rooted elsewhere would have importers it cannot see.
    const pyOrGo = go || PYTEST.test(check.command)
    if (pyOrGo && (real(check.cwd) !== realRoot || (go && !fs.existsSync(path.join(root, "go.mod"))))) {
      plans.set(check, { tests: mine, full: `its ${go ? "Go module" : "Python project"} is not at the repository root` })
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

/**
 * Import aliases (tsconfig/jsconfig `paths`, package.json `imports`, bundler `alias`) point at
 * files under names the code map does not resolve, so their importers would be missed.
 */
function usesAliases(root: string, dirs: string[]): boolean {
  const read = (f: string) => {
    try {
      return fs.readFileSync(f, "utf8")
    } catch {
      return ""
    }
  }
  for (const dir of new Set([root, ...dirs])) {
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const n of names) {
      // tsconfig files are JSONC (comments, trailing commas, `extends`): a key match is enough.
      if (/^(tsconfig|jsconfig)([.\w-]*)\.json$/.test(n) && /"paths"\s*:/.test(read(path.join(dir, n)))) return true
      if (/^(vite|vitest|webpack|rollup|rspack)\.config\.[cm]?[jt]s$/.test(n) && /\balias\b/.test(read(path.join(dir, n)))) return true
    }
    try {
      if ((JSON.parse(read(path.join(dir, "package.json"))) as { imports?: unknown }).imports) return true
    } catch {
      // No package.json, or not ours to judge.
    }
  }
  return false
}
