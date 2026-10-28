import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, test } from "node:test"
import {
  fitSections,
  formatDuration,
  globMatcher,
  isTestPath,
  loadHordeFile,
  loadTiers,
  loadWorkers,
  readJson,
  runCommand,
  splitZ,
  tierLabel,
  tierModel,
  truncate,
  withLock,
  writeJson,
} from "@mcp-horde/core"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "horde-core-"))
const node = `"${process.execPath}"`

/** Write a helper script and return the shell command that runs it. */
function script(dir: string, name: string, body: string) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, body)
  return `${node} "${file}"`
}

describe("files and locks", () => {
  test("atomic JSON round trip; missing or broken files read as undefined", () => {
    const dir = tmp()
    const file = path.join(dir, "x.json")
    writeJson(file, { a: 1 })
    assert.deepEqual(readJson(file), { a: 1 })
    assert.equal(readJson(path.join(dir, "missing.json")), undefined)
    fs.writeFileSync(file, "{not json")
    assert.equal(readJson(file), undefined)
    assert.deepEqual(
      fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")),
      [],
      "no temp files left behind",
    )
  })

  test("withLock serializes holders, takes over a dead holder, waits for a live one", async () => {
    const dir = tmp()
    const order: string[] = []
    const hold = (tag: string) =>
      withLock(dir, "x", async () => {
        order.push(`${tag}+`)
        await new Promise((r) => setTimeout(r, 50))
        order.push(`${tag}-`)
      })
    await Promise.all([hold("a"), hold("b")])
    assert.ok(["a+ a- b+ b-", "b+ b- a+ a-"].includes(order.join(" ")), order.join(" "))
    assert.ok(!fs.existsSync(path.join(dir, "x.lock")), "released")

    const dead = execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).toString()
    fs.writeFileSync(path.join(dir, "x.lock"), JSON.stringify({ pid: Number(dead), host: os.hostname(), token: "t" }))
    assert.equal(await withLock(dir, "x", async () => "ok", 5_000), "ok")

    fs.writeFileSync(path.join(dir, "x.lock"), JSON.stringify({ pid: process.pid, host: os.hostname(), token: "t" }))
    await assert.rejects(
      withLock(dir, "x", async () => "stolen", 600),
      /timed out/,
    )
    assert.ok(fs.existsSync(path.join(dir, "x.lock")), "someone else's lock is left alone")
  })
})

describe("lifecycle log", () => {
  // A child that records its lifecycle, then exits, throws, or waits to be signalled.
  const child = (state: string, how: "exit" | "throw" | "wait" | "oom") => {
    const lib = JSON.stringify(path.resolve(import.meta.dirname, "../src/index.ts"))
    const body = `const { recordLifecycle } = await import(${lib}); recordLifecycle("probe", "1.2.3"); ${
      how === "exit"
        ? "process.exit(3)"
        : how === "throw"
          ? "setTimeout(() => { throw new Error('boom') })"
          : how === "oom"
            ? "const keep = []; for (;;) keep.push(new Array(1e5).fill({}))"
            : "process.stdout.write('ready'); setInterval(() => {}, 1000)"
    }`
    const heap = how === "oom" ? ["--max-old-space-size=64"] : []
    return spawn(process.execPath, [...heap, "--import", "tsx", "--input-type=module", "-e", body], {
      env: { ...process.env, XDG_STATE_HOME: state },
      stdio: ["pipe", "pipe", "pipe"],
    })
  }
  const done = (p: ReturnType<typeof spawn>) => new Promise<void>((r) => p.once("exit", () => r()))
  const log = (state: string) => fs.readFileSync(path.join(state, "mcp-horde", "servers.log"), "utf8")

  test("a server's start and how it ended: exit code, uncaught exception, signal", { skip: process.platform === "win32" }, async () => {
    const state = tmp()
    // A log left world-readable by an older version is made private on the first note.
    fs.mkdirSync(path.join(state, "mcp-horde"), { recursive: true, mode: 0o755 })
    fs.writeFileSync(path.join(state, "mcp-horde", "servers.log"), "", { mode: 0o644 })
    await done(child(state, "exit"))
    assert.match(log(state), /probe pid \d+: started \(version 1\.2\.3, parent \d+\)\n.*probe pid \d+: exited with code 3 after \d+s/)
    assert.equal(fs.statSync(path.join(state, "mcp-horde", "servers.log")).mode & 0o777, 0o600, "the log is private to the user")
    const fresh = tmp()
    await done(child(fresh, "exit"))
    assert.equal(fs.statSync(path.join(fresh, "mcp-horde")).mode & 0o777, 0o700, "a new state root is private to the user")
    await done(child(state, "throw"))
    assert.match(log(state), /probe pid \d+: uncaught exception: Error: boom/)
    const waiting = child(state, "wait")
    await new Promise<void>((r) => waiting.stdout!.once("data", () => r()))
    waiting.kill("SIGHUP")
    await done(waiting)
    assert.match(log(state), /probe pid \d+: got SIGHUP\n.*probe pid \d+: exited with code 129/)
    assert.equal(waiting.exitCode, 129, "the default of exiting on a signal is kept")
  })

  test("a native abort leaves a report with the error next to the log", { skip: process.platform === "win32" }, async () => {
    const state = tmp()
    const p = child(state, "oom")
    await done(p)
    assert.equal(p.signalCode, "SIGABRT", "V8 aborts the process on running out of heap")
    assert.doesNotMatch(log(state), /exited with code/, "an abort skips the exit event")
    const reports = fs.readdirSync(path.join(state, "mcp-horde")).filter((f) => /^report\..*\.json$/.test(f))
    assert.equal(reports.length, 1)
    const report = JSON.parse(fs.readFileSync(path.join(state, "mcp-horde", reports[0]!), "utf8"))
    assert.match(report.header.event, /heap/i)
  })
})

