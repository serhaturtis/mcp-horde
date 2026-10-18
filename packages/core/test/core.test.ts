import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, test } from "node:test"
import {
  fitSections,
  formatDuration,
  loadHordeFile,
  loadTiers,
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

  test("abort stops the command", async () => {
    const dir = tmp()
    const ac = new AbortController()
    const p = runCommand(script(dir, "wait.js", "setInterval(() => {}, 1000)"), { cwd: dir, signal: ac.signal })
    setTimeout(() => ac.abort(), 200)
    const r = await p
    assert.equal(r.stopped, "cancelled")
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
    fs.writeFileSync(path.join(outer, "horde.json"), JSON.stringify({ project: "outer" }))
    const repo = path.join(outer, "repo")
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true })
    fs.mkdirSync(path.join(repo, "src", "deep"), { recursive: true })
    assert.deepEqual(loadHordeFile(path.join(repo, "src", "deep")).data, {}, "does not escape the repository")
    fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify({ project: "inner" }))
    const found = loadHordeFile(path.join(repo, "src", "deep"))
    assert.equal(found.data.project, "inner")
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
})
