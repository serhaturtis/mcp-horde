import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, test } from "node:test"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import {
  type AuditCategory,
  type AuditOptions,
  audit,
  type Check,
  changedFiles,
  detectChecks,
  extract,
  gate,
  globMatcher,
  isTestPath,
  loadSettings,
  loadSettingsAt,
  logFileFor,
  narrowCommand,
  planRelated,
  render,
  runChecks,
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
    // A name that says nothing: the command's test runner makes it a test check, anything else stays "other".
    // A compound command runs more than a test, so it stays "other" too (work rounds may skip it).
    write(root, {
      "horde.json": JSON.stringify({
        verify: {
          checks: {
            go: "go test -race ./...",
            runtime: "uv run python -m pytest -q",
            ui: "npx vitest run",
            tier: "python scripts/run_gates.py",
            both: "npm test && npm run build",
          },
        },
      }),
    })
    assert.deepEqual(
      (await detectChecks(root)).map((c) => [c.name, c.kind]),
      [
        ["go", "test"],
        ["runtime", "test"],
        ["ui", "test"],
        ["tier", "other"],
        ["both", "other"],
      ],
    )
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

  test("generated output is not audited as source, but stays in scope; real binaries still block", async () => {
    // A bundle git treats as binary (-diff), holding text that would otherwise read as a secret.
    const { root, base } = repo({ ".gitattributes": "dist/** -diff\n", "dist/app.js": "var a=1\n", "src/a.ts": "export const a = 1\n" })
    write(root, { "dist/app.js": 'var a=2;var k="AKIAABCDEFGHIJKLMNOP"\n', "assets/logo.bin": Buffer.from([0, 1, 2, 3, 0, 255]) })
    const opts = { base, block: ["scope", "tests", "secrets", "binaries"] as AuditCategory[], warn: [] as AuditCategory[] }
    const lines = async (o: Partial<AuditOptions>) => (await audit(root, { ...opts, ...o })).findings.map((f) => `${f.category} ${f.file}`)
    // A -diff text file is audited as text, so the key inside it is a secret, not a binary.
    const plain = await lines({})
    assert.ok(plain.includes("secrets dist/app.js"), plain.join("\n"))
    assert.ok(!plain.includes("binaries dist/app.js"), "a -diff text file is not a binary")
    const found = await lines({ generated: ["dist/**"] })
    assert.ok(!found.some((l) => l.endsWith(" dist/app.js")), found.join("\n"))
    assert.ok(found.includes("binaries assets/logo.bin"), found.join("\n"))
    assert.ok((await lines({ generated: ["dist/**"], allowed: ["src/**"] })).includes("scope dist/app.js"))
  })

  test("a top-level process.exit in a test file blocks; a string in a fixture does not", async () => {
    const calls = ["process.exit(0)", "os._exit(0)", "sys.exit(0)", "  sys.exit(1)"]
    const fine = ['const src = "process.exit(0)"', 'const o = "os._exit(0)"', 'x = "sys.exit(0)"']
    const { root, base } = repo({ "test/a.test.js": "\n" })
    write(root, { "test/a.test.js": `${[...fine, ...calls].join("\n")}\n` })
    const findings = (await audit(root, { base, block: ["tests"], warn: [] })).findings
    const hit = new Set(findings.filter((f) => f.category === "tests" && f.text === "exits the test process early").map((f) => f.line))
    for (const [i, call] of calls.entries()) assert.ok(hit.has(fine.length + i + 1), `line ${fine.length + i + 1}: ${call}`)
    assert.equal(
      findings.filter((f) => f.category === "tests").length,
      calls.length,
      `only the top-level exit calls match:\n${findings.map((f) => `${f.line}: ${f.text}`).join("\n")}`,
    )
  })

  test("-diff text files are audited as text, and real binaries still block", async () => {
    // Built at run time so this file holds no literal secret the gate would flag.
    const key = "AKIA" + "ABCDEFGHIJKLMNOP"
    const { root, base } = repo({
      ".gitattributes": "package-lock.json -diff\nsrc/config.js -diff\n",
      "package-lock.json": '{"name":"x","version":"1"}\n',
      "src/config.js": "export const host = 'a'\n",
    })
    write(root, {
      "package-lock.json": '{"name":"x","version":"2"}\n',
      "src/config.js": `export const host = "b"\nexport const key = "${key}"\n`,
      "assets/logo.bin": Buffer.from([0, 1, 2, 3, 0, 255]),
    })
    const r = await audit(root, { base, block: ["binaries", "secrets"], warn: ["dependencies"] })
    const lines = r.findings.map((f) => `${f.severity} ${f.category} ${f.file ?? ""}${f.line ? `:${f.line}` : ""} ${f.text}`)
    assert.ok(
      lines.some((l) => /^block secrets src\/config\.js:2 adds what looks like an AWS access key$/.test(l)),
      lines.join("\n"),
    )
    assert.ok(
      lines.some((l) => /^warn dependencies package-lock\.json updates a lockfile$/.test(l)),
      lines.join("\n"),
    )
    assert.ok(
      lines.some((l) => /^block binaries assets\/logo\.bin adds or changes a binary file$/.test(l)),
      lines.join("\n"),
    )
    assert.ok(!lines.some((l) => l.includes("binaries") && (l.includes("package-lock") || l.includes("config.js"))), lines.join("\n"))
  })

  test("a real binary stays binary and its bytes are never scanned", async () => {
    // Built at run time so this file holds no literal secret the gate would flag.
    const key = "AKIA" + "ABCDEFGHIJKLMNOP"
    const { root, base } = repo({ "README.md": "x\n" })
    // 1 MiB of NULs with a secret-looking prefix: a real binary, so its bytes are not
    // dumped into the patch nor scanned for the key.
    const bytes = Buffer.alloc(1024 * 1024)
    bytes.write(key)
    write(root, { "model.bin": bytes })
    git(root, "add", "-A")
    const r = await audit(root, { base, block: ["binaries", "secrets"], warn: [] })
    const lines = r.findings.map((f) => `${f.category} ${f.file ?? ""} ${f.text}`)
    assert.ok(
      lines.some((l) => /^binaries model\.bin adds or changes a binary file$/.test(l)),
      lines.join("\n"),
    )
    assert.ok(!lines.some((l) => l.includes("secrets")), lines.join("\n"))
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
    assert.equal(again.cached, false, "a failure is never reused: the same tree runs again")
    assert.equal(again.pass, false)
    assert.match(again.text, /^FAIL · /)

    write(root, { "test/math.test.mjs": passing })
    const good = await gate(root, { base, stateDir })
    assert.equal(good.pass, true, good.text)
    assert.equal(good.cached, false, "the tree changed")
    assert.match(good.text, /^PASS · /)
    assert.match(good.text, /✓ test · 1 passed/)

    const cached = await gate(root, { base, stateDir })
    assert.equal(cached.cached, true, "a pass on the same tree is reused")
    assert.match(cached.text, /\(cached: tree unchanged\)/)

    const logs = fs.readdirSync(path.join(stateDir, "logs"))
    assert.equal(logs.length, 1, "one log directory for this project")
    assert.match(fs.readFileSync(path.join(stateDir, "logs", logs[0]!, "test.log"), "utf8"), /^\$ node --test test\/math\.test\.mjs/)
  })

  test("a runner whose failures a wrapper hides still fails the gate", async () => {
    const { root, base } = repo({
      "horde.json": JSON.stringify({ verify: { checks: { test: "node run.mjs" } } }),
      // The wrapper runs node --test but exits 0, the way `… | tail` or `…; echo done` would.
      "run.mjs":
        'import { spawnSync } from "node:child_process"\nspawnSync(process.execPath, ["--test", "test/math.test.mjs"], { stdio: "inherit" })\nprocess.exit(0)\n',
      "test/math.test.mjs": failing,
      "src/math.mjs": "export const add = (a, b) => a + b\n",
    })
    const v = await gate(root, { base, stateDir: tmp() })
    assert.equal(v.pass, false, v.text)
    assert.match(v.text, /✗ test · exited 0 although 1 test failed/)
    assert.deepEqual(v.blockers, ["test: exited 0 although 1 test failed"])
  })

  test("a passing summary line shows a reported failed count, and omits zero", () => {
    const verdict = (failed: number) => ({
      pass: true,
      directory: "/x",
      checks: [
        {
          name: "test",
          command: "node --test",
          kind: "test" as const,
          pass: true,
          code: 0,
          durationMs: 1,
          extracted: { runner: "generic" as const, failures: [], counts: { failed, passed: 3, skipped: 1 } },
        },
      ],
      blockers: [],
      warnings: [],
      durationMs: 1,
    })
    assert.match(render(verdict(1), 1000), /✓ test · 3 passed, 1 failed, 1 skipped/)
    const plain = render(verdict(0), 1000)
    assert.match(plain, /✓ test · 3 passed, 1 skipped/)
    assert.doesNotMatch(plain, /0 failed/)
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

  test("files a check writes during the run are not audited, but a tracked file it modifies is", async () => {
    const write = [
      'import fs from "node:fs"',
      'fs.writeFileSync("report.xml", "<testsuite/>")',
      'fs.mkdirSync("__pycache__", { recursive: true })',
      'fs.writeFileSync("__pycache__/x.pyc", "x")',
      // Built at run time so the test file itself holds no literal secret the gate would flag.
      'const secret = "sk-" + "AbCdEfGhIjKlMnOpQrStUv12"',
      'fs.appendFileSync("src/out.txt", "key = " + JSON.stringify(secret) + "\\n")',
    ].join("\n")
    const { root, base } = repo({
      "horde.json": JSON.stringify({ verify: { checks: { test: "node write.mjs" } } }),
      "write.mjs": write,
      "src/out.txt": "tracked\n",
    })
    const v = await gate(root, { base, allowed: ["src/**"], stateDir: tmp() })
    assert.equal(v.pass, false, v.text)
    // The check's own files are not the work, so the scope never blames the worker for them.
    assert.ok(!v.blockers.some((b) => b.includes("report.xml")), v.blockers.join("\n"))
    assert.ok(!v.blockers.some((b) => b.includes("__pycache__")), v.blockers.join("\n"))
    // A tracked file the check modified still counts as the work.
    assert.ok(
      v.blockers.some((b) => b.includes("src/out.txt")),
      v.blockers.join("\n"),
    )
  })
})

describe("baseline", () => {
  // A small check script that fails the tests named in failures.json, in node's TAP format.
  const checkScript = [
    'import fs from "node:fs"',
    'const names = JSON.parse(fs.readFileSync("failures.json", "utf8"))',
    'const count = fs.existsSync("count.txt") ? Number(fs.readFileSync("count.txt", "utf8")) : names.length',
    'console.log("TAP version 13")',
    "names.forEach((name, i) => {",
    '  console.log("not ok " + (i + 1) + " - " + name)',
    '  console.log("  ---")',
    '  console.log("  location: \'test/" + name + ".test.mjs:" + (i + 3) + ":1\'")',
    '  console.log("  error: \'boom " + name + "\'")',
    '  console.log("  ...")',
    "})",
    'console.log("1.." + names.length)',
    'console.log("# fail " + count)',
    "if (count) process.exitCode = 1",
  ].join("\n")

  const project = (failures: string[]) =>
    repo({
      "horde.json": JSON.stringify({ verify: { checks: { test: "node check.mjs" } } }),
      "check.mjs": checkScript,
      "failures.json": JSON.stringify(failures),
    })

  const checkoutOf = (root: string, commit: string, calls: { n: number }, releases: { n: number }) => async () => {
    calls.n++
    const dir = path.join(tmp(), "checkout")
    git(root, "worktree", "add", "--detach", "-q", dir, commit)
    return {
      root: dir,
      release: async () => {
        releases.n++
        git(root, "worktree", "remove", "--force", dir)
      },
    }
  }

  test("a check that fails the same way at the baseline passes with a warning", async () => {
    const { root, base } = project(["adds"])
    const calls = { n: 0 }
    const releases = { n: 0 }
    const stateDir = tmp()
    const v = await gate(root, {
      baseline: { commit: base, label: "master's tip", checkout: checkoutOf(root, base, calls, releases) },
      stateDir,
    })
    assert.equal(v.pass, true, v.text)
    assert.match(v.text, /! test · fails at master's tip too, same failures · /)
    assert.doesNotMatch(v.text, /1 check failed/)
    assert.ok(v.warnings.includes("test: fails at master's tip too, with the same failures (not caused by this change)"), v.warnings.join("\n"))
    assert.ok(!v.blockers.some((b) => b.startsWith("test:")))
    assert.deepEqual(v.checks[0]!.baseline, { label: "master's tip", pass: false, known: 1 })
    assert.equal(calls.n, 1)
    assert.equal(releases.n, 1)
    assert.equal(fs.readdirSync(path.join(stateDir, "logs")).length, 1, "the baseline's logs were deleted")
  })

  test("only the failures not seen at the baseline are listed", async () => {
    const { root, base } = project(["adds"])
    write(root, { "failures.json": JSON.stringify(["adds", "multiplies"]) })
    const calls = { n: 0 }
    const releases = { n: 0 }
    const v = await gate(root, {
      baseline: { commit: base, label: "master's tip", checkout: checkoutOf(root, base, calls, releases) },
      stateDir: tmp(),
    })
    assert.equal(v.pass, false)
    assert.match(v.text, /✗ test · 2 failed/)
    assert.match(v.text, /✗ test: multiplies — test\/multiplies\.test\.mjs:4/)
    assert.doesNotMatch(v.text, /✗ test: adds/)
    assert.match(v.text, / {2}\(1 more also fail at master's tip\)/)
    assert.deepEqual(v.checks[0]!.baseline, { label: "master's tip", pass: false, known: 1 })
    assert.deepEqual(
      v.checks[0]!.extracted.failures.map((f) => f.test),
      ["multiplies"],
    )
    assert.equal(calls.n, 1)
    assert.equal(releases.n, 1)
  })

  test("a larger failure count than the baseline keeps the check failing", async () => {
    // The runner says two tests failed but lists only one; the baseline lists that same one and says one failed.
    const { root, base } = project(["adds"])
    write(root, { "count.txt": "2" })
    const calls = { n: 0 }
    const releases = { n: 0 }
    const v = await gate(root, {
      baseline: { commit: base, label: "master's tip", checkout: checkoutOf(root, base, calls, releases) },
      stateDir: tmp(),
    })
    assert.equal(v.pass, false)
    assert.match(v.text, /✗ test · 2 failed/)
    assert.match(v.text, /✗ test: adds/)
    assert.doesNotMatch(v.text, /fails at master|also fail at master/)
    assert.deepEqual(v.checks[0]!.baseline, { label: "master's tip", pass: false, known: 0 })
    assert.equal(calls.n, 1)
    assert.equal(releases.n, 1)
  })

  test("a check that passes at the baseline fails as before", async () => {
    const { root, base } = project([])
    write(root, { "failures.json": JSON.stringify(["adds"]) })
    const calls = { n: 0 }
    const releases = { n: 0 }
    const v = await gate(root, {
      baseline: { commit: base, label: "master's tip", checkout: checkoutOf(root, base, calls, releases) },
      stateDir: tmp(),
    })
    assert.equal(v.pass, false)
    assert.match(v.text, /✗ test · 1 failed/)
    assert.doesNotMatch(v.text, /fails at master|also fail at master/)
    assert.deepEqual(v.checks[0]!.baseline, { label: "master's tip", pass: true, known: 0 })
    assert.equal(calls.n, 1)
    assert.equal(releases.n, 1)
  })

  test("the checkout is skipped when every check passes, and shared by gates needing the same baseline", async () => {
    const calls = { n: 0 }
    const releases = { n: 0 }

    const ok = project([])
    const pass = await gate(ok.root, {
      baseline: { commit: ok.base, label: "master's tip", checkout: checkoutOf(ok.root, ok.base, calls, releases) },
      stateDir: tmp(),
    })
    assert.equal(pass.pass, true)
    assert.equal(calls.n, 0, "nothing failed, so no checkout")

    const { root, base } = project(["adds"])
    const checkout = checkoutOf(root, base, calls, releases)
    const baseline = { commit: base, label: "master's tip", checkout }
    const [a, b] = await Promise.all([gate(root, { baseline, stateDir: tmp(), fresh: true }), gate(root, { baseline, stateDir: tmp(), fresh: true })])
    assert.equal(a.pass, true, a.text)
    assert.equal(b.pass, true, b.text)
    assert.equal(calls.n, 1, "concurrent gates share one checkout")
    assert.equal(releases.n, 1)

    const later = await gate(root, { baseline, stateDir: tmp(), fresh: true })
    assert.equal(later.pass, true)
    assert.equal(calls.n, 1, "the baseline is cached for 15 minutes")
  })

  test("a checkout that throws leaves the verdict unchanged and warns", async () => {
    const { root, base } = project(["adds"])
    const v = await gate(root, {
      baseline: { commit: base, label: "master's tip", checkout: async () => Promise.reject(new Error("deps are missing")) },
      stateDir: tmp(),
    })
    assert.equal(v.pass, false)
    assert.match(v.text, /✗ test · 1 failed/)
    assert.ok(v.warnings.includes("could not compare with master's tip: deps are missing"), v.warnings.join("\n"))
    assert.equal(v.checks[0]!.baseline, undefined)
  })

  test("a runner missing at both the work and the base stays failed", async () => {
    const { root, base } = repo({
      "horde.json": JSON.stringify({ verify: { checks: { test: "definitely-not-a-command" } } }),
    })
    const calls = { n: 0 }
    const releases = { n: 0 }
    const baseline = { commit: base, label: "master's tip", checkout: checkoutOf(root, base, calls, releases) }
    // A task's rounds (base and stage "work"), then the landing gate's options (no base, audit off).
    for (const opts of [
      { base, stage: "work" as const, env: { HORDE_TASK: "t-1", HORDE_WORKTREE: root } },
      { stage: "land" as const, audit: false, related: false, env: { HORDE_TASK: "t-1", HORDE_WORKTREE: root } },
    ]) {
      const v = await gate(root, { ...opts, baseline, stateDir: tmp() })
      assert.equal(v.pass, false, v.text)
      assert.match(v.text, /✗ test · exit 127/)
      assert.doesNotMatch(v.text, /fails at master's tip/)
      assert.equal(v.checks[0]!.baseline, undefined, "never rescued: it never ran")
    }
    assert.equal(calls.n, 0, "a check that never ran is not compared with a baseline")
  })

  test("a check that timed out is never rescued by the baseline", async () => {
    const { root, base } = repo({
      "horde.json": JSON.stringify({ verify: { checks: { slow: 'node -e "setTimeout(() => {}, 5000)"' }, timeoutSeconds: 1 } }),
    })
    const calls = { n: 0 }
    const releases = { n: 0 }
    const v = await gate(root, {
      baseline: { commit: base, label: "master's tip", checkout: checkoutOf(root, base, calls, releases) },
      stateDir: tmp(),
    })
    assert.equal(v.pass, false, v.text)
    assert.match(v.text, /✗ slow · timed out/)
    assert.equal(calls.n, 0, "a timed-out check is not compared with a baseline")
  })

  test("a failure whose name differs from the base only in digits is new", async () => {
    const { root, base } = project(["test_limit_10"])
    write(root, { "failures.json": JSON.stringify(["test_limit_20"]) })
    const v = await gate(root, {
      baseline: { commit: base, label: "master's tip", checkout: checkoutOf(root, base, { n: 0 }, { n: 0 }) },
      stateDir: tmp(),
    })
    assert.equal(v.pass, false, v.text)
    assert.match(v.text, /✗ test: test_limit_20/)
    assert.deepEqual(v.checks[0]!.baseline, { label: "master's tip", pass: false, known: 0 })
  })

  test("a new failure after ten known at the base is reported as new", async () => {
    const known = Array.from({ length: 10 }, (_, i) => `case ${i}`)
    const { root, base } = project(known)
    write(root, { "failures.json": JSON.stringify([...known, "case new"]) })
    const v = await gate(root, {
      baseline: { commit: base, label: "master's tip", checkout: checkoutOf(root, base, { n: 0 }, { n: 0 }) },
      stateDir: tmp(),
    })
    assert.equal(v.pass, false, v.text)
    assert.match(v.text, /✗ test: case new/)
    assert.deepEqual(v.checks[0]!.baseline, { label: "master's tip", pass: false, known: 10 })
    assert.deepEqual(
      v.checks[0]!.extracted.failures.map((f) => f.test),
      ["case new"],
    )
  })

  test("a cut-off failure list is not treated as the same failures", async () => {
    const script = [
      'import fs from "node:fs"',
      'const n = Number(fs.readFileSync("count.txt", "utf8"))',
      "for (let i = 0; i < n; i++) {",
      '  console.log("Error: boom " + i)',
      '  console.log("  at a")',
      '  console.log("  at b")',
      '  console.log("  at c")',
      '  console.log("  at d")',
      '  console.log("  at e")',
      "}",
      "process.exitCode = 1",
    ].join("\n")
    const { root, base } = repo({
      "horde.json": JSON.stringify({ verify: { checks: { test: "node check.mjs" } } }),
      "check.mjs": script,
      "count.txt": "11",
    })
    const calls = { n: 0 }
    const releases = { n: 0 }
    const v = await gate(root, {
      baseline: { commit: base, label: "master's tip", checkout: checkoutOf(root, base, calls, releases) },
      stateDir: tmp(),
    })
    assert.equal(v.pass, false, v.text)
    assert.match(v.text, /✗ test · exit 1/)
    assert.equal(calls.n, 0, "a cut-off failure list is not compared with a baseline")
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
    assert.equal(
      narrowCommand(check("node --import tsx --test --test-concurrency=1 test/a.test.ts test/b.test.ts"), ["test/b.test.ts"]),
      "node --import tsx --test --test-concurrency=1 test/b.test.ts",
      "node --test keeps its flags and swaps the listed files for the related ones",
    )
    assert.equal(narrowCommand(check("node --test"), ["test/b.test.ts"]), undefined, "node --test without a file list discovers tests itself")
    assert.equal(narrowCommand(check("jest && echo done"), ["a.test.js"]), undefined)
    assert.equal(narrowCommand(check("cargo test"), ["tests/a.rs"]), undefined)
    assert.equal(narrowCommand(check("pytest"), ["src/a.test.ts"]), undefined, "no tests for this runner")
    const npm = tmp()
    write(npm, { "package.json": JSON.stringify({ scripts: { test: "vitest run --reporter=dot" } }) })
    assert.equal(narrowCommand(check("npm test", npm), ["src/a.test.ts"]), "npm test -- src/a.test.ts")
    write(npm, { "package.json": JSON.stringify({ scripts: { test: "node --test test/a.test.ts" } }) })
    assert.equal(narrowCommand(check("npm test", npm), ["src/a.test.ts"]), undefined, "node --test lists its own files")
  })

  test("pytest commands that name paths keep only the related tests inside them", () => {
    const dir = tmp()
    write(dir, { "tests/test_a.py": "", "tests/test_slow.py": "", "scripts/run.py": "", "other/test_b.py": "", "pytest.log": "" })
    const narrow = (cmd: string) => narrowCommand(check(cmd, dir), ["tests/test_a.py", "other/test_b.py"])
    assert.equal(narrow("python -m pytest tests scripts -q -n 8"), "python -m pytest -q -n 8 tests/test_a.py")
    assert.equal(narrow("pytest -q tests"), "pytest -q tests/test_a.py", "flags are kept")
    assert.equal(narrow("pytest --ignore tests/slow tests"), "pytest --ignore tests/slow tests/test_a.py", "an option's path value is kept")
    assert.equal(narrow("pytest --deselect tests/test_a.py other"), "pytest --deselect tests/test_a.py other/test_b.py")
    assert.equal(
      narrow("pytest --log-file pytest.log tests"),
      "pytest --log-file pytest.log tests/test_a.py",
      "an option's value is never taken for a positional path",
    )
    assert.equal(narrow("pytest -q scripts"), undefined, "no related test lies inside the named paths")
    assert.equal(narrow("pytest -q"), "pytest -q tests/test_a.py other/test_b.py", "no named paths: append them all")
    assert.equal(narrow("pytest -k 'test_a' tests"), undefined, "quoted arguments cannot be split safely")
    assert.equal(narrow("cd backend && pytest"), undefined, "paths in a compound command belong to another directory")
    assert.equal(narrow("pytest | tee log"), undefined, "nothing is appended after a pipe to another command")
    assert.equal(narrow("pytest -q; pytest -q tests"), undefined)
  })

  test("a compound pytest check runs the full suite, and the plan says why", () => {
    const { root } = repo({
      "pyproject.toml": "[tool.pytest.ini_options]\n",
      "app.py": "value = 1\n",
      "tests/test_app.py": "from app import value\n",
    })
    const plan = (command: string) => {
      const c = check(command, root)
      return planRelated(root, ["app.py"], [c]).plans.get(c)!
    }
    assert.equal(plan("pytest").command, "pytest tests/test_app.py")
    for (const cmd of ["cd backend && pytest", "pytest | tee log"]) {
      const p = plan(cmd)
      assert.equal(p.command, undefined, cmd)
      assert.match(p.full ?? "", /cannot be narrowed/, cmd)
    }
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

  test("a matching tsconfig path and Vite object alias narrow the frontend and leave other runners alone", () => {
    const { root } = repo({
      "pyproject.toml": "[tool.pytest.ini_options]\n",
      "app.py": "value = 1\n",
      "tests/test_app.py": "from app import value\n",
      "frontend/tsconfig.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } } }',
      "frontend/vite.config.ts": 'import { resolve } from "node:path"\nexport default { resolve: { alias: { "@": resolve(__dirname, "src") } } }\n',
      "frontend/src/a.ts": "export const a = 1\n",
      "frontend/src/a.test.ts": 'import { a } from "@/a"\n',
    })
    const web = check("npx vitest run", path.join(root, "frontend"))
    const py = check("pytest", root)
    const plans = planRelated(root, ["app.py", "frontend/src/a.ts"], [web, py]).plans
    assert.equal(plans.get(web)?.command, "npx vitest run src/a.test.ts")
    assert.equal(plans.get(web)?.full, undefined)
    assert.equal(plans.get(py)?.command, "pytest tests/test_app.py")
    assert.equal(plans.get(py)?.full, undefined)
  })

  test("aliases the code map cannot resolve make only the JS check run the full suite, naming the file", () => {
    const cases = [
      [
        "vite.config.ts",
        {
          "tsconfig.json": '{ "compilerOptions": { "paths": { "@/*": ["src/*"] } } }\n',
          "vite.config.ts": 'export default { resolve: { alias: { "~": "/src" } } }\n',
        },
      ],
      ["vite.config.ts", { "vite.config.ts": 'export default { resolve: { alias: [{ find: "@", replacement: "/src" }] } }\n' }],
      ["tsconfig.app.json", { "tsconfig.app.json": '{ "compilerOptions": { "paths": { "@/*": ["src/*"] } } }\n' }],
      ["package.json", { "package.json": JSON.stringify({ imports: { "#a": "./src/a.js" } }) }],
    ] as const
    for (const [name, files] of cases) {
      const { root } = repo({ "src/a.js": "exports.a = 1\n", "src/a.test.js": "require('./a')\n", ...files })
      const web = check("npx vitest run", root)
      const plan = planRelated(root, ["src/a.js"], [web]).plans.get(web)!
      assert.equal(plan.command, undefined, name)
      assert.match(plan.full ?? "", new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), name)
    }
  })

  test("aliases never make a Go or Python check run the full suite", () => {
    const { root } = repo({
      "package.json": JSON.stringify({ imports: { "#a": "./src/a.js" } }),
      "pyproject.toml": "[tool.pytest.ini_options]\n",
      "app.py": "value = 1\n",
      "tests/test_app.py": "from app import value\n",
      "go.mod": "module example.com/m\n",
      "a.go": "package m\n",
      "a_test.go": "package m\n",
    })
    const py = check("pytest", root)
    const go = check("go test ./...", root)
    const plans = planRelated(root, ["app.py", "a.go"], [py, go]).plans
    assert.equal(plans.get(py)?.command, "pytest tests/test_app.py")
    assert.equal(plans.get(py)?.full, undefined)
    assert.equal(plans.get(go)?.command, "go test .")
    assert.equal(plans.get(go)?.full, undefined)
  })

  test("pytest and Go checks in subdirectory projects narrow to their own related tests", () => {
    const { root } = repo({
      "svc/pyproject.toml": "[tool.pytest.ini_options]\n",
      "svc/app.py": "value = 1\n",
      "svc/tests/test_app.py": "from app import value\n",
      "api/go.mod": "module example.com/api\n",
      "api/calc/calc.go": "package calc\n\nfunc Add(a, b int) int { return a + b }\n",
      "api/calc/calc_test.go": "package calc\n",
    })
    const py = check("pytest", path.join(root, "svc"))
    const go = check("go test ./...", path.join(root, "api"))
    const plans = planRelated(root, ["svc/app.py", "api/calc/calc.go"], [py, go]).plans
    assert.equal(plans.get(py)?.command, "pytest tests/test_app.py")
    assert.equal(plans.get(py)?.full, undefined)
    assert.equal(plans.get(go)?.command, "go test ./calc")
    assert.equal(plans.get(go)?.full, undefined)
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

  test("tool configs at the root and at a check's cwd are rules", async () => {
    const { root, base } = repo({
      "README.md": "# x\n",
      "horde.json": JSON.stringify({ verify: { checks: { test: { command: "node --test", cwd: "svc" } } } }),
    })
    write(root, {
      "tsconfig.json": '{"compilerOptions":{"strict":false}}\n',
      "tsconfig.build.json": '{"extends":"./tsconfig.json"}\n',
      "biome.json": '{"linter":{"enabled":false}}\n',
      "eslint.config.js": "export default []\n",
      "vite.config.ts": "export default {}\n",
      "playwright.config.ts": "export default {}\n",
      "ruff.toml": "line-length = 120\n",
      "mypy.ini": "[mypy]\nstrict = False\n",
      "conftest.py": "# hooks\n",
      "svc/tsconfig.json": '{"compilerOptions":{"strict":false}}\n',
      "other/tsconfig.json": '{"compilerOptions":{"strict":false}}\n',
    })
    const l = await lines(root, base, { ruleScripts: ["test", "typecheck", "lint"] })
    for (const f of [
      "tsconfig.json",
      "tsconfig.build.json",
      "biome.json",
      "eslint.config.js",
      "vite.config.ts",
      "playwright.config.ts",
      "ruff.toml",
      "mypy.ini",
      "conftest.py",
      "svc/tsconfig.json",
    ])
      assert.ok(
        l.some((x) => x.startsWith(`block tests ${f} `) && x.includes("changes the rules the gate checks with")),
        `${f} in ${l.join("\n")}`,
      )
    assert.ok(!l.some((x) => x.includes("other/tsconfig.json")), "a config outside the checks' cwd is not a rule")
  })

  test("vite.config is a rule only when the base has no vitest config in its directory", async () => {
    const withVitest = repo({
      "vite.config.ts": "export default {}\n",
      "vitest.config.ts": "export default {}\n",
    })
    write(withVitest.root, { "vite.config.ts": "export default { plugins: [] }\n" })
    const a = await lines(withVitest.root, withVitest.base, { ruleScripts: ["test"] })
    assert.ok(!a.some((x) => /changes the rules/.test(x) && x.includes("vite.config.ts")), a.join("\n"))

    const withoutVitest = repo({ "vite.config.ts": "export default {}\n" })
    write(withoutVitest.root, { "vite.config.ts": "export default { plugins: [] }\n" })
    const b = await lines(withoutVitest.root, withoutVitest.base, { ruleScripts: ["test"] })
    assert.ok(b.includes("block tests vite.config.ts changes the rules the gate checks with: vite.config.ts"), b.join("\n"))
  })

  test("ruff, mypy and coverage sections of pyproject.toml are rules; a dependency-only change is not", async () => {
    const { root, base } = repo({
      "pyproject.toml":
        "[project]\nname = 'x'\ndependencies = [\n  'a',\n]\n\n[tool.ruff]\nline-length = 100\n\n[tool.mypy]\nstrict = true\n\n[tool.coverage.run]\nbranch = true\n",
    })
    write(root, {
      "pyproject.toml":
        "[project]\nname = 'x'\ndependencies = [\n  'a',\n  'b',\n]\n\n[tool.ruff]\nline-length = 120\n\n[tool.mypy]\nstrict = false\n\n[tool.coverage.run]\nbranch = false\n",
    })
    const l = await lines(root, base)
    assert.ok(
      l.includes("block tests pyproject.toml changes the rules the gate checks with: pyproject.toml [tool.ruff], [tool.mypy], [tool.coverage]"),
      l.join("\n"),
    )
    assert.ok(
      l.some((x) => /dependencies pyproject\.toml adds or changes 'b'/.test(x)),
      l.join("\n"),
    )

    const onlyDeps = repo({
      "pyproject.toml": "[project]\nname = 'x'\ndependencies = [\n  'a',\n]\n\n[tool.ruff]\nline-length = 100\n",
    })
    write(onlyDeps.root, {
      "pyproject.toml": "[project]\nname = 'x'\ndependencies = [\n  'a',\n  'b',\n]\n\n[tool.ruff]\nline-length = 100\n",
    })
    const d = await lines(onlyDeps.root, onlyDeps.base)
    assert.ok(!d.some((x) => /changes the rules/.test(x)), d.join("\n"))
    assert.ok(
      d.some((x) => /adds or changes 'b'/.test(x)),
      d.join("\n"),
    )
  })

  test("scripts reachable from a checked script, and their pre/post hooks, are rules", async () => {
    const { root, base } = repo({
      "package.json": JSON.stringify({ scripts: { test: "npm run unit", unit: "node --test", other: "tsc" } }),
    })
    write(root, {
      "package.json": JSON.stringify({
        scripts: { test: "npm run unit", pretest: "echo pre", preunit: "echo preunit", unit: "node --test --test-only", other: "true" },
      }),
    })
    const l = await lines(root, base, { ruleScripts: ["test"] })
    const line = l.find((x) => /package\.json changes the rules/.test(x))
    assert.ok(line, l.join("\n"))
    const changed = line!.split("scripts ")[1]!.split(", ")
    assert.deepEqual(new Set(changed), new Set(["unit", "pretest", "preunit"]))
  })

  test("an unrelated package.json script is not a rule change", async () => {
    const { root, base } = repo({
      "package.json": JSON.stringify({ scripts: { test: "npm run unit", unit: "node --test", other: "tsc" } }),
    })
    write(root, {
      "package.json": JSON.stringify({ scripts: { test: "npm run unit", unit: "node --test", other: "tsc --watch" } }),
    })
    const l = await lines(root, base, { ruleScripts: ["test"] })
    assert.ok(!l.some((x) => /changes the rules/.test(x)), l.join("\n"))
  })

  test("an ordinary pyproject.toml or Cargo.toml edit is not a rule or dependency change", async () => {
    const { root, base } = repo({
      "pyproject.toml": "[project]\nname = 'x'\nversion = '0.1.0'\n\n[tool.pytest.ini_options]\naddopts = '-q'\n",
      "Cargo.toml": "[package]\nname = 'x'\nversion = '0.1.0'\n\n[dependencies]\nserde = '1'\n",
    })
    write(root, {
      "pyproject.toml":
        "[project]\nname = 'x'\nversion = '0.1.1'\ndependencies = [\n  'requests',\n]\n\n[project.optional-dependencies]\ndev = [\n  'ruff',\n]\n\n[tool.pytest.ini_options]\naddopts = '-q'\n",
      "Cargo.toml": "[package]\nname = 'x'\nversion = '0.1.1'\n\n[dependencies]\nserde = '1'\nanyhow = '1'\n",
    })
    const l = await lines(root, base)
    assert.ok(!l.some((x) => /changes the rules/.test(x)), l.join("\n"))
    const added = l.filter((x) => / dependencies /.test(x)).join("\n")
    assert.match(added, /pyproject\.toml adds or changes 'requests'; 'ruff'/, added)
    assert.match(added, /Cargo\.toml adds or changes anyhow = '1'/, added)
    assert.doesNotMatch(added, /version/, "a version bump is not a dependency")
  })

  test("a horde.json added after base cannot choose the gate's rules", async () => {
    const { root, base } = repo({ "README.md": "# x\n" })
    write(root, {
      "horde.json": JSON.stringify({ verify: { checks: { fake: 'node -e "process.exit(0)"' }, audit: { off: ["secrets"], generated: ["**"] } } }),
    })
    const s = await loadSettingsAt(root, base)
    assert.equal(s.configFile, undefined)
    assert.equal(s.checks, undefined)
    assert.deepEqual(s.audit.block, ["scope", "tests", "secrets", "binaries"])
    // The work cannot declare its own files generated either.
    assert.deepEqual(s.audit.generated, [])
    assert.deepEqual(loadSettings(root).audit.generated, ["**"])
    write(root, { "horde.json": JSON.stringify({ verify: { audit: { generated: "dist/**" } } }) })
    assert.throws(() => loadSettings(root), /verify\.audit\.generated must be a list of globs/)
  })

  test("a shared gate can use the working config when the caller says so", async () => {
    const { root, base } = repo({ "README.md": "# x\n" })
    write(root, { "horde.json": JSON.stringify({ verify: { checks: { ok: 'node -e "process.exit(0)"' } } }) })
    const v = await gate(root, { base, audit: false, settingsFrom: "working", stateDir: tmp() })
    assert.equal(v.pass, true)
    assert.equal(v.checks[0]?.name, "ok")
  })

  test("a worktree gate reads the rules from the commit the work will land on", async () => {
    const { root, base } = repo({ "horde.json": JSON.stringify({ verify: { checks: { ok: 'node -e "process.exit(0)"' } } }) })
    write(root, {
      "horde.json": JSON.stringify({ verify: { checks: { ok: 'node -e "process.exit(0)"' }, audit: { warn: ["binaries"] } } }),
    })
    git(root, "add", "horde.json")
    git(root, "commit", "-qm", "warn binaries")
    const rulesAt = git(root, "rev-parse", "HEAD")
    // The task started at base and does not have the commit made on the target branch since.
    const wt = path.join(tmp(), "wt")
    git(root, "worktree", "add", "-q", "-b", "task", wt, base)
    write(wt, { "logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]) })
    const blocked = await gate(wt, { base, stateDir: tmp() })
    assert.equal(blocked.pass, false, blocked.text)
    assert.ok(
      blocked.blockers.some((b) => /binaries/.test(b)),
      blocked.text,
    )
    const warned = await gate(wt, { base, rulesAt, stateDir: tmp() })
    assert.equal(warned.pass, true, warned.text)
    assert.ok(
      warned.warnings.some((w) => /binaries/.test(w)),
      warned.text,
    )
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

  test("module-level pytest skips and collect_ignore are flagged", async () => {
    const { root, base } = repo({
      "tests/test_a.py": "def test_a():\n    assert True\n",
      "conftest.py": "x = 1\n",
    })
    write(root, {
      "tests/test_a.py": `${[
        "def test_a():",
        "    assert True",
        "pytest" + 'mark = pytest.mark.skip(reason="x")',
        "pytest.importor" + 'skip("x")',
        "pytest" + "mark = [pytest.mark.xfail]",
      ].join("\n")}\n`,
      "conftest.py": `${["collect_" + 'ignore = ["test_b.py"]', "collect_" + 'ignore_glob = ["test_*.py"]'].join("\n")}\n`,
    })
    const l = await lines(root, base)
    for (const expected of [
      "block tests tests/test_a.py:3 skips a test",
      "block tests tests/test_a.py:4 skips a test",
      "block tests tests/test_a.py:5 skips a test",
      "block tests conftest.py:1 skips a test",
      "block tests conftest.py:2 skips a test",
    ])
      assert.ok(l.includes(expected), l.join("\n"))
  })

  test("removing a test case blocks, renaming one does not", async () => {
    const { root, base } = repo({
      "test/a.test.js": "it('one', () => {})\nit('two', () => {})\n",
      "test/rename.test.js": "it('old', () => {})\n",
    })
    write(root, {
      "test/a.test.js": "it('one', () => {})\n",
      "test/rename.test.js": "it('new', () => {})\n",
    })
    const l = await lines(root, base)
    assert.ok(l.includes("block tests test/a.test.js removes 1 test"), l.join("\n"))
    assert.ok(!l.some((x) => /^block tests test\/rename\.test\.js removes/.test(x)), l.join("\n"))
  })

  test("Django tests.py is a test file: skips and deletions are flagged", async () => {
    const { root, base } = repo({
      "shop/tests.py": "def test_a():\n    pass\n",
      "blog/tests.py": "def test_b():\n    pass\n",
    })
    write(root, { "shop/tests.py": "@unittest." + 'skip("x")\ndef test_a():\n    pass\n' })
    fs.rmSync(path.join(root, "blog/tests.py"))
    const l = await lines(root, base)
    assert.ok(l.includes("block tests shop/tests.py:1 skips a test"), l.join("\n"))
    assert.ok(l.includes("block tests blog/tests.py deletes a test file"), l.join("\n"))
  })

  test("Rust inline tests: an ignored test and a removed test fn are flagged", async () => {
    const { root, base } = repo({
      "src/lib.rs": "#[cfg(test)]\nmod tests {\n    #[test]\n    fn one() {}\n    #[test]\n    fn two() {}\n}\n",
    })
    // Split so this fixture does not read as an ignore marker in the audit of this file.
    const ignore = "#" + "[ignore]"
    write(root, { "src/lib.rs": `#[cfg(test)]\nmod tests {\n    #[test]\n    ${ignore}\n    fn one() {}\n}\n` })
    const l = await lines(root, base)
    assert.ok(l.includes("block tests src/lib.rs:4 ignores a test"), l.join("\n"))
    assert.ok(l.includes("block tests src/lib.rs removes 1 test"), l.join("\n"))
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

  test("a secret committed and then removed is still reported", async () => {
    const { root, base } = repo({ "a.txt": "x\n" })
    write(root, { "a.txt": 'x\nkey = "sk-AbCdEfGhIjKlMnOpQrStUv12"\n' })
    git(root, "add", "-A")
    git(root, "commit", "-qm", "add a key")
    write(root, { "a.txt": "x\n" })
    git(root, "add", "-A")
    git(root, "commit", "-qm", "oops, remove it")
    const l = await lines(root, base)
    assert.ok(
      l.some((x) => /^block secrets a\.txt:2 adds what looks like .+ in commit [0-9a-f]+$/.test(x)),
      l.join("\n"),
    )
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
    write(root, {
      "svc/pyproject.toml": "[tool.pytest.ini_options]\n",
      "svc/tests/test_app.py": "def test_a(): pass\n",
      "plain/tests/test_app.py": "def test_b(): pass\n",
    })
    assert.equal(plan(["svc/tests/test_app.py"], test("pytest", path.join(root, "svc"))).command, "pytest tests/test_app.py")
    assert.equal(
      plan(["plain/tests/test_app.py"], test("pytest", path.join(root, "plain"))).full,
      "its directory is not a Python project root",
      "a check outside a Python project root still runs everything",
    )
    write(root, { "tsconfig.app.json": '{ "compilerOptions": { "paths": { "@/*": ["src/*"] } } }' })
    assert.match(plan(["src/a.js"]).full ?? "", /import aliases in tsconfig\.app\.json/)
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

describe("checks that need the task, a stage or a slot", () => {
  test("horde.json takes env, when, slots and exclusive per check, and rejects bad ones", () => {
    const { root } = repo({ "README.md": "# x\n" })
    const checks = {
      unit: { command: "go test ./...", env: { AUTH_PROVIDER: "local" }, slots: 2 },
      pg: { command: "pytest -q", when: "land", exclusive: "dev-stack" },
      plain: "echo ok",
    }
    write(root, { "horde.json": JSON.stringify({ verify: { checks } }) })
    const s = loadSettings(root)
    assert.deepEqual(
      s.checks!.map(({ name, env, when, slots, exclusive }) => ({ name, env, when, slots, exclusive })),
      [
        { name: "unit", env: { AUTH_PROVIDER: "local" }, when: undefined, slots: 2, exclusive: undefined },
        { name: "pg", env: undefined, when: "land", slots: undefined, exclusive: "dev-stack" },
        { name: "plain", env: undefined, when: undefined, slots: undefined, exclusive: undefined },
      ],
    )
    for (const [bad, re] of [
      [{ command: "x", env: { A: 1 } }, /env must be an object of name → string/],
      [{ command: "x", when: "later" }, /when must be "land" or "always"/],
      [{ command: "x", slots: 0 }, /slots must be a positive integer/],
      [{ command: "x", exclusive: "a b" }, /exclusive must be a name/],
    ] as const) {
      write(root, { "horde.json": JSON.stringify({ verify: { checks: { bad } } }) })
      assert.throws(() => loadSettings(root), re)
    }
  })

  test("a task's rounds skip land-only checks, the landing gate runs them, and both see the task", async () => {
    // HORDE_ variables inherited from the server are stripped from checks; the ones the gate passes are not.
    const sees = "node -e \"process.exit(process.env.HORDE_TASK === 't-1' && process.env.HORDE_WORKTREE ? 0 : 1)\""
    const { root } = repo({ "horde.json": JSON.stringify({ verify: { checks: { quick: sees, slow: { command: sees, when: "land" } } } }) })
    const env = { HORDE_TASK: "t-1", HORDE_WORKTREE: root }
    const work = await gate(root, { stage: "work", env, stateDir: tmp() })
    assert.equal(work.pass, true, work.text)
    assert.deepEqual(
      work.checks.map((c) => [c.name, c.related?.skipped]),
      [
        ["quick", undefined],
        ["slow", "runs before landing (when: land)"],
      ],
    )
    const land = await gate(root, { stage: "land", env, stateDir: tmp(), fresh: true })
    assert.equal(land.pass, true, land.text)
    assert.ok(land.checks.every((c) => !c.related?.skipped))
    const without = await gate(root, { stage: "land", stateDir: tmp(), fresh: true })
    assert.equal(without.pass, false, "without the task's variables the check fails, so they really arrive")
  })

  test("an exclusive resource serializes runs across callers; two slots let two overlap", async () => {
    const dir = tmp()
    const log = path.join(dir, "log.txt")
    // Each run logs its start and end around a 400 ms pause.
    const step = (id: string) =>
      `node -e "const f=require('fs');f.appendFileSync(process.argv[1],'start ${id}\\n');setTimeout(()=>f.appendFileSync(process.argv[1],'end ${id}\\n'),400)" ${JSON.stringify(log)}`
    const run = (id: string, extra: Partial<Check>) =>
      runChecks([{ name: "suite", command: step(id), kind: "test", cwd: dir, source: "test", ...extra }], {
        timeoutMs: 30_000,
        lockDir: path.join(dir, "locks"),
      })
    const order = () =>
      fs
        .readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((l) => l.split(" ")[0])
    await Promise.all([run("a", { exclusive: "stack" }), run("b", { exclusive: "stack" })])
    assert.deepEqual(order(), ["start", "end", "start", "end"], "one at a time")
    fs.rmSync(log)
    await Promise.all([run("a", { slots: 2 }), run("b", { slots: 2 })])
    assert.deepEqual(order(), ["start", "start", "end", "end"], "both at once")
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
        const res = (await client.callTool({ name, arguments: args }, { timeout: 120_000 })) as { content: { text: string }[]; isError?: boolean }
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

  // Moving to SDK v2 once left the handlers on v1's context fields: tsc said nothing, progress went
  // quiet and a cancelled gate's check ran on. This holds both ends.
  test("a gate sends progress, and cancelling it stops the check", async () => {
    const late = "node -e \"setTimeout(() => require('fs').writeFileSync('late.txt', 'x'), 3000)\""
    const { root } = repo({ "horde.json": JSON.stringify({ verify: { checks: { test: late } } }) })
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
      const seen: string[] = []
      const ac = new AbortController()
      setTimeout(() => ac.abort(), 1500)
      await client
        .callTool({ name: "verify_gate", arguments: { fresh: true } }, { onprogress: (p) => seen.push(String(p.message)), signal: ac.signal, timeout: 60_000 })
        .catch(() => undefined)
      assert.ok(
        seen.some((m) => m.includes("test")),
        `progress: ${JSON.stringify(seen)}`,
      )
      await new Promise((r) => setTimeout(r, 2500))
      assert.equal(fs.existsSync(path.join(root, "late.txt")), false, "the cancelled check kept running")
    } finally {
      await client.close()
    }
  })
})

describe("horde.json settings", () => {
  const settings = (data: unknown) => {
    const root = tmp()
    fs.writeFileSync(path.join(root, "horde.json"), JSON.stringify(data))
    return loadSettings(root)
  }

  test("unknown keys are rejected at every level, with a hint", () => {
    assert.throws(
      () => settings({ verify: { check: { test: "npm test" } } }),
      (err: Error) => /unknown key "verify\.check"/.test(err.message) && /did you mean "checks"/.test(err.message),
    )
    assert.throws(
      () => settings({ verify: { checks: { pg: { command: "pytest", wehn: "land", slot: 2 } } } }),
      (err: Error) => /unknown key "verify\.checks\.pg\.wehn"/.test(err.message) && /did you mean "when"/.test(err.message),
    )
    assert.throws(
      () => settings({ workers: { setpu: "npm ci" } }),
      (err: Error) => /unknown key "workers\.setpu"/.test(err.message) && /did you mean "setup"/.test(err.message),
    )
    assert.throws(() => settings({ verify: { audit: { blcok: ["scope"] } } }), /unknown key "verify\.audit\.blcok".*"block"/)
    assert.throws(() => settings({ verify: { timeoutSecond: 60 } }), /unknown key "verify\.timeoutSecond".*"timeoutSeconds"/)
    assert.throws(() => settings({ verfy: {} }), /unknown key "verfy".*"verify"/)
  })

  test("env variable names are arbitrary, not unknown keys", () => {
    const loaded = settings({
      verify: { checks: { test: { command: "npm test", env: { AUTH_PROVIDER: "local", ANY_OTHER_NAME: "x" } } } },
    })
    assert.deepEqual(loaded.checks?.[0]?.env, { AUTH_PROVIDER: "local", ANY_OTHER_NAME: "x" })
  })

  test("the base commit's horde.json is validated too", async () => {
    const { root, base } = repo({ "horde.json": JSON.stringify({ verify: { check: { test: "npm test" } } }) })
    await assert.rejects(
      loadSettingsAt(root, base),
      (err: Error) => /unknown key "verify\.check"/.test(err.message) && /did you mean "checks"/.test(err.message),
    )
  })

  test("this repository's horde.json and the documented examples load", () => {
    assert.doesNotThrow(() => loadSettings(path.resolve(import.meta.dirname, "../../..")))
    // plugins/horde/skills/setup/SKILL.md
    assert.doesNotThrow(() =>
      settings({
        tiers: ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"],
        workers: { setup: "buf generate && npm ci --prefix web", brief: ["docs/lane_brief.md"] },
        verify: {
          checks: {
            go: { command: "go test -race ./...", cwd: "api", env: { AUTH_PROVIDER: "local" }, slots: 2 },
            web: { command: "npm test", cwd: "web" },
            pg: { command: "uv run pytest -n 8 tests/pg", when: "land", exclusive: "dev-stack" },
          },
        },
      }),
    )
    // docs/DESIGN.md §5
    assert.doesNotThrow(() =>
      settings({
        opencode: { maxRunning: 8 },
        tiers: [{ model: "deepseek/deepseek-v4-flash", variant: "high" }, "moonshot/kimi-k3"],
        verify: {
          checks: {
            test: "npm test",
            lint: "npm run lint",
            pg: { command: "uv run pytest tests/pg", cwd: "api", env: { AUTH_PROVIDER: "local" }, when: "land", slots: 2, exclusive: "dev-stack" },
          },
          timeoutSeconds: 600,
          audit: { block: ["scope", "tests", "secrets", "binaries"], warn: ["suppressions", "dependencies"] },
        },
        context: { ignore: ["fixtures/**"], entrypoints: ["src/index.ts"] },
        workers: { setup: "uv sync --frozen", brief: ["docs/lane_brief.md"] },
      }),
    )
  })

  test("verify_detect shows when, slots, exclusive and env names (never values)", async () => {
    const root = tmp()
    fs.writeFileSync(
      path.join(root, "horde.json"),
      JSON.stringify({
        verify: {
          checks: {
            pg: {
              command: "pytest tests/pg",
              kind: "test",
              when: "land",
              slots: 2,
              exclusive: "dev-stack",
              env: { AUTH_PROVIDER: "local", DB_PASSWORD: "s3cret" },
            },
            plain: "echo hi",
          },
        },
      }),
    )
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
      const res = (await client.callTool({ name: "verify_detect", arguments: {} }, { timeout: 120_000 })) as {
        content: { text: string }[]
        isError?: boolean
      }
      const text = res.content.map((c) => c.text).join("\n")
      assert.ok(!res.isError, text)
      assert.match(text, /pg \(test\): pytest tests\/pg {2}\[when=land, slots=2, exclusive=dev-stack, env=AUTH_PROVIDER,DB_PASSWORD\] {2}← horde\.json/)
      assert.match(text, /plain \(other\): echo hi {2}← horde\.json/, "no options bracket when none are set")
      assert.doesNotMatch(text, /s3cret/, "env values are never printed")
    } finally {
      await client.close()
    }
  })
})