describe("runCommand", () => {
  test("exit codes and interleaved output", async () => {
    const dir = tmp()
    const ok = await runCommand(script(dir, "ok.js", "console.log('out'); console.error('err')"), { cwd: dir })
    assert.equal(ok.code, 0)
    assert.match(ok.output, /out/)
    assert.match(ok.output, /err/)
    assert.equal(ok.stopped, undefined)
    const bad = await runCommand(script(dir, "bad.js", "process.exit(3)"), { cwd: dir })
    assert.equal(bad.code, 3)
  })

  test("long output keeps the head and the tail", async () => {
    const dir = tmp()
    const cmd = script(dir, "long.js", "console.log('FIRST'); for (let i = 0; i < 5000; i++) console.log('line ' + i); console.log('LAST')")
    const r = await runCommand(cmd, { cwd: dir, maxChars: 2000 })
    assert.ok(r.truncated > 0)
    assert.ok(r.output.length < 2200, `capped: ${r.output.length}`)
    assert.match(r.output, /^FIRST/)
    assert.match(r.output, /LAST\s*$/)
    assert.match(r.output, /chars omitted/)
  })

  test("environment: extra variables are set, stripped prefixes are removed", async () => {
    const dir = tmp()
    process.env.HORDE_CORE_TEST_SECRET = "s3cret"
    try {
      const cmd = script(dir, "env.js", "console.log(process.env.EXTRA + ':' + (process.env.HORDE_CORE_TEST_SECRET ?? 'none'))")
      const r = await runCommand(cmd, { cwd: dir, env: { EXTRA: "x" }, stripEnv: ["HORDE_CORE_TEST_"] })
      assert.match(r.output, /^x:none/)
    } finally {
      delete process.env.HORDE_CORE_TEST_SECRET
    }
  })

  test("a timeout kills the whole process tree", async () => {
    const dir = tmp()
    const marker = path.join(dir, "grandchild-ran")
    const child = path.join(dir, "child.js")
    fs.writeFileSync(child, `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "x"), 1500)`)
    const parent = script(
      dir,
      "parent.cjs",
      `require("child_process").spawn(process.execPath, [${JSON.stringify(child)}], { stdio: "ignore" }); setInterval(() => {}, 1000)`,
    )
    const r = await runCommand(parent, { cwd: dir, timeoutMs: 400 })
    assert.equal(r.stopped, "timeout")
    await new Promise((res) => setTimeout(res, 2500))
    assert.equal(fs.existsSync(marker), false, "the grandchild was killed with its parent")
  })

  test("a shell that exits while its background children hold the output is still stopped", { skip: process.platform === "win32" }, async () => {
    const dir = tmp()
    const t0 = Date.now()
    const r = await runCommand(`${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)" & echo hi`, { cwd: dir, timeoutMs: 400 })
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0}ms`)
    assert.match(r.output, /hi/)
    const lingering = await runCommand(`${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)" & echo bye`, { cwd: dir })
    assert.equal(lingering.code, 0, "the command itself succeeded; its leftover child was stopped after a grace period")
    assert.match(lingering.output, /bye/)
    // A daemon that left the process group still cannot hold the result hostage.
    const t1 = Date.now()
    const escaped = await runCommand(`setsid ${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 20000)" & echo away`, { cwd: dir, timeoutMs: 300 })
    assert.ok(Date.now() - t1 < 6000, `took ${Date.now() - t1}ms`)
    assert.match(escaped.output, /away/)
  })

  test("abort stops the command", async () => {
    const dir = tmp()
    const ac = new AbortController()
    const p = runCommand(script(dir, "wait.js", "setInterval(() => {}, 1000)"), { cwd: dir, signal: ac.signal })
    setTimeout(() => ac.abort(), 200)
    const r = await p
    assert.equal(r.stopped, "cancelled")
  })
})

