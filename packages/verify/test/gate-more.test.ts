import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, test } from "node:test"
import { type Check, checkScripts, detectChecks, gate, loadSettingsAt, narrowCommand, planRelated, render } from "../src/lib.js"

const temps: string[] = []
after(() => {
  for (const t of temps) fs.rmSync(t, { recursive: true, force: true })
})

function tmp() {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "horde-gate-more-")))
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

/** A checkout of `commit` as a detached worktree, the way a caller supplies a baseline. */
const checkoutOf = (root: string, commit: string) => async () => {
  const dir = path.join(tmp(), "checkout")
  git(root, "worktree", "add", "--detach", "-q", dir, commit)
  return {
    root: dir,
    release: async () => {
      git(root, "worktree", "remove", "--force", dir)
    },
  }
}

const tapFailure = (name = "adds", file = "test/a.test.mjs") =>
  [
    'console.log("TAP version 13")',
    `console.log("not ok 1 - ${name}")`,
    'console.log("  ---")',
    `console.log("  location: '${file}:1:1'")`,
    "console.log(\"  error: 'boom'\")",
    'console.log("  ...")',
    'console.log("1..1")',
    "process.exitCode = 1",
  ].join("\n")

const check = (command: string, cwd = "/p"): Check => ({ name: "test", command, kind: "test", cwd, source: "test" })

