import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  audit,
  type Check,
  changedFiles,
  detectChecks,
  extract,
  gate,
  globMatcher,
  isTestPath,
  loadSettings,
  logFileFor,
  narrowCommand,
  planRelated,
} from "../src/lib.js"

const pkg = path.resolve(import.meta.dirname, "..")
const temps: string[] = []
after(() => {
  for (const t of temps) fs.rmSync(t, { recursive: true, force: true })
})

function tmp() {
  // native: long names on Windows (RUNNER~1 → runneradmin), as detection resolves them.
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "horde-verify-")))
  temps.push(d)
  return d
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd })
    .toString()
    .trim()
}

function write(root: string, files: Record<string, string | Buffer>) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
}

function repo(files: Record<string, string | Buffer>) {
  const root = tmp()
  git(root, "init", "-q")
  git(root, "config", "core.autocrlf", "false")
  write(root, files)
  git(root, "add", "-A")
  git(root, "commit", "-qm", "base")
  return { root, base: git(root, "rev-parse", "HEAD") }
}

describe("detect", () => {
  test("package.json scripts, cheapest first; npm's placeholder test is ignored; build only without typecheck", async () => {
    const { root } = repo({
      "package.json": JSON.stringify({ scripts: { test: "node --test", lint: "biome check .", typecheck: "tsc --noEmit", build: "tsc" } }),
    })
    assert.deepEqual(
      (await detectChecks(root)).map((c) => [c.name, c.command]),
      [
        ["typecheck", "npm run typecheck"],
        ["lint", "npm run lint"],
        ["test", "npm test"],
      ],
    )
    write(root, { "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', build: "tsc" } }), "pnpm-lock.yaml": "" })
    assert.deepEqual(
      (await detectChecks(root)).map((c) => c.command),
      ["pnpm run build"],
    )
  })

  test("Python, Rust, Go and Make; nearest project root from a subdirectory", async () => {
    const { root } = repo({
      "pyproject.toml": "[tool.pytest.ini_options]\n[tool.ruff]\n[tool.mypy]\n",
      "svc/go.mod": "module x\n",
      "svc/internal/a.go": "package internal\n",
      "lib/Cargo.toml": "[package]\nname='x'\n",
      "tools/Makefile": "lint:\n\techo\ntest:\n\techo\n",
    })
    const py = (await detectChecks(root)).map((c) => c.name)
    assert.deepEqual(py, ["typecheck", "lint", "test"])
    assert.deepEqual(
      (await detectChecks(path.join(root, "svc", "internal"))).map((c) => c.command),
      ["go vet ./...", "go test ./..."],
      "found from a subdirectory",
    )
    assert.equal((await detectChecks(path.join(root, "lib")))[0]!.command, "cargo test --color never")
    assert.deepEqual(
      (await detectChecks(path.join(root, "tools"))).map((c) => c.command),
      ["make lint", "make test"],
    )
  })

  test("horde.json checks replace detection; settings are validated", async () => {
    const { root } = repo({
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "horde.json": JSON.stringify({ verify: { checks: { unit: "node --test", style: { command: "biome check .", kind: "lint" } }, timeoutSeconds: 30 } }),
    })
    const checks = await detectChecks(root)
    assert.deepEqual(
      checks.map((c) => [c.name, c.kind, c.source]),
      [
        ["unit", "test", "horde.json"],
        ["style", "lint", "horde.json"],
      ],
    )
    assert.equal(loadSettings(root).timeoutMs, 30_000)
    write(root, { "horde.json": JSON.stringify({ verify: { audit: { block: ["nonsense"] } } }) })
    assert.throws(() => loadSettings(root), /audit\.block must be a list of/)
    write(root, { "horde.json": JSON.stringify({ verify: { checks: { x: {} } } }) })
    assert.throws(() => loadSettings(root), /checks\.x needs a command/)
  })
})

describe("audit", () => {
  test("globs and test paths", () => {
    const m = globMatcher(["src/auth/**", "*.md", "docs/"])
    assert.ok(m("src/auth/login.ts"))
    assert.ok(m("src/auth/deep/x.ts"))
    assert.ok(m("README.md") && m("packages/a/CHANGELOG.md"))
    assert.ok(m("docs/guide/intro.txt"))
    assert.ok(!m("src/authz/x.ts"))
    assert.ok(!m("src/other.ts"))
    for (const p of ["test/a.ts", "src/__tests__/a.ts", "a.test.ts", "b.spec.mjs", "tests/test_x.py", "pkg/x_test.go", "tests/it.rs"])
      assert.ok(isTestPath(p), p)
    for (const p of ["src/testing.ts", "src/contest.ts", "latest.json"]) assert.ok(!isTestPath(p), p)
  })

  test("every category, with the right severity, without echoing secrets", async () => {
    const { root, base } = repo({
      "src/auth/login.ts": "export const login = () => true\n",
      "src/app.ts": "export const app = 1\n",
      "test/login.test.ts": 'test("a", () => { expect(1).toBe(1); expect(2).toBe(2) })\ntest("b", () => {})\n',
      "test/old.test.ts": "test('old', () => {})\n",
      "test/moved.test.ts": "test('m', () => { expect(1).toBe(1) })\n",
      "package.json": JSON.stringify({ dependencies: { a: "^1.0.0" } }, null, 2),
    })
    // A worker's typical sins, committed and uncommitted.
    write(root, {
      "src/auth/login.ts": "// @ts-ignore\nexport const login = () => { try { return check() } catch {} }\n",
      "test/login.test.ts": 'test.skip("a", () => { expect(1).toBe(1) })\ntest.only("b", () => {})\n',
      "package.json": JSON.stringify({ dependencies: { a: "^1.0.0", "left-pad": "^1.3.0" } }, null, 2),
      "package-lock.json": "{}",
    })
    fs.rmSync(path.join(root, "test/old.test.ts"))
    git(root, "mv", "test/moved.test.ts", "src/moved.ts")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "work")
    write(root, {
      "src/app.ts": 'export const app = 1\nconst key = "AKIAABCDEFGHIJKLMNOP"\n',
      "assets/logo.bin": Buffer.from([0, 1, 2, 3, 0, 255]),
      "scratch/notes.txt": 'token = "q7Ldf9Xk2Pz0vBn4Rt8w"\n',
    })
    const r = await audit(root, {
      base,
      allowed: ["src/auth/**", "test/**", "package.json", "package-lock.json"],
      block: ["scope", "tests", "secrets", "binaries"],
      warn: ["suppressions", "dependencies", "git"],
    })
    const lines = r.findings.map((f) => `${f.severity} ${f.category} ${f.file ?? ""}${f.line ? `:${f.line}` : ""} ${f.text}`)
    const has = (re: RegExp) =>
      assert.ok(
        lines.some((l) => re.test(l)),
        `expected ${re} in:\n${lines.join("\n")}`,
      )
    has(/^block scope src\/app\.ts /)
    has(/^block scope assets\/logo\.bin /)
    has(/^block scope src\/moved\.ts /)
    has(/^block tests test\/old\.test\.ts deletes a test file/)
    has(/^block tests test\/moved\.test\.ts moves a test file out of the test suite/)
    has(/^block tests test\/login\.test\.ts:1 skips a test/)
    has(/^block tests test\/login\.test\.ts:2 focuses tests with \.only/)
    has(/^warn tests test\/login\.test\.ts removes 1 assertion/)
    has(/^warn suppressions src\/auth\/login\.ts:1 silences the type checker/)
    has(/^warn suppressions src\/auth\/login\.ts:2 swallows errors \(empty catch\)/)
    has(/^warn dependencies package\.json adds left-pad@\^1\.3\.0/)
    has(/^warn dependencies package-lock\.json updates a lockfile/)
    has(/^block secrets src\/app\.ts:2 adds what looks like an AWS access key/)
    has(/^block secrets scratch\/notes\.txt:1 adds what looks like a hard-coded credential/)
    has(/^block binaries assets\/logo\.bin adds or changes a binary file/)
    assert.ok(!lines.join("\n").includes("AKIAABCDEFGHIJKLMNOP"), "the secret itself is never printed")
    assert.equal(r.commits, 1)
  })

  test("merge commits are flagged; categories can be switched off", async () => {
    const { root, base } = repo({ "a.txt": "a\n" })
    git(root, "checkout", "-qb", "side")
    write(root, { "b.txt": "b\n" })
    git(root, "add", "-A")
    git(root, "commit", "-qm", "side")
    git(root, "checkout", "-q", "-")
    write(root, { "c.txt": "c\n" })
    git(root, "add", "-A")
    git(root, "commit", "-qm", "main")
    git(root, "merge", "-q", "--no-edit", "side")
    const r = await audit(root, { base, block: [], warn: ["git"] })
    assert.match(r.findings.map((f) => f.text).join("\n"), /1 merge commit on the branch/)
    const off = await audit(root, { base, block: [], warn: [] })
    assert.equal(off.findings.length, 0)
    await assert.rejects(audit(root, { base: "nope", block: [], warn: [] }), /not a commit/)
  })
})

describe("gate", () => {
  const passing = 'import { test } from "node:test"\nimport assert from "node:assert/strict"\ntest("adds", () => { assert.equal(1 + 1, 2) })\n'
  const failing = 'import { test } from "node:test"\nimport assert from "node:assert/strict"\ntest("adds", () => { assert.equal(1 + 1, 3) })\n'
  const project = (test: string) =>
    repo({
      "horde.json": JSON.stringify({ verify: { checks: { typecheck: 'node -e "process.exit(0)"', test: "node --test test/math.test.mjs" } } }),
      "test/math.test.mjs": test,
      "src/math.mjs": "export const add = (a, b) => a + b\n",
    })

  test("fail with the assertion and location, then pass once fixed; unchanged trees come from the cache", async () => {
    const { root, base } = project(passing)
    const stateDir = tmp()
    write(root, { "test/math.test.mjs": failing })
    const bad = await gate(root, { base, stateDir })
    assert.equal(bad.pass, false)
    assert.equal(bad.cached, false)
    assert.match(bad.text, /^FAIL · 1 check failed/)
    assert.match(bad.text, /✗ test · 1 failed, 0 passed/)
    // Node 24 prints the spec reporter by default; older versions print TAP when piped.
    assert.match(bad.text, /✗ test: adds — test\/math\.test\.mjs:3\n\s+(?:AssertionError \[ERR_ASSERTION\]: )?Expected values to be strictly equal:/)
    assert.match(bad.text, /✓ typecheck · ok/)
    assert.match(bad.text, /audit: 1 file changed, 0 commits since/)
    assert.deepEqual(bad.blockers, ["test: 1 failed, 0 passed"])

    const again = await gate(root, { base, stateDir })
    assert.equal(again.cached, true, "same tree, same checks: not re-run")
    assert.match(again.text, /\(cached: tree unchanged\)/)

    write(root, { "test/math.test.mjs": passing })
    const good = await gate(root, { base, stateDir })
    assert.equal(good.pass, true, good.text)
    assert.equal(good.cached, false, "the tree changed")
    assert.match(good.text, /^PASS · /)
    assert.match(good.text, /✓ test · 1 passed/)

    const logs = fs.readdirSync(path.join(stateDir, "logs"))
    assert.equal(logs.length, 1, "one log directory for this project")
    assert.match(fs.readFileSync(path.join(stateDir, "logs", logs[0]!, "test.log"), "utf8"), /^\$ node --test test\/math\.test\.mjs/)
  })

  test("blocking audit findings fail a gate whose checks pass; scope comes from the call", async () => {
    const { root, base } = project(passing)
    write(root, { "src/math.mjs": "export const add = (a, b) => a + b // ok\n", "README.md": "# new\n" })
    const v = await gate(root, { base, allowed: ["src/**"], stateDir: tmp() })
    assert.equal(v.pass, false)
    assert.match(v.text, /^FAIL · 1 blocking finding/)
    assert.match(v.text, /✗ scope: README\.md adds a file outside the allowed scope/)
    const noAudit = await gate(root, { base, audit: false, stateDir: tmp() })
    assert.equal(noAudit.pass, true)
  })

  test("many failures stay within the budget and keep the count", async () => {
    const many = `import { test } from "node:test"\nimport assert from "node:assert/strict"\n${Array.from({ length: 40 }, (_, i) => `test("case ${i}", () => { assert.equal(${i}, -1, "case ${i} is wrong: ${"x".repeat(80)}") })`).join("\n")}\n`
    const { root } = project(many)
    const v = await gate(root, { budgetChars: 1200, stateDir: tmp() })
    assert.ok(v.text.length <= 1200, `within budget: ${v.text.length}`)
    assert.match(v.text, /40 failed, 0 passed/, "exact count survives truncation")
    assert.match(v.text, /failures in test not shown \(verify_logs test\)/)
    await assert.rejects(gate(root, { checks: ["nope"], stateDir: tmp() }), /unknown check nope; available: typecheck, test/)
  })

  test("a cancelled gate stops its checks and is not cached", async () => {
    const { root } = repo({ "horde.json": JSON.stringify({ verify: { checks: { slow: 'node -e "setTimeout(() => {}, 30000)"' } } }) })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 300)
    const started = Date.now()
    const v = await gate(root, { signal: ac.signal, stateDir: tmp() })
    assert.ok(Date.now() - started < 10_000, "stopped quickly")
    assert.equal(v.pass, false)
    assert.match(v.text, /slow · cancelled/)
    const fresh = gate(root, { signal: AbortSignal.timeout(300), stateDir: tmp() })
    assert.equal((await fresh).cached, false, "a cancelled verdict was not cached")
  })
})

