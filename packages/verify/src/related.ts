import fs from "node:fs"
import path from "node:path"
import { langOf, openProject, testsFor } from "@mcp-horde/context"
import { git, gitRaw, isTestPath, splitZ } from "@mcp-horde/core"
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

const quote = (p: string) => (/^[\w./@-]+$/.test(p) ? p : `"${p.replace(/"/g, '\\"')}"`)

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
  if (/(^|[\s/])(pytest|py\.test)(\s|$)|-m\s+pytest\b/.test(cmd)) return py.length ? `${cmd} ${py.map(quote).join(" ")}` : undefined
  if (/(^|\s)(npx\s+)?(vitest|jest)(\s|$)/.test(cmd) && !/[;&|]/.test(cmd)) return js.length ? `${cmd} ${js.map(quote).join(" ")}` : undefined
  if (/^go\s+test\b/.test(cmd) && /\s\.\/\.\.\.(\s|$)/.test(cmd)) return go.length ? cmd.replace(/\s\.\/\.\.\.(?=\s|$)/, ` ${go.join(" ")}`) : undefined
  if (/^npm\s+(test|run\s+test)$/.test(cmd) && js.length) {
    const script = npmScript(check.cwd, "test")
    // Only a single vitest/jest call with flags: anything else (chained commands, node --test
    // with its own file list, wrappers) cannot take extra paths safely.
    if (script && /^(npx\s+)?(vitest(\s+run)?|jest)(\s+--?[\w-]+(=\S+)?)*$/.test(script.trim())) return `${cmd} -- ${js.map(quote).join(" ")}`
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

/** Files changed from base to the working tree (tracked and untracked), relative to the repository root. */
export async function changedFiles(directory: string, base: string): Promise<{ root: string; files: string[] }> {
  const root = await git(directory, "rev-parse", "--show-toplevel")
  const Q = ["-c", "core.quotePath=false"]
  const diff = splitZ(await gitRaw(root, [...Q, "diff", "--no-ext-diff", "--name-only", "-z", base]))
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
  // Transitive: a test that reaches a changed file through any chain of imports runs too.
  const links = testsFor(
    project,
    changed.filter((f) => project.files.includes(f)),
    { transitive: true },
  )
  const uncovered = changed.filter((f) => {
    if (isTestPath(f)) return !langOf(f) // fixtures and snapshots in test directories: run everything
    return !langOf(f) || !(links.get(f)?.length ?? 0)
  })
  const related = [...new Set([...links.values()].flat().map((l) => l.test))].filter((t) => project.files.includes(t))
  const rel = (cwd: string, f: string) => path.relative(cwd, path.join(root, f)).replace(/\\/g, "/")
  const inside = (cwd: string, f: string) => {
    const r = rel(cwd, f)
    return !r.startsWith("../") && r !== ".." && !path.isAbsolute(r)
  }
  for (const check of tests) {
    const mine = related.filter((t) => inside(check.cwd, t)).map((t) => rel(check.cwd, t))
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
    const command = narrowCommand(check, mine)
    plans.set(check, command ? { command, tests: mine } : { tests: mine, full: "its runner cannot be narrowed to test paths" })
  }
  // Source files the change touched that no test covers (and no test was changed for them).
  const untested = uncovered.filter((f) => langOf(f) && !isTestPath(f) && project.files.includes(f))
  return { plans, untested }
}