describe("text and config edge cases", () => {
  test("fitSections under a tight budget shortens the last optional section instead of dropping everything", () => {
    const out = fitSections(
      [
        { text: "## Head", required: true },
        { text: "A".repeat(800), omitted: (n: number) => `(${n} more file(s) omitted)`, group: "files" },
        { text: "B".repeat(800), omitted: (n: number) => `(${n} more file(s) omitted)`, group: "files" },
        { text: "C".repeat(800), omitted: "(definitions omitted)" },
      ],
      1000,
    )
    assert.ok(out.length <= 1000, String(out.length))
    assert.ok(out.length > 600, `kept content: ${out.length}`)
    assert.match(out, /A{100}/)
  })

  test("truncate never exceeds its limit and counts what it dropped", () => {
    for (const max of [5, 10, 19, 20, 50]) {
      const out = truncate("x".repeat(100), max)
      assert.ok(out.length <= max || max < 12, `${max}: ${out}`)
      const kept = out.indexOf("…")
      assert.match(out, new RegExp(`\\[\\+${100 - kept} chars\\]$`))
    }
  })

  test("horde.json outside a repository: only the directory itself", () => {
    const outer = tmp()
    fs.writeFileSync(path.join(outer, "horde.json"), "{ not json")
    const inner = path.join(outer, "loose")
    fs.mkdirSync(inner)
    assert.deepEqual(loadHordeFile(inner).data, {}, "an unrelated horde.json above is ignored")
    fs.writeFileSync(path.join(inner, "horde.json"), JSON.stringify({ tiers: ["a/b"] }))
    assert.deepEqual(loadHordeFile(inner).data, { tiers: ["a/b"] })
  })
})

describe("text", () => {
  test("fitSections keeps sections in priority order and always keeps omission notes", () => {
    const sections = [
      { text: "A".repeat(100), required: true },
      { text: "B".repeat(100), omitted: "+B omitted" },
      { text: "C".repeat(500), omitted: "+C omitted" },
      { text: "D".repeat(50), omitted: "+D omitted" },
    ]
    const out = fitSections(sections, 300)
    assert.ok(out.length <= 300, `within budget: ${out.length}`)
    assert.match(out, /^A{100}\nB{100}/)
    assert.match(out, /\+C omitted/)
    assert.match(out, /D{50}/, "a later small section still fits after an omitted big one")
    // A required section is truncated rather than dropped.
    const tight = fitSections([{ text: "R".repeat(1000), required: true }], 100)
    assert.ok(tight.length <= 100)
    assert.match(tight, /^R+… \[\+\d+ chars\]$/)
  })

  test("small helpers", () => {
    assert.deepEqual(splitZ(" a b\0c\0"), [" a b", "c"])
    assert.equal(truncate("abcdef", 100), "abcdef")
    assert.equal(formatDuration(450), "450ms")
    assert.equal(formatDuration(9_200), "9.2s")
    assert.equal(formatDuration(75_000), "1m15s")
  })
})