describe("related tests", () => {
  const check = (command: string, cwd = "/p"): Check => ({ name: "test", command, kind: "test", cwd, source: "test" })

  test("runners that take test paths are narrowed; the rest are not", () => {
    assert.equal(narrowCommand(check("pytest -q"), ["tests/test_a.py", "src/a.ts"]), "pytest -q tests/test_a.py")
    assert.equal(
      narrowCommand(check("python -m pytest"), ["tests/test a.py"]),
      `python -m pytest ${process.platform === "win32" ? '"tests/test a.py"' : "'tests/test a.py'"}`,
    )
    if (process.platform !== "win32")
      assert.equal(narrowCommand(check("pytest"), ["tests/it's $x.py"]), "pytest 'tests/it'\\''s $x.py'", "nothing expands inside single quotes")
    assert.equal(narrowCommand(check("npx vitest run"), ["src/a.test.ts"]), "npx vitest run src/a.test.ts")
    assert.equal(narrowCommand(check("jest --ci"), ["a.test.js"]), "jest --ci --runTestsByPath a.test.js", "jest reads bare arguments as patterns")
    assert.equal(narrowCommand(check("go test ./..."), ["internal/calc/calc_test.go", "a_test.go"]), "go test ./internal/calc .")
    assert.equal(narrowCommand(check("go test ./pkg"), ["pkg/a_test.go"]), undefined, "only ./... is replaced")
    assert.equal(narrowCommand(check("jest && echo done"), ["a.test.js"]), undefined)
    assert.equal(narrowCommand(check("cargo test"), ["tests/a.rs"]), undefined)
    assert.equal(narrowCommand(check("pytest"), ["src/a.test.ts"]), undefined, "no tests for this runner")
    const npm = tmp()
    write(npm, { "package.json": JSON.stringify({ scripts: { test: "vitest run --reporter=dot" } }) })
    assert.equal(narrowCommand(check("npm test", npm), ["src/a.test.ts"]), "npm test -- src/a.test.ts")
    write(npm, { "package.json": JSON.stringify({ scripts: { test: "node --test test/a.test.ts" } }) })
    assert.equal(narrowCommand(check("npm test", npm), ["src/a.test.ts"]), undefined, "node --test lists its own files")
  })

  test("a gate runs only the tests for what changed, falls back to the full suite when unsure, and flags untested code", async () => {
    // A stand-in test runner named like jest: it prints what it was asked to run.
    const { root, base } = repo({
      jest: "console.log('ran: ' + (process.argv.slice(2).join(' ') || 'everything'))\n",
      "horde.json": JSON.stringify({ verify: { checks: { test: "node jest" } } }),
      "package.json": "{}",
      "src/a.js": "exports.a = 1\n",
      "src/a.test.js": "require('./a')\n",
      "src/b.js": "exports.b = 1\n",
      "test/b.test.js": "require('../src/b')\n",
    })
    const ran = async () => {
      const v = await gate(root, { base, related: true, audit: false, stateDir: tmp() })
      return { v, log: fs.readFileSync(v.checks[0]!.logFile!, "utf8") }
    }
    write(root, { "src/a.js": "exports.a = 2\n" })
    let { v, log } = await ran()
    assert.match(v.text, /✓ test · ok · \S+ · related tests only \(1 file\)/, v.text)
    assert.match(log, /ran: --runTestsByPath src\/a\.test\.js\n/)

    write(root, { "src/b.js": "exports.b = 2\n" })
    ;({ v, log } = await ran())
    assert.match(log, /ran: --runTestsByPath src\/a\.test\.js test\/b\.test\.js\n/, "naming next to it and in a mirrored test directory")

    write(root, { "package.json": '{"name":"x"}' })
    ;({ v, log } = await ran())
    assert.match(v.text, /full suite: 1 changed file\(s\) without related tests \(package\.json\)/)
    assert.match(log, /ran: everything/)

    git(root, "checkout", "-q", "package.json")
    write(root, { "src/c.js": "exports.c = 1\n" })
    ;({ v, log } = await ran())
    assert.match(log, /ran: everything/)
    assert.match(v.text, /! tests: no test covers 1 changed source file\(s\): src\/c\.js/)
    assert.ok(v.pass, "untested code is a warning, not a blocker")
    // Without related, the full suite runs.
    const full = await gate(root, { base, audit: false, stateDir: tmp() })
    assert.match(fs.readFileSync(full.checks[0]!.logFile!, "utf8"), /ran: everything/)
    assert.doesNotMatch(full.text, /related|full suite/)
  })
})

