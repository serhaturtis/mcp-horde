import fs from "node:fs/promises"
import path from "node:path"
import { git, gitRaw, splitZ } from "@mcp-horde/core"
import type { AuditCategory } from "./detect.js"

export interface Finding {
  category: AuditCategory
  severity: "block" | "warn"
  file?: string
  line?: number
  text: string
}

export interface AuditOptions {
  /** Commit (or ref) the work started from. */
  base: string
  /** Globs (relative to the repository root) every changed path must match; empty = no scope check. */
  allowed?: string[]
  block: AuditCategory[]
  warn: AuditCategory[]
}

export interface AuditResult {
  base: string
  /** Changed paths, relative to the repository root. */
  files: string[]
  commits: number
  findings: Finding[]
}

interface Change {
  path: string
  /** A, M, D, R, C, T (git name-status), or "?" for untracked. */
  status: string
  from?: string
  added: { line: number; text: string }[]
  removed: string[]
  binary: boolean
}

/** Paths as they are, not octal-escaped. */
const Q = ["-c", "core.quotePath=false"]
const MAX_SCAN_BYTES = 1024 * 1024
const BIG_FILE = 1024 * 1024

export const isTestPath = (p: string) =>
  /(^|\/)(__tests__|tests?|spec)\//.test(p) ||
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) ||
  /(^|\/)test_[^/]+\.py$/.test(p) ||
  /_test\.(go|py)$/.test(p) ||
  /(^|\/)tests\/[^/]+\.rs$/.test(p)

