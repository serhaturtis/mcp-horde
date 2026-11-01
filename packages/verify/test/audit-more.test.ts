import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { type AuditCategory, type AuditOptions, audit } from "../src/lib.js"

const temps: string[] = []
after(() => {
  for (const t of temps) fs.rmSync(t, { recursive: true, force: true })
})

function tmp() {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "horde-verify-audit-")))
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

const lines = async (root: string, base: string, extra: Partial<AuditOptions> = {}) =>
  (
    await audit(root, {
      base,
      block: ["tests", "secrets", "binaries"] as AuditCategory[],
      warn: ["dependencies", "git"] as AuditCategory[],
      ...extra,
    })
  ).findings.map((f) => `${f.severity} ${f.category} ${f.file ?? ""}${f.line ? `:${f.line}` : ""} ${f.text}`)

test("python's bare assert is counted, and comments neither pad nor hide test counts", async () => {
  const py = repo({ "tests/test_app.py": "def test_add():\n    assert add(1, 2) == 3\n    assert add(2, 2) == 4\n" })
  write(py.root, { "tests/test_app.py": "def test_add():\n    pass\n" })
  let l = await lines(py.root, py.base)
  assert.ok(l.includes("block tests tests/test_app.py removes all 2 assertions"), l.join("\n"))

  // A kept assertion plus commented-out ones: the comments are not padding.
  const kept = repo({ "tests/test_app.py": "def test_a():\n    assert a() == 1\n    assert b() == 2\n" })
  write(kept.root, { "tests/test_app.py": "def test_a():\n    assert a() == 1\n    # assert b() == 2\n" })
  l = await lines(kept.root, kept.base)
  assert.ok(l.includes("warn tests tests/test_app.py removes 1 assertion"), l.join("\n"))

  // Commented-out expect() calls do not hide the removal of the real ones.
  const js = repo({ "test/a.test.js": "test('a', () => { expect(1).toBe(1); expect(2).toBe(2); expect(3).toBe(3) })\n" })
  write(js.root, {
    "test/a.test.js": "test('a', () => { /* nothing is checked */ })\n// expect(1).toBe(1); expect(2).toBe(2); expect(3).toBe(3)\n",
  })
  l = await lines(js.root, js.base)
  assert.ok(l.includes("block tests test/a.test.js removes all 3 assertions"), l.join("\n"))

  // A removed test definition hidden behind a comment is still removed.
  const defs = repo({ "test/a.test.js": "test('a', () => {})\ntest('b', () => {})\n" })
  write(defs.root, { "test/a.test.js": "test('a', () => {})\n// test('b', () => {})\n" })
  l = await lines(defs.root, defs.base, { block: ["tests"], warn: [] })
  assert.ok(l.includes("block tests test/a.test.js removes 1 test"), l.join("\n"))

  // A comment marker inside a string is not a comment: the assertion after it still counts.
  const quoted = repo({ "test/a.test.js": "test('a', () => { expect(a).toBe(1) })\n" })
  write(quoted.root, { "test/a.test.js": "test('a', () => { const s = \"//\"; expect(a).toBe(1) })\n" })
  l = await lines(quoted.root, quoted.base, { block: ["tests"], warn: [] })
  assert.ok(!l.some((x) => /assertion/.test(x)), l.join("\n"))

  // A commented-out skip marker is not a skip either.
  const skip = repo({ "test/a.test.js": "test('a', () => {})\n" })
  write(skip.root, { "test/a.test.js": "test('a', () => {})\n// test.skip('a', () => {})\n" })
  l = await lines(skip.root, skip.base, { block: ["tests"], warn: [] })
  assert.ok(!l.some((x) => x.includes("skips a test")), l.join("\n"))
})

test("unchanged hidden files are quiet, sparse checkouts pass, and a changed hidden file is reported", async () => {
  const { root, base } = repo({ "a/x.ts": "export const x = 1\n", "b/y.ts": "export const y = 1\n" })
  git(root, "update-index", "--assume-unchanged", "a/x.ts")
  let l = await lines(root, base, { block: ["tests"], warn: [] })
  assert.ok(!l.some((x) => x.includes("hidden from git")), l.join("\n"))

  git(root, "sparse-checkout", "set", "a")
  l = await lines(root, base, { block: ["tests"], warn: [] })
  assert.ok(!l.some((x) => x.includes("hidden from git")), l.join("\n"))

  write(root, { "a/x.ts": "export const x = 2\n" })
  l = await lines(root, base, { block: ["tests"], warn: [] })
  assert.ok(l.includes("block tests a/x.ts is hidden from git (assume-unchanged); the audit cannot see its content"), l.join("\n"))
})

