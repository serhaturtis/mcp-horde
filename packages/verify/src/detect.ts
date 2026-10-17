import fs from "node:fs"
import path from "node:path"
import { git, loadHordeFile } from "@mcp-horde/core"

export type CheckKind = "test" | "typecheck" | "lint" | "build" | "other"

export interface Check {
  name: string
  command: string
  kind: CheckKind
  /** Directory the command runs in. */
  cwd: string
  /** Where the check came from, for the detect report. */
  source: string
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
  const horde = loadHordeFile(directory)
  const v = (horde.data.verify ?? {}) as Record<string, unknown>
  const where = `${horde.file ?? "horde.json"} verify`
  let checks: Check[] | undefined
  if (v.checks !== undefined) {
    if (!v.checks || typeof v.checks !== "object" || Array.isArray(v.checks)) throw new Error(`${where}.checks must be an object of name → command`)
    checks = Object.entries(v.checks as Record<string, unknown>).map(([name, spec]) => {
      const s = typeof spec === "string" ? { command: spec } : (spec as { command?: unknown; kind?: unknown; cwd?: unknown })
      if (!s || typeof s.command !== "string" || !s.command.trim()) throw new Error(`${where}.checks.${name} needs a command`)
      const kind = (s.kind ?? kindOf(name)) as CheckKind
      if (!["test", "typecheck", "lint", "build", "other"].includes(kind)) throw new Error(`${where}.checks.${name}.kind is invalid`)
      const cwd = typeof s.cwd === "string" ? path.resolve(horde.root, s.cwd) : horde.root
      return { name, command: s.command, kind, cwd, source: "horde.json" }
    })
  }
  const audit = (v.audit ?? {}) as Record<string, unknown>
  const block = categories(audit.block, `${where}.audit.block`) ?? DEFAULT_BLOCK
  const warn = (categories(audit.warn, `${where}.audit.warn`) ?? DEFAULT_WARN).filter((c) => !block.includes(c))
  const off = categories(audit.off, `${where}.audit.off`) ?? []
  const allowed = audit.allowed ?? []
  if (!Array.isArray(allowed) || allowed.some((a) => typeof a !== "string")) throw new Error(`${where}.audit.allowed must be a list of globs`)
  const timeout = v.timeoutSeconds ?? 600
  if (typeof timeout !== "number" || timeout <= 0) throw new Error(`${where}.timeoutSeconds must be a positive number`)
  return {
    root: horde.root,
    configFile: horde.file,
    checks,
    timeoutMs: timeout * 1000,
    audit: { block: block.filter((c) => !off.includes(c)), warn: warn.filter((c) => !off.includes(c)), allowed: allowed as string[] },
  }
}

function kindOf(name: string): CheckKind {
  if (/test|spec|unit|integration|e2e/i.test(name)) return "test"
  if (/type|tsc|mypy|pyright/i.test(name)) return "typecheck"
  if (/lint|ruff|clippy|vet|format|fmt/i.test(name)) return "lint"
  if (/build|compile/i.test(name)) return "build"
  return "other"
}

const ORDER: Record<CheckKind, number> = { typecheck: 0, lint: 1, build: 2, test: 3, other: 4 }

/**
 * The checks for a directory: horde.json's when it defines any, otherwise
 * detected from the manifests of the nearest project root (walking up to the
 * repository root, so an agent in a subdirectory of a monorepo package still
 * finds that package's scripts).
 */
export async function detectChecks(directory: string, settings = loadSettings(directory)): Promise<Check[]> {
  if (settings.checks) return settings.checks
  const top = await git(directory, "rev-parse", "--show-toplevel").catch(() => undefined)
  const stop = top ? path.resolve(top) : path.parse(path.resolve(directory)).root
  let dir = path.resolve(directory)
  for (;;) {
    const found = detectIn(dir)
    if (found.length) return found.sort((a, b) => ORDER[a.kind] - ORDER[b.kind])
    if (dir === stop || path.dirname(dir) === dir) return []
    dir = path.dirname(dir)
  }
}

const PLACEHOLDER_TEST = /no test specified/

function detectIn(dir: string): Check[] {
  const out: Check[] = []
  const has = (f: string) => fs.existsSync(path.join(dir, f))
  const read = (f: string) => {
    try {
      return fs.readFileSync(path.join(dir, f), "utf8")
    } catch {
      return ""
    }
  }
  const add = (name: string, command: string, kind: CheckKind, source: string) => out.push({ name, command, kind, cwd: dir, source })

  // JavaScript / TypeScript
  if (has("package.json")) {
    let scripts: Record<string, string> = {}
    try {
      scripts = (JSON.parse(read("package.json")) as { scripts?: Record<string, string> }).scripts ?? {}
    } catch {
      // A broken package.json is the project's problem; detect the rest.
    }
    const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm"
    const run = (s: string) => (pm === "npm" ? (s === "test" ? "npm test" : `npm run ${s}`) : `${pm} run ${s}`)
    const typecheck = ["typecheck", "type-check", "check-types", "tsc"].find((s) => scripts[s])
    if (typecheck) add("typecheck", run(typecheck), "typecheck", `package.json scripts.${typecheck}`)
    const lint = ["lint", "check"].find((s) => scripts[s])
    if (lint) add("lint", run(lint), "lint", `package.json scripts.${lint}`)
    if (!typecheck && scripts.build) add("build", run("build"), "build", "package.json scripts.build")
    if (scripts.test && !PLACEHOLDER_TEST.test(scripts.test)) add("test", run("test"), "test", "package.json scripts.test")
  }

  // Python
  const pyproject = read("pyproject.toml")
  if (pyproject || has("setup.py") || has("setup.cfg") || has("pytest.ini") || has("tox.ini")) {
    const venv = [".venv/bin/python", "venv/bin/python", ".venv/Scripts/python.exe"].find(has)
    const py = venv ? `"${path.join(dir, venv)}"` : process.platform === "win32" ? "python" : "python3"
    if (/\[tool\.mypy\]/.test(pyproject) || has("mypy.ini")) add("typecheck", `${py} -m mypy .`, "typecheck", "mypy config")
    if (/\[tool\.ruff/.test(pyproject) || has("ruff.toml") || has(".ruff.toml")) add("lint", `${py} -m ruff check .`, "lint", "ruff config")
    const testsDir = ["tests", "test"].some((d) => fs.existsSync(path.join(dir, d)))
    if (/\[tool\.pytest/.test(pyproject) || has("pytest.ini") || /\[tool:pytest\]/.test(read("setup.cfg")) || has("conftest.py") || testsDir) {
      add("test", `${py} -m pytest -q`, "test", "pytest")
    }
  }

  // Rust
  if (has("Cargo.toml")) add("test", "cargo test --color never", "test", "Cargo.toml")

  // Go
  if (has("go.mod")) {
    add("vet", "go vet ./...", "lint", "go.mod")
    add("test", "go test ./...", "test", "go.mod")
  }

  // Make, only when nothing more specific was found.
  if (!out.length && (has("Makefile") || has("makefile"))) {
    const mk = read("Makefile") || read("makefile")
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