/** Assertions in the common test frameworks (counted per occurrence, not per line). */
const ASSERTION = /\b(assert\w*|expect|should|assertEquals|assertThat|require\.\w+|t\.(Error|Fatal)\w*)\s*[.(!]/g
const assertions = (lines: string[]) => lines.reduce((n, l) => n + (l.match(ASSERTION)?.length ?? 0), 0)

const SKIP_MARKERS: [RegExp, string][] = [
  [/\b(describe|it|test|context|suite)\.only\s*\(/, "focuses tests with .only (all others stop running)"],
  [/\b(describe|it|test|context|suite)\.skip\s*\(|\bx(it|describe|test)\s*\(/, "skips a test"],
  [/@pytest\.mark\.(skip|xfail)\b|@unittest\.skip|pytest\.skip\(/, "skips a test"],
  [/\bt\.Skip(Now|f)?\(/, "skips a test"],
  [/#\[ignore\]/, "ignores a test"],
  [/\{\s*skip:\s*true\s*\}|\btest\.todo\(/, "skips a test"],
]

const SUPPRESSIONS: [RegExp, string][] = [
  [/@ts-ignore|@ts-nocheck/, "silences the type checker (@ts-ignore/@ts-nocheck)"],
  [/@ts-expect-error\s*$/, "@ts-expect-error without a reason"],
  [/eslint-disable|biome-ignore|oxlint-disable/, "disables a lint rule"],
  [/#\s*type:\s*ignore|#\s*noqa|#\s*pyright:\s*ignore/, "silences a Python checker"],
  [/#!?\[allow\(|\/\/\s*nolint/, "allows a lint the project denies"],
  [/\bas\s+any\b|\bas\s+unknown\s+as\b/, "casts through any/unknown"],
  [/catch\s*(\(\s*\w*\s*\))?\s*\{\s*\}|\.catch\(\s*\(\)\s*=>\s*(\{\s*\}|undefined|null)\s*\)/, "swallows errors (empty catch)"],
  [/except(\s+\w+(\s+as\s+\w+)?)?\s*:\s*pass\b/, "swallows errors (except: pass)"],
]

const SECRETS: [RegExp, string][] = [
  [/AKIA[0-9A-Z]{16}/, "an AWS access key"],
  [/-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, "a private key"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b|github_pat_[A-Za-z0-9_]{40,}/, "a GitHub token"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}/, "an API secret key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"],
  [/(api[_-]?key|secret|passw(or)?d|token)["']?\s*[:=]\s*["'][^"'\s]{16,}["']/i, "a hard-coded credential"],
]

const LOCKFILES =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|composer\.lock|Gemfile\.lock)$/

/** Minimal gitignore-style globs: `**`, `*`, `?`; a trailing `/` means the whole directory; no slash matches at any depth. */
export function globMatcher(globs: string[]): (p: string) => boolean {
  const res = globs.map((g) => {
    let pat = g.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "")
    if (pat.endsWith("/")) pat += "**"
    const anyDepth = !pat.includes("/")
    let re = ""
    for (let i = 0; i < pat.length; i++) {
      const c = pat[i]!
      if (c === "*" && pat[i + 1] === "*") {
        re += pat[i + 2] === "/" ? "(?:.*/)?" : ".*"
        i += pat[i + 2] === "/" ? 2 : 1
      } else if (c === "*") re += "[^/]*"
      else if (c === "?") re += "[^/]"
      else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    }
    // A directory pattern also covers everything below it.
    return new RegExp(`^${anyDepth ? "(?:.*/)?" : ""}${re}(?:/.*)?$`)
  })
  return (p) => res.some((r) => r.test(p))
}

async function changes(root: string, base: string): Promise<Change[]> {
  const byPath = new Map<string, Change>()
  const nameStatus = splitZ(await gitRaw(root, [...Q, "diff", "--no-ext-diff", "-M", "--name-status", "-z", base]))
  for (let i = 0; i < nameStatus.length; ) {
    const status = nameStatus[i++]!
    if (/^[RC]/.test(status)) {
      const from = nameStatus[i++]!
      const to = nameStatus[i++]!
      byPath.set(to, { path: to, status: status[0]!, from, added: [], removed: [], binary: false })
    } else {
      const p = nameStatus[i++]!
      byPath.set(p, { path: p, status: status[0]!, added: [], removed: [], binary: false })
    }
  }
  // numstat -z: "added<TAB>deleted<TAB>path<NUL>", or for renames "added<TAB>deleted<TAB><NUL>from<NUL>to<NUL>"; "-" counts mean binary.
  const numstat = splitZ(await gitRaw(root, [...Q, "diff", "--no-ext-diff", "-M", "--numstat", "-z", base]))
  for (let i = 0; i < numstat.length; i++) {
    const m = numstat[i]!.match(/^(-|\d+)\t(-|\d+)\t(.*)$/)
    if (!m) continue
    let p = m[3]!
    if (!p) {
      i += 2
      p = numstat[i] ?? ""
    }
    const c = byPath.get(p)
    if (c && m[1] === "-") c.binary = true
  }
  // Added and removed lines, from a zero-context diff that does not depend on user config.
  const diff = await gitRaw(root, [...Q, "-c", "color.ui=never", "-c", "diff.noprefix=false", "diff", "--no-ext-diff", "--no-textconv", "-M", "-U0", base])
  let current: Change | undefined
  let lineNo = 0
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff --git ")) {
      current = undefined
      continue
    }
    if (l.startsWith("+++ ")) {
      const p = l.slice(4).replace(/\t$/, "").replace(/^b\//, "")
      current = p === "/dev/null" ? undefined : byPath.get(p)
      continue
    }
    if (l.startsWith("--- ")) {
      const p = l.slice(4).replace(/\t$/, "").replace(/^a\//, "")
      // A deletion has no "+++ b/…" target: track its removed lines under the old path.
      if (p !== "/dev/null") current = byPath.get(p) ?? [...byPath.values()].find((c) => c.from === p)
      continue
    }
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (h) {
      lineNo = Number(h[1])
      continue
    }
    if (!current) continue
    if (l.startsWith("+")) current.added.push({ line: lineNo++, text: l.slice(1) })
    else if (l.startsWith("-")) current.removed.push(l.slice(1))
  }
  // Untracked files are additions too (a worker that never ran `git add`).
  for (const p of splitZ(await gitRaw(root, [...Q, "ls-files", "--others", "--exclude-standard", "-z"]))) {
    const c: Change = { path: p, status: "?", added: [], removed: [], binary: false }
    const full = path.join(root, p)
    const st = await fs.stat(full).catch(() => undefined)
    if (st?.isFile() && st.size <= MAX_SCAN_BYTES) {
      const buf = await fs.readFile(full)
      if (buf.subarray(0, 8000).includes(0)) c.binary = true
      else
        c.added = buf
          .toString("utf8")
          .split("\n")
          .map((text, i) => ({ line: i + 1, text }))
    }
    byPath.set(p, c)
  }
  return [...byPath.values()]
}

async function packageJsonDeps(root: string, base: string, file: string) {
  const parse = (text: string | undefined) => {
    if (!text) return new Map<string, string>()
    try {
      const j = JSON.parse(text) as Record<string, Record<string, string> | undefined>
      return new Map(
        ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((k) =>
          Object.entries(j[k] ?? {}).map(([n, v]) => [n, v] as const),
        ),
      )
    } catch {
      return new Map<string, string>()
    }
  }
  const before = parse(await git(root, "show", `${base}:${file}`).catch(() => undefined))
  const after = parse(await fs.readFile(path.join(root, file), "utf8").catch(() => undefined))
  const added = [...after.keys()].filter((n) => !before.has(n)).map((n) => `${n}@${after.get(n)}`)
  const removed = [...before.keys()].filter((n) => !after.has(n))
  const changed = [...after.keys()].filter((n) => before.has(n) && before.get(n) !== after.get(n)).map((n) => `${n} ${before.get(n)} → ${after.get(n)}`)
  return { added, removed, changed }
}

/** Audit the work between `base` and the current working tree. */
export async function audit(directory: string, opts: AuditOptions): Promise<AuditResult> {
  const root = await git(directory, "rev-parse", "--show-toplevel")
  const base = await git(root, "rev-parse", "--verify", `${opts.base}^{commit}`).catch(() => {
    throw new Error(`base "${opts.base}" is not a commit in ${root}`)
  })
  const all = await changes(root, base)
  const findings: Finding[] = []
  const severityOf = (c: AuditCategory) => (opts.block.includes(c) ? "block" : opts.warn.includes(c) ? "warn" : undefined)
  const add = (category: AuditCategory, f: Omit<Finding, "category" | "severity">, soft = false) => {
    const sev = severityOf(category)
    if (!sev) return
    findings.push({ category, severity: soft ? "warn" : sev, ...f })
  }

  if (opts.allowed?.length) {
    const inScope = globMatcher(opts.allowed)
    for (const c of all) {
      if (!inScope(c.path))
        add("scope", {
          file: c.path,
          text: `${c.status === "D" ? "deletes" : c.status === "?" || c.status === "A" ? "adds" : "changes"} a file outside the allowed scope`,
        })
      if (c.from && !inScope(c.from)) add("scope", { file: c.from, text: "moves a file from outside the allowed scope" })
    }
  }

  for (const c of all) {
    const test = isTestPath(c.path)
    if (c.status === "D" && test) add("tests", { file: c.path, text: "deletes a test file" })
    if (c.from && isTestPath(c.from) && !test) add("tests", { file: c.from, text: `moves a test file out of the test suite (to ${c.path})` })
    if (test) {
      for (const a of c.added) {
        const hit = SKIP_MARKERS.find(([re]) => re.test(a.text))
        if (hit) add("tests", { file: c.path, line: a.line, text: hit[1] })
      }
      const lost = assertions(c.removed) - assertions(c.added.map((a) => a.text))
      if (lost > 0 && c.status !== "D") add("tests", { file: c.path, text: `removes ${lost} assertion${lost === 1 ? "" : "s"}` }, true)
      if (/\.snap$|__snapshots__\//.test(c.path) && c.removed.length > 20)
        add("tests", { file: c.path, text: `rewrites a snapshot (${c.removed.length} lines removed)` }, true)
    }
    for (const a of c.added) {
      const sup = SUPPRESSIONS.find(([re]) => re.test(a.text))
      if (sup) add("suppressions", { file: c.path, line: a.line, text: sup[1] })
      const secret = SECRETS.find(([re]) => re.test(a.text))
      // Name the kind of secret, never the value.
      if (secret) add("secrets", { file: c.path, line: a.line, text: `adds what looks like ${secret[1]}` })
    }
    if (c.status !== "D") {
      if (c.binary) add("binaries", { file: c.path, text: "adds or changes a binary file" })
      const st = await fs.stat(path.join(root, c.path)).catch(() => undefined)
      if (st?.isFile() && st.size > BIG_FILE) add("binaries", { file: c.path, text: `file is ${(st.size / 1024 / 1024).toFixed(1)} MB` })
    }
    // Dependencies.
    if (/(^|\/)package\.json$/.test(c.path) && c.status !== "D") {
      const d = await packageJsonDeps(root, base, c.path)
      if (d.added.length) add("dependencies", { file: c.path, text: `adds ${d.added.join(", ")}` })
      if (d.removed.length) add("dependencies", { file: c.path, text: `removes ${d.removed.join(", ")}` })
      if (d.changed.length) add("dependencies", { file: c.path, text: `changes ${d.changed.join(", ")}` })
    } else if (/(^|\/)requirements[^/]*\.txt$/.test(c.path)) {
      const pkgs = c.added.map((a) => a.text.trim()).filter((t) => t && !t.startsWith("#"))
      if (pkgs.length) add("dependencies", { file: c.path, text: `adds ${pkgs.join(", ")}` })
    } else if (/(^|\/)(Cargo\.toml|pyproject\.toml|go\.mod)$/.test(c.path)) {
      const deps = c.added.map((a) => a.text.trim()).filter((t) => /^(require\s+)?[\w.@/-]+\s*(=|\s+v\d)|^"[\w.-]+(\[[\w,]+\])?\s*[<>=~!]/.test(t))
      if (deps.length)
        add("dependencies", { file: c.path, text: `adds or changes ${deps.slice(0, 5).join("; ")}${deps.length > 5 ? ` (+${deps.length - 5})` : ""}` })
    } else if (LOCKFILES.test(c.path)) add("dependencies", { file: c.path, text: "updates a lockfile" }, true)
  }

  const commits = Number(await git(root, "rev-list", "--count", `${base}..HEAD`).catch(() => "0"))
  const merges = (await git(root, "rev-list", "--merges", `${base}..HEAD`).catch(() => "")).split("\n").filter(Boolean)
  if (merges.length)
    add("git", { text: `${merges.length} merge commit${merges.length === 1 ? "" : "s"} on the branch (${merges.map((m) => m.slice(0, 8)).join(", ")})` })

  return { base, files: all.map((c) => c.path), commits, findings }
}