test("the script guard sees quoting, sh -c, cd, make -C/-f, test-directory scripts and three levels", async () => {
  const guard = async (command: string, changed: Record<string, string>) => {
    const { root, base } = repo({
      "ci.sh": "sh scripts/all.sh\n",
      "scripts/all.sh": "sh scripts/unit.sh\n",
      "scripts/unit.sh": "true\n",
      "sub/run.sh": "true\n",
      "sub/Makefile": "test:\n\ttrue\n",
      "custom.mk": "test:\n\ttrue\n",
      "test/run.mjs": "console.log(1)\n",
    })
    write(root, changed)
    return lines(root, base, { block: ["tests"], warn: [], checks: [{ command, cwd: root }] })
  }
  const cases: [string, string, Record<string, string>][] = [
    ["quoted direct", '"./ci.sh"', { "ci.sh": "true\n" }],
    ["sh -c", 'sh -c "bash ci.sh"', { "ci.sh": "true\n" }],
    ["cd", "cd sub && sh run.sh", { "sub/run.sh": "exit 0\n" }],
    ["make -C", "make -C sub test", { "sub/Makefile": "test:\n\tfalse\n" }],
    ["make -f", "make -f custom.mk test", { "custom.mk": "test:\n\tfalse\n" }],
    ["test-directory script", "node test/run.mjs", { "test/run.mjs": "console.log(2)\n" }],
    ["two levels down", "sh ci.sh", { "scripts/unit.sh": "false\n" }],
  ]
  for (const [name, command, changed] of cases) {
    const l = await guard(command, changed)
    assert.ok(
      l.some((x) => /changes the rules/.test(x)),
      `${name}: ${l.join("\n")}`,
    )
  }
})

test("fixtures and READMEs under a test directory are not deleted tests or test counts", async () => {
  const { root, base } = repo({
    "test/fixtures/data.json": "{}\n",
    "test/README.md": "# fixture notes\n",
    "test/fixtures/data.js": "it('one', () => {})\nit('two', () => {})\n",
    "test/a.test.js": "test('a', () => {})\n",
  })
  fs.rmSync(path.join(root, "test/fixtures/data.json"))
  fs.rmSync(path.join(root, "test/README.md"))
  write(root, { "test/fixtures/data.js": "it('one', () => {})\n" })
  fs.rmSync(path.join(root, "test/a.test.js"))
  const l = await lines(root, base, { block: ["tests"], warn: [] })
  assert.ok(!l.some((x) => x.includes("test/fixtures/data.json deletes a test file")), l.join("\n"))
  assert.ok(!l.some((x) => x.includes("test/README.md deletes a test file")), l.join("\n"))
  assert.ok(!l.some((x) => x.includes("test/fixtures/data.js removes 1 test")), l.join("\n"))
  assert.ok(l.includes("block tests test/a.test.js deletes a test file"), l.join("\n"))
})

test("a snapshot outside a test directory is still audited as a snapshot", async () => {
  const snap = (n: number) => `${Array.from({ length: n }, (_, i) => `line ${i}`).join("\n")}\n`
  const { root, base } = repo({ "src/__snapshots__/a.snap": snap(30) })
  write(root, { "src/__snapshots__/a.snap": snap(2) })
  const l = await lines(root, base, { block: ["tests"], warn: [] })
  assert.ok(l.includes("block tests src/__snapshots__/a.snap rewrites a snapshot (28 of 30 lines removed, more than half)"), l.join("\n"))
})

test("staged content that differs from the working tree is a warning", async () => {
  const original = "test('a', () => { expect(1).toBe(1) })\n"
  const weakened = "test('a', () => {})\n"
  const { root, base } = repo({ "test/a.test.js": original })
  write(root, { "test/a.test.js": weakened })
  git(root, "add", "test/a.test.js")
  write(root, { "test/a.test.js": original })
  const l = await lines(root, base, { block: ["tests"], warn: ["git"] })
  assert.ok(
    l.some((x) => /^warn git test\/a\.test\.js has staged content that differs from the working tree/.test(x)),
    l.join("\n"),
  )
  assert.ok(!l.some((x) => /assertion/.test(x)), "the working tree still has the assertion")
})

