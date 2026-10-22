import fs from "node:fs/promises"
import path from "node:path"
import { git, gitRaw, globMatcher, isTestPath, splitZ } from "@mcp-horde/core"
import type { AuditCategory } from "./detect.js"

export interface Finding {
  category: AuditCategory
  severity: "block" | "warn"
  file?: string
  line?: number
  text: string
}

export interface AuditOptions {
  /** Commit (or ref) the work started from; the diff starts at its merge-base with HEAD. */
  base: string
  /** Globs (relative to the repository root) every changed path must match; empty = no scope check. */
  allowed?: string[]
  /** More glob lists a changed path must also match (each non-empty one): scopes narrow each other. */
  scopes?: string[][]
  block: AuditCategory[]
  warn: AuditCategory[]
  /** package.json scripts the checks run (see checkScripts): changing one changes what the gate checks. */
  ruleScripts?: string[]
  /**
   * Generated output (horde.json verify.audit.generated, read at base like the other rules, so the
   * work cannot add to it): regenerated bundles are not binaries, and minified code is not source.
   */
  generated?: string[]
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

/**
 * A file a test runner runs as a test (not a helper, fixture or conftest.py that merely
 * lives among the tests).
 */
export const isRunnableTest = (p: string) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) ||
  /(^|\/)__tests__\/.+\.[cm]?[jt]sx?$/.test(p) ||
  /(^|\/)test_[^/]+\.py$/.test(p) ||
  /(^|\/)tests\.py$/.test(p) ||
  /[^/]_test\.(py|go)$/.test(p) ||
  /(^|\/)tests\/[^/]+\.rs$/.test(p) ||
  /[^/]Tests?\.(java|kt|cs)$/.test(p)

/** The commit a diff from `base` starts at: where HEAD's history meets base's (base itself when HEAD descends from it). */
export async function diffBase(root: string, base: string): Promise<string> {
  const sha = await git(root, "rev-parse", "--verify", "--quiet", `${base}^{commit}`).catch(() => {
    throw new Error(`base "${base}" is not a commit in ${root}`)
  })
  return git(root, "merge-base", sha, "HEAD").catch(() => sha)
}

/** A path from a diff header, C-quoted by git when it holds control characters, quotes or backslashes. */
export function unquoteC(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"') || p.length < 2) return p
  const bytes: number[] = []
  const body = p.slice(1, -1)
  const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 }
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"))
      continue
    }
    const n = body[++i] ?? ""
    const oct = body.slice(i, i + 3)
    if (/^[0-7]{3}$/.test(oct)) {
      bytes.push(Number.parseInt(oct, 8))
      i += 2
    } else bytes.push(simple[n] ?? n.charCodeAt(0))
  }
  return Buffer.from(bytes).toString("utf8")
}