describe("baseline keys", () => {
  test("a new diagnostic error in an already-failing file is not the same failure", async () => {
    const diagnostic = (message: string) => `console.log("src/a.ts(1,1): error TS2322: ${message}")\nprocess.exitCode = 1\n`
    const { root, base } = repo({
      "horde.json": JSON.stringify({ verify: { checks: { typecheck: "node check.mjs" } } }),
      "check.mjs": diagnostic("Type 'string' is not assignable to type 'number'."),
    })
    // The same code (TS2322) in the same file, a different error: the base's failure does not excuse it.
    write(root, { "check.mjs": diagnostic("Type 'boolean' is not assignable to type 'number'.") })
    const v = await gate(root, {
      base,
      baseline: { commit: base, label: "master's tip", checkout: checkoutOf(root, base) },
      stateDir: tmp(),
    })
    assert.equal(v.pass, false, v.text)
    assert.match(v.text, /✗ typecheck · 1 failed/)
    assert.doesNotMatch(v.text, /fails at master's tip/)
    assert.deepEqual(v.checks[0]!.baseline, { label: "master's tip", pass: false, known: 0 })

    // A named test that fails identically at the base is still rescued.
    const named = repo({
      "horde.json": JSON.stringify({ verify: { checks: { test: "node check.mjs" } } }),
      "check.mjs": tapFailure(),
    })
    const rescued = await gate(named.root, {
      base: named.base,
      baseline: { commit: named.base, label: "master's tip", checkout: checkoutOf(named.root, named.base) },
      stateDir: tmp(),
    })
    assert.equal(rescued.pass, true, rescued.text)
    assert.match(rescued.text, /! test · fails at master's tip too, same failures/)
  })
})

describe("related narrowing", () => {
  test("a check whose command names a path outside its cwd runs in full, never skipped", () => {
    const { root } = repo({
      "pkg/keep.txt": "x\n",
      "tests/a.test.mjs": 'import { test } from "node:test"\ntest("a", () => {})\n',
    })
    const outside = { ...check("node --test ../tests/a.test.mjs", path.join(root, "pkg")) }
    const plan = planRelated(root, ["tests/a.test.mjs"], [outside]).plans.get(outside)!
    assert.equal(plan.skipped, undefined)
    assert.match(plan.full ?? "", /paths outside its directory/)

    const own = check("node --test a.test.mjs", path.join(root, "pkg"))
    assert.match(planRelated(root, ["tests/a.test.mjs"], [own]).plans.get(own)!.skipped ?? "", /no changes and no related tests/)
  })

  test("pytest and jest checks that select their own tests run in full", () => {
    const { root } = repo({
      "pyproject.toml": "[tool.pytest.ini_options]\n",
      "tests/test_slow.py": "def test_slow():\n    assert True\n",
      "tests/test_fast.py": "def test_fast():\n    assert True\n",
      "src/a.test.js": "test('a', () => {})\n",
    })
    const py = check("python -m pytest -q -m slow", root)
    const js = check("npx jest -t unit", root)
    const plans = planRelated(root, ["tests/test_fast.py", "src/a.test.js"], [py, js]).plans
    assert.equal(plans.get(py)!.command, undefined)
    assert.match(plans.get(py)!.full ?? "", /selects its own tests/)
    assert.equal(plans.get(js)!.command, undefined)
    assert.match(plans.get(js)!.full ?? "", /selects its own tests/)
    assert.equal(narrowCommand(py, ["tests/test_fast.py"]), undefined)
    assert.equal(narrowCommand(js, ["src/a.test.js"]), undefined)
  })
})

describe("detection", () => {
  test("a package.json the work adds in a new package has its test run", async () => {
    const { root, base } = repo({ "package.json": JSON.stringify({ scripts: { test: 'node -e "0"' } }) })
    write(root, {
      "packages/new/package.json": JSON.stringify({ scripts: { test: "node --test test/x.test.mjs" } }),
      "packages/new/test/x.test.mjs": 'import { test } from "node:test"\nimport assert from "node:assert/strict"\ntest("x", () => { assert.equal(1, 2) })\n',
    })
    const v = await gate(path.join(root, "packages", "new"), { base, stateDir: tmp() })
    assert.equal(v.pass, false, v.text)
    const added = v.checks.find((c) => c.name === "test:packages/new")
    assert.ok(added, v.checks.map((c) => c.name).join(", "))
    assert.equal(added!.pass, false)
    assert.match(added!.command, /npm test/, "the new package's own script ran")
  })

  test("a .venv and a src layout come from the working tree, not the commit", async () => {
    const { root, base } = repo({
      "pyproject.toml": "[project]\nname='x'\n[tool.pytest.ini_options]\n",
      "tests/test_a.py": "def test_a():\n    assert True\n",
    })
    write(root, { ".venv/bin/python": "#!/bin/sh\nexit 0\n", "src/pkg/__init__.py": "" })
    const checks = await detectChecks(root, await loadSettingsAt(root, base), base)
    const test = checks.find((c) => c.kind === "test")!
    assert.ok(test.command.startsWith(`"${path.join(root, ".venv/bin/python")}"`), test.command)
    assert.equal(test.env?.PYTHONPATH, [path.join(root, "src"), root].join(path.delimiter))
  })

  test("checkScripts reads cd and attributes the script to that package.json", async () => {
    const { root, base } = repo({
      "horde.json": JSON.stringify({ verify: { checks: { unit: "cd pkg && npm run unit" } } }),
      "pkg/package.json": JSON.stringify({ scripts: { unit: 'node -e "0"' } }),
    })
    assert.deepEqual(checkScripts([{ name: "unit", command: "cd pkg && npm run unit", kind: "test", cwd: root, source: "horde.json" }]), ["unit"])
    // Rewriting the script the check runs is a rule change, named against pkg/package.json.
    write(root, { "pkg/package.json": JSON.stringify({ scripts: { unit: 'node -e "0" # changed' } }) })
    const v = await gate(root, { base, stateDir: tmp() })
    assert.equal(v.pass, false, v.text)
    assert.ok(
      v.blockers.some((b) => b.includes("pkg/package.json") && b.includes("changes the rules")),
      v.blockers.join("\n"),
    )
    assert.equal(v.checks.find((c) => c.name === "unit")!.pass, true)
  })
})

describe("the verdict key", () => {
  test("every ignored file counts, not the first 200 sorted names at depth two", async () => {
    const { root, base } = repo({
      "horde.json": JSON.stringify({
        verify: { checks: { test: `node -e "process.exit(require('node:fs').readFileSync('.env','utf8').trim()==='good'?0:1)"` } },
      }),
      ".gitignore": ".env\n.cache/\n",
    })
    write(root, { ".env": "good\n" })
    fs.mkdirSync(path.join(root, ".cache"))
    for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(root, ".cache", `a${String(i).padStart(3, "0")}`), "x")
    const stateDir = tmp()
    const first = await gate(root, { base, stateDir })
    assert.equal(first.pass, true, first.text)
    assert.equal(first.cached, false)

    // .env sorts after every .cache/ name: a cap on the first 200 names would drop it from the key.
    write(root, { ".env": "evil\n" })
    const env = path.join(root, ".env")
    const t = fs.statSync(env).mtimeMs + 5000
    fs.utimesSync(env, new Date(t), new Date(t))
    const after = await gate(root, { base, stateDir })
    assert.equal(after.cached, false, "the ignored .env changed")
    assert.equal(after.pass, false, after.text)
  })

  test("an untracked input is keyed by content, not by size and mtime", async () => {
    const { root, base } = repo({
      "horde.json": JSON.stringify({
        verify: { checks: { test: `node -e "process.exit(require('node:fs').readFileSync('input.txt','utf8').trim()==='good'?0:1)"` } },
      }),
    })
    write(root, { "input.txt": "good\n" })
    const stateDir = tmp()
    assert.equal((await gate(root, { base, stateDir })).pass, true)
    const file = path.join(root, "input.txt")
    const before = fs.statSync(file)
    write(root, { "input.txt": "evil\n" })
    fs.utimesSync(file, new Date(before.atimeMs), new Date(before.mtimeMs))
    assert.equal(fs.statSync(file).size, before.size)
    const after = await gate(root, { base, stateDir })
    assert.equal(after.cached, false, "the untracked input changed")
    assert.equal(after.pass, false, after.text)
  })
})

describe("runner caches and secrets", () => {
  test("a secret in a pre-existing coverage file still blocks; a cache binary does not", async () => {
    const key = "AKIA" + "ABCDEFGHIJKLMNOP"
    const { root, base } = repo({ "horde.json": JSON.stringify({ verify: { checks: { ok: 'node -e "0"' } } }) })
    write(root, {
      "coverage/payload.js": `const k = "${key}"\n`,
      ".cache/blob.bin": Buffer.from([0, 1, 2, 3, 0, 255]),
    })
    const v = await gate(root, { base, stateDir: tmp() })
    assert.equal(v.pass, false, v.text)
    assert.ok(
      v.blockers.some((b) => b.startsWith("secrets:") && b.includes("coverage/payload.js")),
      v.blockers.join("\n"),
    )
    assert.ok(!v.blockers.some((b) => b.startsWith("binaries:")), v.blockers.join("\n"))
  })
})

describe("check environment", () => {
  test("credentials by name and by URL are stripped; SSH_AUTH_SOCK and a keyboard name stay", async () => {
    const script = [
      "const must=['SSH_AUTH_SOCK','KEYBOARD_LAYOUT']",
      "const gone=['AWS_ACCESS_KEY_ID','PGPASSWORD','DATABASE_URL']",
      "const miss=must.filter(n=>!process.env[n])",
      "const seen=gone.filter(n=>process.env[n])",
      "if(miss.length||seen.length){console.error('missing '+miss+' saw '+seen);process.exit(1)}",
    ].join(";")
    const { root } = repo({ "horde.json": JSON.stringify({ verify: { checks: { env: { command: `node -e "${script}"` } } } }) })
    const values: Record<string, string> = {
      AWS_ACCESS_KEY_ID: "AKIA" + "ABCDEFGHIJKLMNOP",
      PGPASSWORD: "hunter2",
      // Built here so this test file holds no literal URL with a password.
      DATABASE_URL: "postgres://user" + ":pass@" + "host/db",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      KEYBOARD_LAYOUT: "us",
    }
    const saved = new Map(Object.keys(values).map((n) => [n, process.env[n]]))
    try {
      for (const [n, value] of Object.entries(values)) process.env[n] = value
      const v = await gate(root, { stateDir: tmp() })
      assert.equal(v.pass, true, v.text)
    } finally {
      for (const [n, value] of saved) {
        if (value === undefined) delete process.env[n]
        else process.env[n] = value
      }
    }
  })
})

describe("the rendered verdict", () => {
  test("warnings render, and audit findings come before the check output", () => {
    const failing = {
      name: "test",
      command: "node --test",
      kind: "test" as const,
      pass: false,
      code: 1,
      durationMs: 1,
      extracted: { runner: "tap" as const, failures: [{ test: "a", file: "test/a.test.mjs", line: 3, message: "boom" }] },
    }
    const v = {
      pass: false,
      directory: "/x",
      checks: [failing],
      audit: {
        base: "abcdef1234",
        files: ["src/a.ts"],
        commits: 0,
        findings: [{ category: "tests" as const, severity: "block" as const, file: "src/a.ts", text: "removes a test" }],
      },
      blockers: ["test: 1 failed"],
      warnings: ["could not compare with master's tip: deps are missing"],
      durationMs: 1,
    }
    const text = render(v, 1000)
    assert.match(text, /! could not compare with master's tip: deps are missing/)
    const finding = text.indexOf("tests: src/a.ts removes a test")
    assert.ok(finding >= 0, text)
    assert.ok(finding < text.indexOf("  ✗ test:"), "the audit line survives ahead of the failures")
  })
})

describe("cancellation", () => {
  test("a baseline run honours the caller's abort signal", async () => {
    const { root, base } = repo({
      "horde.json": JSON.stringify({ verify: { checks: { test: "node check.mjs" } } }),
      // The base's copy never finishes; the work's copy fails at once with a named failure.
      "check.mjs": "setTimeout(() => {}, 8000)\n",
    })
    write(root, { "check.mjs": tapFailure() })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 1000)
    const started = Date.now()
    const v = await gate(root, {
      base,
      signal: ac.signal,
      baseline: { commit: base, label: "master's tip", checkout: checkoutOf(root, base) },
      stateDir: tmp(),
    })
    assert.ok(Date.now() - started < 6000, `stopped at the abort, not after the baseline: ${Date.now() - started}ms`)
    assert.equal(v.pass, false)
  })
})

describe("cmd.exe quoting", () => {
  test("a quote in a narrowed path is doubled, and % stays as it is", () => {
    const saved = Object.getOwnPropertyDescriptor(process, "platform")!
    try {
      Object.defineProperty(process, "platform", { value: "win32" })
      assert.equal(narrowCommand(check("npx vitest run"), ['test/a"b.test.js']), 'npx vitest run "test/a""b.test.js"')
      // cmd.exe expands %NAME% inside double quotes and offers no escape for it.
      assert.equal(narrowCommand(check("npx vitest run"), ["test/a%b.test.js"]), 'npx vitest run "test/a%b.test.js"')
    } finally {
      Object.defineProperty(process, "platform", saved)
    }
  })
})