describe("horde.json", () => {
  test("found from a subdirectory, not above the repository root, malformed files throw", () => {
    const outer = tmp()
    fs.writeFileSync(path.join(outer, "horde.json"), JSON.stringify({ tiers: ["outer/model"] }))
    const repo = path.join(outer, "repo")
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true })
    fs.mkdirSync(path.join(repo, "src", "deep"), { recursive: true })
    assert.deepEqual(loadHordeFile(path.join(repo, "src", "deep")).data, {}, "does not escape the repository")
    fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify({ tiers: ["inner/model"] }))
    const found = loadHordeFile(path.join(repo, "src", "deep"))
    assert.deepEqual(found.data, { tiers: ["inner/model"] })
    assert.equal(found.root, repo)
    fs.writeFileSync(path.join(repo, "horde.json"), "{ nope")
    assert.throws(() => loadHordeFile(repo), /not valid JSON/)
    fs.writeFileSync(path.join(repo, "horde.json"), "[1]")
    assert.throws(() => loadHordeFile(repo), /JSON object/)
  })

  test("model tiers: validated, labelled, and the last tier is the orchestrator's", () => {
    const repo = tmp()
    fs.mkdirSync(path.join(repo, ".git"))
    assert.deepEqual(loadTiers(repo), [])
    assert.equal(tierModel(3, [], "t-1"), undefined, "no tiers: the caller picks the model")
    fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify({ tiers: ["deepseek/deepseek-chat", { model: "moonshot/kimi-k2", variant: "high" }] }))
    const tiers = loadTiers(repo)
    assert.deepEqual(tiers, [{ model: "deepseek/deepseek-chat" }, { model: "moonshot/kimi-k2", variant: "high" }])
    assert.equal(tierLabel(1, tiers), "tier 1 (moonshot/kimi-k2 high)")
    assert.equal(tierLabel(2, tiers), "tier 2 (past the last model tier: yours)")
    assert.equal(tierLabel(2, []), "tier 2")
    assert.deepEqual(tierModel(0, tiers, "t-1"), { model: "deepseek/deepseek-chat" })
    assert.throws(() => tierModel(2, tiers, "t-1"), /t-1 is at tier 2, past the last of the 2 tier\(s\) in horde\.json: the last tier is you/)
    fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify({ tiers: [{ model: "no-provider" }] }))
    assert.throws(() => loadTiers(repo), /"tiers"\[0\] needs "model": "provider\/model"/)
  })

  test("user-level horde.json supplies tiers unless the repository sets them", () => {
    const repo = tmp()
    fs.mkdirSync(path.join(repo, ".git"))
    const config = tmp()
    const userFile = path.join(config, "mcp-horde", "horde.json")
    fs.mkdirSync(path.dirname(userFile), { recursive: true })
    const xdg = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = config
    try {
      fs.writeFileSync(userFile, JSON.stringify({ tiers: ["deepseek/deepseek-flash"], workers: { setup: "echo ignored" } }))
      assert.deepEqual(loadTiers(repo), [{ model: "deepseek/deepseek-flash" }])
      assert.deepEqual(loadWorkers(repo), {}, "keys other than tiers and opencode are ignored")
      fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify({ tiers: ["moonshot/kimi-k2"] }))
      assert.deepEqual(loadTiers(repo), [{ model: "moonshot/kimi-k2" }], "the repository's tiers win")
      fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify({}))
      fs.writeFileSync(userFile, JSON.stringify({ tiers: [{ model: "no-provider" }] }))
      assert.throws(
        () => loadTiers(repo),
        (err: Error) => err.message.includes(userFile) && /"tiers"\[0\]/.test(err.message),
      )
      fs.writeFileSync(userFile, "{ nope")
      assert.throws(
        () => loadTiers(repo),
        (err: Error) => err.message.includes(userFile) && /not valid JSON/.test(err.message),
      )
    } finally {
      if (xdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = xdg
    }
  })

  test("the user-level horde.json falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    const repo = tmp()
    fs.mkdirSync(path.join(repo, ".git"))
    const home = tmp()
    const userFile = path.join(home, ".config", "mcp-horde", "horde.json")
    fs.mkdirSync(path.dirname(userFile), { recursive: true })
    fs.writeFileSync(userFile, JSON.stringify({ tiers: ["deepseek/deepseek-flash"] }))
    const xdg = process.env.XDG_CONFIG_HOME
    const previousHome = process.env.HOME
    delete process.env.XDG_CONFIG_HOME
    process.env.HOME = home
    try {
      assert.deepEqual(loadTiers(repo), [{ model: "deepseek/deepseek-flash" }])
    } finally {
      if (xdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = xdg
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
    }
  })

  test("worker setup: link, setup and brief, validated; absent means the defaults", () => {
    const repo = tmp()
    fs.mkdirSync(path.join(repo, ".git"))
    assert.deepEqual(loadWorkers(repo), {})
    fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify({ workers: { link: ["node_modules"], setup: "npm run build" } }))
    assert.deepEqual(loadWorkers(repo), { link: ["node_modules"], setup: "npm run build" })
    fs.writeFileSync(
      path.join(repo, "horde.json"),
      JSON.stringify({ workers: { link: ["node_modules"], setup: "npm run build", brief: ["docs/lane_brief.md", "CLAUDE.md"] } }),
    )
    assert.deepEqual(loadWorkers(repo), { link: ["node_modules"], setup: "npm run build", brief: ["docs/lane_brief.md", "CLAUDE.md"] })
    fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify({ workers: { link: "node_modules" } }))
    assert.throws(() => loadWorkers(repo), /"workers"\.link must be an array of paths/)
    fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify({ workers: { setup: ["npm ci"] } }))
    assert.throws(() => loadWorkers(repo), /"workers"\.setup must be a command string/)
    fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify({ workers: { brief: "docs/lane_brief.md" } }))
    assert.throws(() => loadWorkers(repo), /horde\.json: "workers"\.brief must be an array of paths/)
    fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify({ workers: { brief: ["docs/lane_brief.md", 3] } }))
    assert.throws(() => loadWorkers(repo), /horde\.json: "workers"\.brief must be an array of paths/)
    fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify({ workers: { land: "npm run generate" } }))
    assert.deepEqual(loadWorkers(repo), { land: "npm run generate" })
    fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify({ workers: { land: { command: "npm run generate", message: "chore: regenerate" } } }))
    assert.deepEqual(loadWorkers(repo), { land: { command: "npm run generate", message: "chore: regenerate" } })
    fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify({ workers: { land: ["npm run generate"] } }))
    assert.throws(() => loadWorkers(repo), /horde\.json: "workers"\.land must be a command string or \{ "command": "…", "message"\?: "…" \}/)
    fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify({ workers: { land: { message: "chore: regenerate" } } }))
    assert.throws(() => loadWorkers(repo), /horde\.json: "workers"\.land must be a command string or \{ "command": "…", "message"\?: "…" \}/)
    fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify({ workers: { land: { command: "npm run generate", message: 3 } } }))
    assert.throws(() => loadWorkers(repo), /horde\.json: "workers"\.land\.message must be a string/)
  })

  test("unknown keys are rejected at every level, with a hint", () => {
    const repo = tmp()
    fs.mkdirSync(path.join(repo, ".git"))
    const load = (data: unknown) => {
      fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify(data))
      return loadHordeFile(repo)
    }
    assert.throws(() => load({ verfy: {} }), /unknown key "verfy".*did you mean "verify"/)
    assert.throws(() => load({ workers: { setpu: "npm ci" } }), /unknown key "workers\.setpu".*did you mean "setup"/)
    assert.throws(() => load({ workers: { land: { command: "x", mesage: "y" } } }), /unknown key "workers\.land\.mesage".*did you mean "message"/)
    assert.throws(() => load({ opencode: { maxRunnin: 3 } }), /unknown key "opencode\.maxRunnin".*did you mean "maxRunning"/)
    assert.throws(() => load({ context: { entryponts: [] } }), /unknown key "context\.entryponts".*did you mean "entrypoints"/)
    assert.throws(() => load({ tiers: [{ model: "a/b", varaint: "high" }] }), /unknown key "tiers\[0\]\.varaint".*did you mean "variant"/)
    assert.doesNotThrow(() => load({ context: { ignore: ["dist"] }, opencode: { maxRunning: 2 }, tiers: [{ model: "a/b", variant: "high" }] }))
  })

  test("the user-level horde.json rejects unknown keys too", () => {
    const repo = tmp()
    fs.mkdirSync(path.join(repo, ".git"))
    const config = tmp()
    const userFile = path.join(config, "mcp-horde", "horde.json")
    fs.mkdirSync(path.dirname(userFile), { recursive: true })
    fs.writeFileSync(userFile, JSON.stringify({ tier: ["deepseek/deepseek-flash"] }))
    const xdg = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = config
    try {
      assert.throws(
        () => loadTiers(repo),
        (err: Error) => err.message.includes(userFile) && /unknown key "tier".*did you mean "tiers"/.test(err.message),
      )
    } finally {
      if (xdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = xdg
    }
  })
})

describe("globMatcher", () => {
  test("brace alternatives and character classes", () => {
    const m = globMatcher(["src/{auth,api/v{1,2}}/**", "*.{ts,tsx}", "doc[0-9].md", "x[!a].txt"])
    for (const p of ["src/auth/a.js", "src/api/v1/x.js", "src/api/v2/y/z.js", "a.ts", "deep/b.tsx", "doc3.md", "xb.txt"]) assert.ok(m(p), p)
    for (const p of ["src/api/v3/x.js", "src/other/a.js", "a.js", "docx.md", "xa.txt", "x/.txt"]) assert.ok(!m(p), p)
    assert.ok(globMatcher(["{a}.md"])("{a}.md"), "a brace without alternatives is literal")
  })
})

describe("isTestPath", () => {
  test("Django's per-app tests.py is a test file", () => {
    for (const p of ["shop/tests.py", "tests.py", "blog/apps/shop/tests.py"]) assert.ok(isTestPath(p), p)
    for (const p of ["shop/test.py", "shop/testing.py"]) assert.ok(!isTestPath(p), p)
  })
})