describe("fixes", () => {
  const BLOCK = ["scope", "tests", "secrets", "binaries"] as const
  const lines = async (root: string, base: string, extra: Partial<Parameters<typeof audit>[1]> = {}) =>
    (await audit(root, { base, block: [...BLOCK], warn: ["suppressions", "dependencies", "git"], ...extra })).findings.map(
      (f) => `${f.severity} ${f.category} ${f.file ?? ""}${f.line ? `:${f.line}` : ""} ${f.text}`,
    )

  test("the gate judges with base's horde.json and flags changes to the rules", async () => {
    const passing = 'import { test } from "node:test"\ntest("ok", () => {})\n'
    const { root, base } = repo({
      "horde.json": JSON.stringify({ verify: { checks: { test: "node --test test/a.test.mjs" } } }),
      "test/a.test.mjs": passing,
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      "pyproject.toml": "[project]\nname='x'\n[tool.pytest.ini_options]\naddopts='-q'\n",
    })
    write(root, {
      "horde.json": JSON.stringify({ verify: { checks: { test: 'node -e "process.exit(0)"' } } }),
      "test/a.test.mjs": 'import { test } from "node:test"\ntest("ok", () => { throw new Error("broken") })\n',
      "package.json": JSON.stringify({ name: "x", scripts: { test: "true", build: "tsc" } }),
      "pyproject.toml": "[project]\nname='y'\n[tool.pytest.ini_options]\naddopts='-q -k nothing'\n",
      "jest.config.js": "module.exports = {}\n",
    })
    const v = await gate(root, { base, stateDir: tmp() })
    assert.equal(v.pass, false)
    assert.match(v.text, /✗ test · 1 failed/, "the check from base ran, not the worker's replacement")
    for (const what of [
      "horde.json changes the rules the gate checks with: horde.json verify",
      "package.json changes the rules the gate checks with: package.json scripts test, build",
      "pyproject.toml changes the rules the gate checks with: pyproject.toml [tool.pytest]",
      "jest.config.js changes the rules the gate checks with: jest.config.js",
    ])
      assert.ok(v.blockers.includes(`tests: ${what}`), `${what} in ${v.blockers.join("\n")}`)
    assert.ok(!v.blockers.some((b) => /pyproject.*\[project\]/.test(b)), "other pyproject sections are not rules")
  })

  test("no checks is not a pass", async () => {
    const { root } = repo({ "README.md": "# x\n" })
    const v = await gate(root, { stateDir: tmp() })
    assert.equal(v.pass, false)
    assert.deepEqual(v.blockers, ["no checks to run (configure verify.checks in horde.json)"])
    assert.match(v.text, /^FAIL · no checks to run/)
  })

  test("scope: the call's globs narrow horde.json's", async () => {
    const { root, base } = repo({
      "horde.json": JSON.stringify({ verify: { checks: { ok: 'node -e "0"' }, audit: { allowed: ["src/**", "horde.json"] } } }),
      "src/auth/a.ts": "1\n",
      "src/other.ts": "1\n",
    })
    write(root, { "src/auth/a.ts": "2\n", "src/other.ts": "2\n", "docs/x.md": "x\n" })
    const v = await gate(root, { base, allowed: ["src/auth/**", "docs/**"], stateDir: tmp() })
    assert.ok(v.blockers.includes("scope: src/other.ts changes a file outside the allowed scope"), v.text)
    assert.ok(v.blockers.includes("scope: docs/x.md adds a file outside the allowed scope"), "outside horde.json's scope")
    assert.ok(!v.blockers.some((b) => b.includes("src/auth/a.ts")))
  })

  test("the diff starts at the merge-base, and the cache keys the base by its commit", async () => {
    const { root } = repo({ "a.txt": "a\n", "horde.json": JSON.stringify({ verify: { checks: { ok: 'node -e "0"' } } }) })
    git(root, "branch", "main-line")
    git(root, "checkout", "-qb", "work")
    write(root, { "w.txt": "w\n" })
    git(root, "add", "-A")
    git(root, "commit", "-qm", "work")
    git(root, "checkout", "-q", "main-line")
    write(root, { "m.txt": "m\n" })
    git(root, "add", "-A")
    git(root, "commit", "-qm", "main moved on")
    git(root, "checkout", "-q", "work")
    const r = await audit(root, { base: "main-line", block: [], warn: [] })
    assert.deepEqual(r.files, ["w.txt"], "main's own later commits are not the work's")
    const stateDir = tmp()
    assert.equal((await gate(root, { base: "main-line", stateDir })).cached, false)
    assert.equal((await gate(root, { base: "main-line", stateDir })).cached, true)
    git(root, "branch", "-f", "main-line", "work")
    assert.equal((await gate(root, { base: "main-line", stateDir })).cached, false, "the base moved: a different judgement")
  })

  test("diff parsing: fixed prefixes, headers only before the first hunk, quoted paths", async () => {
    // Windows has no file names with a double quote: the quoted-path case is POSIX only.
    const weird = process.platform !== "win32"
    const { root, base } = repo({ "test/a.test.ts": "-- note\nkeep\n", ...(weird ? { 'test/we"ird.test.ts': "x\n" } : {}) })
    git(root, "config", "diff.mnemonicPrefix", "true")
    git(root, "config", "diff.noprefix", "true")
    write(root, { "test/a.test.ts": "++ y\nkeep\ntest.skip('a', () => {})\n", ...(weird ? { 'test/we"ird.test.ts': "x\nit.only('b', () => {})\n" } : {}) })
    const l = await lines(root, base)
    assert.ok(l.includes("block tests test/a.test.ts:3 skips a test"), l.join("\n"))
    if (weird) assert.ok(l.includes('block tests test/we"ird.test.ts:2 focuses tests with .only (all others stop running)'), l.join("\n"))
  })

  test("tests renamed so no runner picks them up are flagged", async () => {
    const { root, base } = repo({ "src/x.test.ts": "test('a', () => {})\n", "tests/test_x.py": "def test_a(): pass\n", "tests/conftest.py": "x = 1\n" })
    git(root, "mv", "src/x.test.ts", "src/x.test.ts.bak")
    git(root, "mv", "tests/test_x.py", "tests/x_disabled.py")
    const l = await lines(root, base)
    assert.ok(
      l.some((x) => /^block tests src\/x\.test\.ts moves a test file out of the test suite/.test(x)),
      l.join("\n"),
    )
    assert.ok(
      l.some((x) => /^block tests tests\/test_x\.py moves a test file out of the test suite/.test(x)),
      l.join("\n"),
    )
  })

  test("skip and focus markers across runners, without ordinary words", async () => {
    const marked = [
      "@pytest.mark.skipif(sys.platform == 'win32', reason='x')",
      "@pytest.mark.xfail",
      "test.skip.each([1])('a', () => {})",
      "it.skipIf(process.env.CI)('a', () => {})",
      "test.runIf(false)('a', () => {})",
      "test.todo('later')",
      "fit('only this', () => {})",
      "fdescribe('only these', () => {})",
      "test('a', { skip: true }, () => {})",
      "test('b', { todo: 'later' }, () => {})",
      "  t.skip('not now')",
      "  this.skip()",
      '#[ignore = "slow"]',
      "@Disabled",
      "@Ignore",
      "xit('a', () => {})",
      "xdescribe('a', () => {})",
      "test.only.each([1])('a', () => {})",
    ]
    const ordinary = ["model.fit(x, y)", "const outfit = outfit(1)", "const skip = items.skip(2)", "// we skip: nothing", "xs.fit(3)"]
    const { root, base } = repo({ "test/a.test.ts": "\n" })
    write(root, { "test/a.test.ts": `${[...marked, ...ordinary].join("\n")}\n` })
    const hit = new Set((await audit(root, { base, block: ["tests"], warn: [] })).findings.map((f) => f.line))
    for (const [i, m] of marked.entries()) assert.ok(hit.has(i + 1), `line ${i + 1}: ${m}`)
    for (const [i, o] of ordinary.entries()) assert.ok(!hit.has(marked.length + i + 1), `not a marker: ${o}`)
  })

  test("secrets: placeholders and words are not credentials, sk- needs a key-like body", async () => {
    const { root, base } = repo({ "a.txt": "\n" })
    const bad = ['password = "q7Ldf9Xk2Pz0vBn4Rt8w"', 'key = "sk-AbCdEfGhIjKlMnOpQrStUv12"', 'k = "sk-ant-api03-AbCdEfGh_IjKlMnOp-QrStUv12"']
    const fine = [
      `password = "\${DATABASE_PASSWORD_VALUE}"`,
      'token = "{{ secrets.DEPLOY_TOKEN }}"',
      'api_key = "<your-api-key-goes-here>"',
      'secret = "xxxxxxxxxxxxxxxxxxxx"',
      'token = "this_is_a_token_name"',
      'const cls = "sk-some-long-kebab-case-class-name"',
    ]
    write(root, { "a.txt": `${[...bad, ...fine].join("\n")}\n` })
    const hit = new Set((await audit(root, { base, block: ["secrets"], warn: [] })).findings.map((f) => f.line))
    for (const [i, b] of bad.entries()) assert.ok(hit.has(i + 1), b)
    for (const [i, f] of fine.entries()) assert.ok(!hit.has(bad.length + i + 1), f)
  })

  test("size: new or newly big files only, never lockfiles", async () => {
    const big = "x".repeat(1024 * 1024 + 10)
    const { root, base } = repo({ "data/big.txt": big, "src/a.txt": "a\n" })
    write(root, { "data/big.txt": `${big}more\n`, "src/a.txt": big, "new.txt": big, "package-lock.json": big })
    const l = (await lines(root, base)).filter((x) => / MB$/.test(x))
    assert.deepEqual(l.map((x) => x.split(" ")[2]).sort(), ["new.txt", "src/a.txt"])
  })

  test("audit categories not listed anywhere warn", () => {
    const { root } = repo({ "horde.json": JSON.stringify({ verify: { audit: { block: ["scope"], off: ["git"] } } }) })
    const s = loadSettings(root)
    assert.deepEqual(s.audit.block, ["scope"])
    assert.deepEqual(s.audit.warn.sort(), ["binaries", "dependencies", "secrets", "suppressions", "tests"])
  })

  test("detect: Python environment, uv, and pytest only with tests to run", async () => {
    const { root } = repo({ "pyproject.toml": "[project]\nname='x'\n", "tests/data.json": "{}\n", "src/pkg/__init__.py": "" })
    assert.deepEqual(await detectChecks(root), [], "a tests/ directory alone is not a pytest suite")
    write(root, { "tests/test_a.py": "def test_a(): pass\n" })
    const [t] = await detectChecks(root)
    assert.equal(t!.name, "test")
    assert.equal(t!.env?.PYTHONPATH, [path.join(root, "src"), root].join(path.delimiter))
    assert.deepEqual(t!.stripEnv, ["VIRTUAL_ENV"])
    const bin = tmp()
    // Windows finds executables by extension (PATHEXT).
    const uv = process.platform === "win32" ? "uv.cmd" : "uv"
    write(bin, { [uv]: process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n" })
    fs.chmodSync(path.join(bin, uv), 0o755)
    write(root, { "uv.lock": "" })
    const saved = process.env.PATH
    process.env.PATH = `${bin}${path.delimiter}${saved}`
    try {
      assert.equal((await detectChecks(root))[0]!.command, "uv run python -m pytest -q")
    } finally {
      process.env.PATH = saved
    }
  })

  test("detect: cargo workspaces, nested and go.work Go modules, package managers up the tree", async () => {
    const { root } = repo({
      "rs/Cargo.toml": "[workspace]\nmembers = ['a']\n",
      "go/go.mod": "module x\n",
      "go/tools/gen/go.mod": "module y\n",
      "gw/go.work": "go 1.22\nuse (\n  ./a // first\n  ./b\n)\n",
      "gw/a/go.mod": "module a\n",
      "gw/b/go.mod": "module b\n",
      "js/pnpm-lock.yaml": "",
      "js/pkg/package.json": JSON.stringify({ scripts: { test: "vitest" } }),
      "pm/package.json": JSON.stringify({ packageManager: "yarn@4.1.0", scripts: { lint: "eslint" } }),
      "pm/package-lock.json": "{}",
    })
    assert.equal((await detectChecks(path.join(root, "rs")))[0]!.command, "cargo test --workspace --color never")
    assert.deepEqual(
      (await detectChecks(path.join(root, "go"))).map((c) => [c.name, path.relative(root, c.cwd).replace(/\\/g, "/")]),
      [
        ["vet", "go"],
        ["vet:tools/gen", "go/tools/gen"],
        ["test", "go"],
        ["test:tools/gen", "go/tools/gen"],
      ],
    )
    assert.deepEqual(
      (await detectChecks(path.join(root, "gw"))).map((c) => c.name),
      ["vet:a", "vet:b", "test:a", "test:b"],
    )
    assert.equal((await detectChecks(path.join(root, "js", "pkg")))[0]!.command, "pnpm run test", "lockfile found up the tree")
    assert.equal((await detectChecks(path.join(root, "pm")))[0]!.command, "yarn run lint", "packageManager wins")
  })

  test("detect: real paths when walking up, never past the repository", async () => {
    const outer = tmp()
    write(outer, { "package.json": JSON.stringify({ scripts: { test: "jest" } }) })
    const { root } = repo({ "sub/readme.txt": "x\n" })
    fs.symlinkSync(path.join(root, "sub"), path.join(outer, "link"))
    assert.deepEqual(await detectChecks(path.join(outer, "link")), [])
  })

  test("related: renames, aliases, non-runnable test files, nested Python projects", async () => {
    const { root, base } = repo({ "src/a.js": "exports.a = 1\n", "src/a.test.js": "require('./a')\n", "tests/conftest.py": "\n" })
    git(root, "mv", "src/a.js", "src/b.js")
    assert.deepEqual((await changedFiles(root, base)).files.sort(), ["src/a.js", "src/b.js"], "both sides of a rename")
    git(root, "mv", "src/b.js", "src/a.js")
    const test = (command: string, cwd = root): Check => ({ name: "test", command, kind: "test", cwd, source: "t" })
    const plan = (files: string[], c = test("npx jest")) => planRelated(root, files, [c]).plans.get(c)!
    assert.ok(plan(["src/a.js"]).command, "narrowed")
    assert.match(plan(["tests/conftest.py"]).full ?? "", /without related tests \(tests\/conftest\.py\)/)
    write(root, { "svc/pyproject.toml": "[tool.pytest.ini_options]\n", "svc/tests/test_app.py": "def test_a(): pass\n" })
    assert.equal(plan(["svc/tests/test_app.py"], test("pytest", path.join(root, "svc"))).full, "its Python project is not at the repository root")
    write(root, { "tsconfig.json": '{ "compilerOptions": { "paths": { "@/*": ["src/*"] } } }' })
    assert.equal(plan(["src/a.js"]).full, "the project uses import aliases")
  })

  test("extract: failed suites count, Go parents are not doubled; log names do not collide", () => {
    const jest = "FAIL test/a.test.js\n  ● Test suite failed to run\n\n    SyntaxError: x\n\nTest Suites: 1 failed, 1 total\nTests:       0 total\n"
    assert.equal(extract(jest, "npx jest").counts?.failed, 1)
    const vitest = " FAIL  test/a.test.ts [ test/a.test.ts ]\nError: boom\n\n Test Files  1 failed (1)\n      Tests  no tests\n"
    assert.equal(extract(vitest, "npx vitest run").counts?.failed, 1)
    const go = [
      "=== RUN   TestParent",
      "=== RUN   TestParent/sub",
      "    a_test.go:10: boom",
      "--- FAIL: TestParent (0.00s)",
      "    --- FAIL: TestParent/sub (0.00s)",
      "        a_test.go:10: boom",
      "FAIL",
      "FAIL\tx\t0.01s",
    ].join("\n")
    const r = extract(go, "go test ./...")
    assert.deepEqual(
      r.failures.map((f) => f.test),
      ["TestParent/sub"],
    )
    assert.equal(r.counts?.failed, 1)
    assert.notEqual(logFileFor("/l", "test:unit"), logFileFor("/l", "test_unit"))
    assert.equal(path.basename(logFileFor("/l", "test")), "test.log")
  })
})

describe("MCP server", () => {
  test("detect, gate and logs over stdio", async () => {
    const { root, base } = repo({
      "horde.json": JSON.stringify({ verify: { checks: { test: "node --test test/math.test.mjs" } } }),
      "test/math.test.mjs": 'import { test } from "node:test"\nimport assert from "node:assert/strict"\ntest("adds", () => { assert.equal(1 + 1, 3) })\n',
    })
    const client = new Client({ name: "test", version: "0" })
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--conditions=source", "--import", "tsx", path.join(pkg, "src/index.ts")],
        cwd: pkg,
        env: { ...(process.env as Record<string, string>), HORDE_VERIFY_DIRECTORY: root, HORDE_VERIFY_STATE_DIR: tmp() },
        stderr: "inherit",
      }),
    )
    try {
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const res = (await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as { content: { text: string }[]; isError?: boolean }
        return { text: res.content.map((c) => c.text).join("\n"), isError: !!res.isError }
      }
      const tools = (await client.listTools()).tools.map((t) => t.name).sort()
      assert.deepEqual(tools, ["verify_audit", "verify_detect", "verify_gate", "verify_logs", "verify_run"])
      assert.match((await call("verify_detect")).text, /^test \(test\): node --test test\/math\.test\.mjs {2}← horde\.json/)
      const logsFirst = await call("verify_logs", { check: "test" })
      assert.ok(logsFirst.isError)
      assert.match(logsFirst.text, /no log for "test"/)
      const verdict = await call("verify_gate", { base })
      assert.match(verdict.text, /^FAIL · 1 check failed/)
      // TAP on Node 20/22, spec on Node 24.
      assert.match((await call("verify_logs", { check: "test", max_chars: 4000 })).text, /(?:not ok 1 - adds|✖ adds)/)
      assert.match((await call("verify_audit", { base })).text, /0 files changed, 0 commits since \w+; no findings\./)
    } finally {
      await client.close()
    }
  })
})