/** Assertions in the common test frameworks (counted per occurrence, not per line). */
const ASSERTION = /\b(assert\w*|expect|should|assertEquals|assertThat|require\.\w+|t\.(Error|Fatal)\w*)\s*[.(!]/g
const assertions = (lines: string[]) => lines.reduce((n, l) => n + (l.match(ASSERTION)?.length ?? 0), 0)

/** Test definitions per runner; a rename removes one and adds one, so only the net count matters. */
const TEST_DEF = [
  /(?<![.\w$])(?:it|test)(?:\.\w+)*\s*\(/,
  /^\s*(?:async\s+)?def\s+test_/,
  /^\s*func\s+Test/,
  /^\s*#\[test\b/,
  /^\s*@Test\b/,
  /^\s*\[(?:Test|Fact)\b/,
]
const testDefs = (lines: string[]) => lines.reduce((n, l) => n + (TEST_DEF.some((re) => re.test(l)) ? 1 : 0), 0)

/** Test-runner calls, never ordinary words: `(?<![.\w$])` keeps `model.fit(` or `outfit(` from matching. */
const SKIP_MARKERS: [RegExp, string][] = [
  [/\b(describe|it|test|context|suite)\.only(\.each)?\s*[(`]|(?<![.\w$])f(it|describe)\s*\(/, "focuses tests with .only (all others stop running)"],
  [/\b(describe|it|test|context|suite|bench)\.(skip|todo)(\.each)?\s*[(`]|\.(skipIf|runIf)\s*\(|(?<![.\w$])x(it|describe|test|context)\s*\(/, "skips a test"],
  // node:test options and context, mocha's this.skip()
  [/[{,]\s*(skip|todo)\s*:\s*(true\b|["'`])|\bt\.(skip|todo)\s*\(|\bthis\.skip\s*\(/, "skips a test"],
  [/@pytest\.mark\.(skip|skipif|xfail)\b|\bpytest\.(skip|xfail)\s*\(|@unittest\.(skip\w*|expectedFailure)\b|\.skipTest\s*\(/, "skips a test"],
  // Module-level pytest skips, including a list on the same line.
  [/\bpytestmark\s*=\s*\[?[^\n]*pytest\.mark\.(skip|skipif|xfail)\b|\bpytest\.importorskip\s*\(|\bcollect_ignore(_glob)?\s*=/, "skips a test"],
  [/\bt\.Skip(Now|f)?\(/, "skips a test"],
  [/#\[ignore\b/, "ignores a test"],
  [/@(Disabled|Ignore)\b/, "disables a test"],
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
  // After a known prefix the key body may hold - and _; a bare sk- is followed by base62 only (not sk-some-kebab-name).
  [/\bsk-(?:ant-[a-z]+\d*-[A-Za-z0-9_-]{20,}|proj-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{20,}(?![\w-]))/, "an API secret key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"],
  [/(api[_-]?key|secret|passw(or)?d|token)["']?\s*[:=]\s*["']([^"'\s]{16,})["']/i, "a hard-coded credential"],
]

/** Values that stand for a secret rather than being one: templates, placeholders, environment lookups. */
const PLACEHOLDER = /\$\{|\{\{|^<.*>$|process\.env|os\.environ|getenv|^(x+|\*+|\.+|changeme\w*|your[\w-]*)$/i

/**
 * A random-looking value: letters and digits or mixed case (punctuation does not count, so
 * `my_token_name` is a word), and some entropy (not `aaaa1111…`).
 */
function randomLooking(v: string): boolean {
  const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((r) => r.test(v)).length
  if (classes < 2) return false
  const freq = new Map<string, number>()
  for (const c of v) freq.set(c, (freq.get(c) ?? 0) + 1)
  const bits = [...freq.values()].reduce((h, n) => h - (n / v.length) * Math.log2(n / v.length), 0)
  return bits >= 3
}

function secretIn(text: string): string | undefined {
  for (const [re, what] of SECRETS) {
    const m = text.match(re)
    if (!m) continue
    // The generic assignment rule needs a value that is neither a placeholder nor a word.
    if (what === "a hard-coded credential" && (PLACEHOLDER.test(m[3] ?? "") || !randomLooking(m[3] ?? ""))) continue
    return what
  }
  return undefined
}

const LOCKFILES =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|composer\.lock|Gemfile\.lock)$/

/** True when the file's first 8000 bytes hold a NUL: the same test git uses for "binary". */
async function isBinary(root: string, file: string): Promise<boolean> {
  try {
    const fh = await fs.open(path.join(root, file), "r")
    try {
      const buf = Buffer.alloc(8000)
      const { bytesRead } = await fh.read(buf, 0, 8000, 0)
      return buf.subarray(0, bytesRead).includes(0)
    } finally {
      await fh.close()
    }
  } catch {
    return false // the file is gone (e.g. a rename target outside the worktree)
  }
}

/** Changed paths git reports with "-" numstat counts: it treats them as binary (real bytes or the -diff attribute). */
async function gitBinaryPaths(root: string, range: string): Promise<string[]> {
  const numstat = splitZ(await gitRaw(root, [...Q, "diff", "--no-ext-diff", "-M", "--numstat", "-z", range]))
  const out: string[] = []
  for (let i = 0; i < numstat.length; i++) {
    const m = numstat[i]!.match(/^(-|\d+)\t(-|\d+)\t(.*)$/)
    if (!m) continue
    let p = m[3]!
    if (!p) {
      i += 2
      p = numstat[i] ?? ""
    }
    if (m[1] === "-") out.push(p)
  }
  return out
}

/** Whether `file` is a regular file in the working tree (not deleted). */
async function isFile(root: string, file: string): Promise<boolean> {
  try {
    return (await fs.stat(path.join(root, file))).isFile()
  } catch {
    return false
  }
}

/** The git-binary changed paths whose content is text: these need a --text diff. */
async function textDiffPaths(root: string, range: string): Promise<string[]> {
  const out: string[] = []
  for (const p of await gitBinaryPaths(root, range)) {
    if (!(await isFile(root, p))) continue
    if (!(await isBinary(root, p))) out.push(p)
  }
  return out
}

/** Parse a `git diff -U0` (optionally --text) into each path's added/removed lines. */
function parseDiff(diff: string, byPath: Map<string, Change>) {
  const headerPath = (l: string, prefix: string) => {
    const p = unquoteC(l.slice(4).replace(/\t$/, ""))
    return p.startsWith(prefix) ? p.slice(prefix.length) : p
  }
  let current: Change | undefined
  let lineNo = 0
  // ---/+++ are file headers only between "diff --git" and the file's first hunk; inside a
  // hunk they are a removed "-- x" or an added "++ y" line.
  let inHeader = false
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff --git ")) {
      current = undefined
      inHeader = true
      continue
    }
    if (inHeader && l.startsWith("+++ ")) {
      const p = headerPath(l, "b/")
      current = l.slice(4) === "/dev/null" ? undefined : byPath.get(p)
      continue
    }
    if (inHeader && l.startsWith("--- ")) {
      const p = headerPath(l, "a/")
      // A deletion has no "+++ b/…" target: track its removed lines under the old path.
      if (l.slice(4) !== "/dev/null") current = byPath.get(p) ?? [...byPath.values()].find((c) => c.from === p)
      continue
    }
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (h) {
      lineNo = Number(h[1])
      inHeader = false
      continue
    }
    if (!current || inHeader) continue
    if (l.startsWith("+")) current.added.push({ line: lineNo++, text: l.slice(1) })
    else if (l.startsWith("-")) current.removed.push(l.slice(1))
  }
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
  // Git calls a file binary for a real binary or a -diff attribute. Tell them apart by
  // content: a NUL byte means a real binary, everything else is text that still needs its lines.
  const textPaths: string[] = []
  for (const p of await gitBinaryPaths(root, base)) {
    const c = byPath.get(p)
    if (!c || c.status === "D") continue
    if (await isBinary(root, p)) c.binary = true
    else textPaths.push(p)
  }
  // Added and removed lines, from a zero-context diff that does not depend on user config.
  // Fixed a/ b/ prefixes whatever diff.noprefix or diff.mnemonicPrefix say. Binary and -diff
  // files print one "Binary files differ" line here; the -diff text files get a --text pass below.
  parseDiff(
    await gitRaw(root, [...Q, "-c", "color.ui=never", "diff", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "-M", "-U0", base]),
    byPath,
  )
  if (textPaths.length) {
    // The -diff text files' lines, limited to just those paths so a real binary stays one line.
    parseDiff(
      await gitRaw(root, [
        ...Q,
        "-c",
        "color.ui=never",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--text",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "-M",
        "-U0",
        base,
        "--",
        ...textPaths,
      ]),
      byPath,
    )
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

interface HistoricalSecret {
  commit: string
  file: string
  line: number
  what: string
}

/** Secret-looking lines added in any commit since base, even when a later commit removed them. */
async function secretHistory(root: string, base: string): Promise<HistoricalSecret[]> {
  const args = [
    ...Q,
    "-c",
    "color.ui=never",
    "log",
    "--format=%x1e%H%x1f%h",
    "-p",
    "-U0",
    "-m",
    "--no-ext-diff",
    "--no-textconv",
    "--src-prefix=a/",
    "--dst-prefix=b/",
  ]
  let raw = await gitRaw(root, [...args, `${base}..HEAD`])
  // -diff text files are hidden from the log above ("Binary files differ"); scan those
  // too, with --text limited to just them so real binaries never dump their bytes.
  const textPaths = await textDiffPaths(root, `${base}..HEAD`)
  if (textPaths.length) raw += await gitRaw(root, [...args, "--text", `${base}..HEAD`, "--", ...textPaths])
  const out: HistoricalSecret[] = []
  const seen = new Set<string>()
  let sha = ""
  let short = ""
  let file: string | undefined
  let lineNo = 0
  let inHunk = false
  for (const line of raw.split("\n")) {
    if (line.startsWith("\x1e")) {
      const [nextSha, nextShort] = line.slice(1).split("\x1f")
      sha = nextSha ?? ""
      short = nextShort ?? ""
      file = undefined
      inHunk = false
      continue
    }
    if (line.startsWith("diff --git ")) {
      file = undefined
      inHunk = false
      continue
    }
    if (!inHunk && line.startsWith("+++ ")) {
      const path = unquoteC(line.slice(4).replace(/\t$/, ""))
      file = line.slice(4) === "/dev/null" || path === "/dev/null" ? undefined : path.replace(/^b\//, "")
      continue
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (h) {
      lineNo = Number(h[1])
      inHunk = true
      continue
    }
    if (!inHunk || !file) continue
    if (line.startsWith("+")) {
      const what = secretIn(line.slice(1))
      const key = `${sha}\0${file}\0${what}`
      if (what && !seen.has(key)) {
        seen.add(key)
        out.push({ commit: short, file, line: lineNo, what })
      }
      lineNo++
    } else if (line.startsWith(" ")) lineNo++
  }
  return out
}

/** Size of a file at a commit (0 when it did not exist there). */
async function sizeAt(root: string, rev: string, file: string): Promise<number> {
  return Number(await git(root, "cat-file", "-s", `${rev}:${file}`).catch(() => "0")) || 0
}

/** Scripts a detected check runs, by convention, besides the ones the caller names. */
const RULE_SCRIPTS = ["test", "typecheck", "type-check", "check-types", "tsc", "lint", "check", "build"]
/** Test-runner configuration files: changing one changes which tests run and how. */
const RUNNER_CONFIG =
  /(^|\/)(jest\.config\.[\w.]+|vitest\.(config|workspace)\.[\w.]+|pytest\.ini|tox\.ini|\.mocharc(\.[\w]+)?|karma\.conf(\.[\w]+)?|\.c8rc(\.json)?|\.nycrc(\.[\w]+)?)$/
/** Tool config files a check reads. Watched at the repository root and at each check's cwd. */
const CHECK_CONFIG =
  /^(tsconfig[^/]*\.json|jsconfig[^/]*\.json|biome\.jsonc?|\.eslintrc.*|eslint\.config\..+|ruff\.toml|\.ruff\.toml|mypy\.ini|playwright\.config\..+|vite\.config\..+)$/
/** pyproject.toml and setup.cfg sections that set what a check enforces. */
const PYPROJECT_RULES: [RegExp, string][] = [
  [/^\[tool\.pytest/, "[tool.pytest]"],
  [/^\[tool\.ruff/, "[tool.ruff]"],
  [/^\[tool\.mypy/, "[tool.mypy]"],
  [/^\[tool\.coverage/, "[tool.coverage]"],
  [/^\[tool\.pyright/, "[tool.pyright]"],
  [/^\[flake8/, "[flake8]"],
  [/^\[mypy/, "[mypy]"],
]
const SETUP_CFG_RULES: [RegExp, string][] = [
  [/^\[tool:pytest/, "[tool:pytest]"],
  [/^\[tool\.ruff/, "[tool.ruff]"],
  [/^\[tool\.mypy/, "[tool.mypy]"],
  [/^\[tool\.coverage/, "[tool.coverage]"],
  [/^\[tool\.pyright/, "[tool.pyright]"],
  [/^\[flake8/, "[flake8]"],
  [/^\[mypy/, "[mypy]"],
  [/^\[coverage:/, "[coverage:*]"],
]

/** Text of the INI/TOML sections whose header matches `header`, without trailing whitespace or blank lines. */
function sections(text: string, header: RegExp): string {
  let keep = false
  return text
    .split("\n")
    .filter((l) => {
      if (/^\s*\[/.test(l)) keep = header.test(l.trim())
      return keep
    })
    .map((l) => l.trimEnd())
    .join("\n")
    .trimEnd()
}

/** Tables of pyproject.toml and Cargo.toml that hold dependencies; `[project]`'s `dependencies = [...]` is handled separately. */
const DEP_TABLE =
  /^(?:dependencies|dev-dependencies|build-dependencies|workspace\.dependencies|target\..*\.(?:dev-|build-)?dependencies|project\.optional-dependencies|dependency-groups|tool\.poetry\.(?:dev-)?dependencies|tool\.poetry\.group\.[^.]+\.dependencies|tool\.pdm\.dev-dependencies|tool\.uv\.(?:dev-)?dependencies)(?:\..+)?$/

/**
 * 1-based lines of a pyproject.toml/Cargo.toml inside a dependency list or table: a `version =
 * "0.1.1"` in [project]/[package] is not a dependency change, an entry in one of these is.
 */
function dependencyLines(text: string): Set<number> {
  const out = new Set<number>()
  let table = ""
  let list = false
  text.split(/\r?\n/).forEach((line, i) => {
    const header = line.match(/^\s*\[+([^\]]+)\]+/)
    if (header && !list) table = header[1]!.trim()
    const project = table === "project" && /^\s*dependencies\s*=/.test(line)
    if (!header && (list || project || DEP_TABLE.test(table))) out.add(i + 1)
    if (list) {
      if (/^\s*\]/.test(line)) list = false
    } else if (project && /\[/.test(line) && !/\]/.test(line)) list = true
  })
  return out
}

/**
 * Directories whose tool configs a check reads: the directory under audit and its ancestors (where
 * detection finds the project), plus horde.json's explicit check cwds, read at base.
 */
async function checkDirs(root: string, base: string, directory: string): Promise<Set<string>> {
  const dirs = new Set<string>()
  for (let d = path.resolve(directory); ; d = path.dirname(d)) {
    dirs.add(d)
    const rel = path.relative(root, d).split(path.sep).join("/")
    if (!rel.startsWith("..")) {
      const text = await gitRaw(root, ["show", `${base}:${rel ? `${rel}/` : ""}horde.json`]).catch(() => "")
      try {
        const checks = ((JSON.parse(text || "{}") as { verify?: { checks?: Record<string, unknown> } }).verify?.checks ?? {}) as Record<string, unknown>
        for (const spec of Object.values(checks))
          if (spec && typeof spec === "object" && typeof (spec as { cwd?: unknown }).cwd === "string") dirs.add(path.resolve(d, (spec as { cwd: string }).cwd))
      } catch {
        // A broken base horde.json is not this audit's problem.
      }
    }
    if (d === root || path.dirname(d) === d) break
  }
  return dirs
}

/**
 * Changes to what the gate itself checks with: horde.json's verify section, the package.json
 * scripts the checks run (and the scripts they reach, with their pre/post hooks), test-runner
 * and tool configs, pytest/ruff/mypy/coverage sections of pyproject.toml and setup.cfg. A worker
 * that edits these can make a failing suite pass.
 */
async function ruleChanges(root: string, base: string, all: Change[], scripts: string[], dirs: Set<string>): Promise<{ file: string; what: string }[]> {
  const out: { file: string; what: string }[] = []
  const before = (f: string) => gitRaw(root, ["show", `${base}:${f}`]).catch(() => "")
  const after = (f: string) => fs.readFile(path.join(root, f), "utf8").catch(() => "")
  const json = (t: string) => {
    try {
      return (JSON.parse(t) ?? {}) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  const differs = (a: unknown, b: unknown) => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)
  const roots = new Set([...RULE_SCRIPTS, ...scripts])
  const refs = (cmd: unknown) => (typeof cmd === "string" ? [...cmd.matchAll(/\b(?:npm|pnpm|yarn|bun)\s+run\s+([\w:.-]+)/g)].map((m) => m[1]!) : [])
  // Follow `npm run X` from a checked script, and the pre/post hooks npm runs around each script.
  const chain = (sa: Record<string, unknown>) => {
    const seen = new Set<string>()
    const hooks = new Set([...roots, ...Object.keys(sa)])
    const queue = [...roots]
    while (queue.length) {
      const n = queue.shift()!
      if (seen.has(n)) continue
      seen.add(n)
      // Only a script that exists at base (or a checked name) can have hooks of its own.
      if (hooks.has(n)) queue.push(`pre${n}`, `post${n}`)
      queue.push(...refs(sa[n]))
    }
    return seen
  }
  const sectionRule = (file: string, groups: [RegExp, string][], a: string, b: string) => {
    const changed = groups.filter(([re]) => sections(a, re) !== sections(b, re)).map(([, name]) => name)
    return changed.length ? `${file} ${changed.join(", ")}` : undefined
  }
  // Vitest ignores vite.config only when it has its own config in the same directory.
  const vitestAt = async (dir: string) => {
    const tree = dir === "." ? base : `${base}:${dir}`
    const names = (await gitRaw(root, ["ls-tree", "--name-only", tree]).catch(() => "")).split("\n")
    return names.some((n) => /^vitest\.(config|workspace)\.[\w.]+$/.test(n))
  }
  const viteSuppressed = async (p: string) => /^vite\.config\..+$/.test(path.posix.basename(p)) && (await vitestAt(path.posix.dirname(p)))
  const local = new Set([...dirs].map((d) => path.relative(root, d).split(path.sep).join("/") || "."))
  for (const c of all) {
    const file = c.path
    const old = c.from ?? c.path
    if (/(^|\/)horde\.json$/.test(file)) {
      if (differs(json(await before(old)).verify, json(await after(file)).verify)) out.push({ file, what: "horde.json verify" })
    } else if (/(^|\/)package\.json$/.test(file)) {
      const [a, b] = [json(await before(old)), json(await after(file))]
      const sa = (a.scripts ?? {}) as Record<string, unknown>
      const sb = (b.scripts ?? {}) as Record<string, unknown>
      const runnable = chain(sa)
      const changed = [...new Set([...Object.keys(sa), ...Object.keys(sb)])].filter(
        (n) => (runnable.has(n) || /^(test|lint|typecheck|check)[:-]/.test(n)) && differs(sa[n], sb[n]),
      )
      if (changed.length) out.push({ file, what: `package.json scripts ${changed.join(", ")}` })
      if (differs(a.jest, b.jest)) out.push({ file, what: "package.json jest" })
    } else if (RUNNER_CONFIG.test(file) || (c.from && RUNNER_CONFIG.test(c.from))) {
      out.push({ file, what: path.posix.basename(RUNNER_CONFIG.test(file) ? file : c.from!) })
    } else if (/(^|\/)conftest\.py$/.test(file) || (c.from && /(^|\/)conftest\.py$/.test(c.from))) {
      out.push({ file, what: "conftest.py" })
    } else if (CHECK_CONFIG.test(path.posix.basename(file)) || (c.from && CHECK_CONFIG.test(path.posix.basename(c.from)))) {
      const watched = (p: string) => local.has(path.posix.dirname(p))
      for (const p of [file, ...(c.from ? [c.from] : [])].filter(watched)) {
        if (await viteSuppressed(p)) continue
        out.push({ file, what: path.posix.basename(file) })
        break
      }
    } else if (/(^|\/)pyproject\.toml$/.test(file)) {
      const what = sectionRule("pyproject.toml", PYPROJECT_RULES, await before(old), await after(file))
      if (what) out.push({ file, what })
    } else if (/(^|\/)setup\.cfg$/.test(file)) {
      const what = sectionRule("setup.cfg", SETUP_CFG_RULES, await before(old), await after(file))
      if (what) out.push({ file, what })
    }
  }
  return out
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
  const base = await diffBase(root, opts.base)
  const all = await changes(root, base)
  const findings: Finding[] = []
  const severityOf = (c: AuditCategory) => (opts.block.includes(c) ? "block" : opts.warn.includes(c) ? "warn" : undefined)
  const add = (category: AuditCategory, f: Omit<Finding, "category" | "severity">, soft = false) => {
    const sev = severityOf(category)
    if (!sev) return
    findings.push({ category, severity: soft ? "warn" : sev, ...f })
  }

  const scopes = [opts.allowed ?? [], ...(opts.scopes ?? [])].filter((s) => s.length).map((s) => globMatcher(s))
  if (scopes.length) {
    const inScope = (p: string) => scopes.every((m) => m(p))
    for (const c of all) {
      if (!inScope(c.path))
        add("scope", {
          file: c.path,
          text: `${c.status === "D" ? "deletes" : c.status === "?" || c.status === "A" ? "adds" : "changes"} a file outside the allowed scope`,
        })
      if (c.from && !inScope(c.from)) add("scope", { file: c.from, text: "moves a file from outside the allowed scope" })
    }
  }

  const generated = globMatcher(opts.generated ?? [])
  for (const c of all) {
    if (opts.generated?.length && generated(c.path)) continue
    const test = isTestPath(c.path)
    // Rust unit tests live inline in src/*.rs, so every changed .rs file is scanned.
    const rust = /\.rs$/.test(c.path)
    if (c.status === "D" && (test || isRunnableTest(c.path))) add("tests", { file: c.path, text: "deletes a test file" })
    // x.test.ts → x.test.ts.bak stays in a test directory but no runner picks it up any more.
    if (c.from && ((isTestPath(c.from) && !test) || (isRunnableTest(c.from) && !isRunnableTest(c.path))))
      add("tests", { file: c.from, text: `moves a test file out of the test suite (to ${c.path})` })
    // A root conftest.py is not under tests/, but its pytest hooks still skip tests.
    if (test || rust || /(^|\/)conftest\.py$/.test(c.path)) {
      for (const a of c.added) {
        const hit = SKIP_MARKERS.find(([re]) => re.test(a.text))
        if (hit) add("tests", { file: c.path, line: a.line, text: hit[1] })
      }
    }
    if ((test || rust) && c.status !== "D") {
      const removed = testDefs(c.removed) - testDefs(c.added.map((a) => a.text))
      if (removed > 0) add("tests", { file: c.path, text: `removes ${removed} test${removed === 1 ? "" : "s"}` })
    }
    // A test file that exits its process at the top level stops the runner early, possibly
    // before it prints a count. Anchored at the line start, so a string in a fixture does not match.
    if (test || isRunnableTest(c.path)) {
      for (const a of c.added) {
        if (/^\s*(?:process\.exit|os\._exit|sys\.exit)\(/.test(a.text)) add("tests", { file: c.path, line: a.line, text: "exits the test process early" })
      }
    }
    if (test) {
      const lost = assertions(c.removed) - assertions(c.added.map((a) => a.text))
      if (lost > 0 && c.status !== "D") add("tests", { file: c.path, text: `removes ${lost} assertion${lost === 1 ? "" : "s"}` }, true)
      if (/\.snap$|__snapshots__\//.test(c.path) && c.removed.length > 20)
        add("tests", { file: c.path, text: `rewrites a snapshot (${c.removed.length} lines removed)` }, true)
    }
    for (const a of c.added) {
      const sup = SUPPRESSIONS.find(([re]) => re.test(a.text))
      if (sup) add("suppressions", { file: c.path, line: a.line, text: sup[1] })
      const secret = secretIn(a.text)
      // Name the kind of secret, never the value.
      if (secret) add("secrets", { file: c.path, line: a.line, text: `adds what looks like ${secret}` })
    }
    if (c.status !== "D") {
      if (c.binary) add("binaries", { file: c.path, text: "adds or changes a binary file" })
      // Size: new files, or files this change made big; lockfiles are big by nature.
      const st = LOCKFILES.test(c.path) ? undefined : await fs.stat(path.join(root, c.path)).catch(() => undefined)
      if (st?.isFile() && st.size > BIG_FILE) {
        const before = c.status === "A" || c.status === "?" ? 0 : await sizeAt(root, base, c.from ?? c.path)
        if (before <= BIG_FILE) add("binaries", { file: c.path, text: `file is ${(st.size / 1024 / 1024).toFixed(1)} MB` })
      }
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
    } else if (/(^|\/)(Cargo\.toml|pyproject\.toml)$/.test(c.path)) {
      // Only entries inside a dependency table or list count: versions and other keys do not.
      const dependency = c.status === "D" ? new Set<number>() : dependencyLines(await fs.readFile(path.join(root, c.path), "utf8").catch(() => ""))
      const deps = c.added
        .filter((a) => dependency.has(a.line))
        .map((a) => a.text.trim().replace(/,$/, ""))
        // Container lines (`dependencies = [`, `]`) are not entries.
        .filter((t) => t && !t.startsWith("#") && !/^[[\]]$/.test(t) && !/^[\w.-]+\s*=\s*\[\s*$/.test(t))
      if (deps.length)
        add("dependencies", { file: c.path, text: `adds or changes ${deps.slice(0, 5).join("; ")}${deps.length > 5 ? ` (+${deps.length - 5})` : ""}` })
    } else if (/(^|\/)go\.mod$/.test(c.path)) {
      const deps = c.added.map((a) => a.text.trim()).filter((t) => /^(require\s+)?[\w.@/-]+\s*(=|\s+v\d)/.test(t))
      if (deps.length)
        add("dependencies", { file: c.path, text: `adds or changes ${deps.slice(0, 5).join("; ")}${deps.length > 5 ? ` (+${deps.length - 5})` : ""}` })
    } else if (LOCKFILES.test(c.path)) add("dependencies", { file: c.path, text: "updates a lockfile" }, true)
  }

  for (const f of await ruleChanges(root, base, all, opts.ruleScripts ?? [], await checkDirs(root, base, directory)))
    add("tests", { file: f.file, text: `changes the rules the gate checks with: ${f.what}` })

  // A secret committed and then deleted still leaked: scan the commits, not only the net diff.
  if (severityOf("secrets")) {
    const current = findings.filter((f) => f.category === "secrets")
    for (const h of await secretHistory(root, base)) {
      if (current.some((f) => f.file === h.file && f.text.includes(h.what))) continue
      add("secrets", { file: h.file, line: h.line, text: `adds what looks like ${h.what} in commit ${h.commit}` })
    }
  }

  const commits = Number(await git(root, "rev-list", "--count", `${base}..HEAD`).catch(() => "0"))
  const merges = (await git(root, "rev-list", "--merges", `${base}..HEAD`).catch(() => "")).split("\n").filter(Boolean)
  if (merges.length)
    add("git", { text: `${merges.length} merge commit${merges.length === 1 ? "" : "s"} on the branch (${merges.map((m) => m.slice(0, 8)).join(", ")})` })

  return { base, files: all.map((c) => c.path), commits, findings }
}