test("a file hidden only by .git/info/exclude is audited; global excludes still hide", async () => {
  const key = `AKIA${"A".repeat(16)}`
  const { root, base } = repo({ "README.md": "# x\n", ".gitignore": "local.env\n" })
  write(root, { "secret.env": `key = "${key}"\n`, "local.env": "x\n" })
  fs.appendFileSync(path.join(root, ".git/info/exclude"), "secret.env\n")
  const globalIgnore = path.join(root, ".git", "global-ignore")
  fs.writeFileSync(globalIgnore, "global.env\n")
  git(root, "config", "core.excludesFile", globalIgnore)
  write(root, { "global.env": `key = "${key}"\n` })
  const l = await lines(root, base, { block: ["tests", "secrets", "binaries"], warn: [] })
  assert.ok(l.includes("block secrets secret.env:1 adds what looks like an AWS access key"), l.join("\n"))
  assert.ok(!l.some((x) => x.includes("global.env")), l.join("\n"))
})

test("two removed keys of one kind in the same file are both reported", async () => {
  const key = (c: string) => `AKIA${c.repeat(16)}`
  const { root, base } = repo({ "a.txt": "x\n" })
  write(root, { "a.txt": `x\nkey = "${key("A")}"\n` })
  git(root, "add", "-A")
  git(root, "commit", "-qm", "add the first key")
  write(root, { "a.txt": `x\nkey = "${key("B")}"\n` })
  git(root, "add", "-A")
  git(root, "commit", "-qm", "replace it with a second key")
  write(root, { "a.txt": `x\nkey = "${key("C")}"\n` })
  const l = await lines(root, base, { block: ["secrets"], warn: [] })
  const secrets = l.filter((x) => x.startsWith("block secrets a.txt"))
  assert.equal(secrets.length, 3, l.join("\n"))
  assert.equal(secrets.filter((x) => x.includes(" in commit ")).length, 2, l.join("\n"))
})

test("runner configs are rules at the root or next to a manifest, not in examples", async () => {
  const { root, base } = repo({
    "package.json": "{}\n",
    "jest.config.js": "module.exports = {}\n",
    "docs/examples/jest.config.js": "module.exports = {}\n",
    "svc/package.json": "{}\n",
    "svc/vitest.config.ts": "export default {}\n",
    "other/pytest.ini": "[pytest]\n",
  })
  write(root, {
    "jest.config.js": "module.exports = { testMatch: [] }\n",
    "docs/examples/jest.config.js": "module.exports = { testMatch: [] }\n",
    "svc/vitest.config.ts": "export default { test: {} }\n",
    "other/pytest.ini": "[pytest]\naddopts = -q\n",
  })
  const l = await lines(root, base, { block: ["tests"], warn: [] })
  assert.ok(l.includes("block tests jest.config.js changes the rules the gate checks with: jest.config.js"), l.join("\n"))
  assert.ok(l.includes("block tests svc/vitest.config.ts changes the rules the gate checks with: vitest.config.ts"), l.join("\n"))
  assert.ok(!l.some((x) => x.includes("docs/examples/jest.config.js")), l.join("\n"))
  assert.ok(!l.some((x) => x.includes("other/pytest.ini")), l.join("\n"))
})

test("bun.lockb is a lockfile, not a binary", async () => {
  const { root, base } = repo({ "README.md": "# x\n" })
  write(root, { "bun.lockb": Buffer.from([0, 1, 2, 3, 0, 255]) })
  const l = await lines(root, base, { block: ["binaries"], warn: ["dependencies"] })
  assert.ok(!l.some((x) => x.startsWith("block binaries bun.lockb")), l.join("\n"))
  assert.ok(l.includes("warn dependencies bun.lockb updates a lockfile"), l.join("\n"))
})

test("a renamed package.json keeps its old dependencies", async () => {
  const { root, base } = repo({
    "package.json": `${JSON.stringify({ dependencies: { a: "^1.0.0" } }, null, 2)}\n`,
  })
  fs.mkdirSync(path.join(root, "apps", "a"), { recursive: true })
  git(root, "mv", "package.json", "apps/a/package.json")
  git(root, "commit", "-qm", "move the manifest")
  const l = await lines(root, base, { block: [], warn: ["dependencies"] })
  assert.ok(!l.some((x) => /dependencies apps\/a\/package\.json adds/.test(x)), l.join("\n"))
})
