import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, type TestContext, test } from "node:test"
import { runCommand, scopeAvailable, scopeEnabled } from "@mcp-horde/core"

function tmp(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "horde-process-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function done(proc: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => proc.once("exit", () => resolve()))
}

describe("lifecycle log", () => {
  test("a fatal-error report leaves the environment out and the state directory is 0700", { skip: process.platform === "win32" }, async (t) => {
    const state = tmp(t)
    const horde = path.join(state, "mcp-horde")
    fs.mkdirSync(horde, { recursive: true, mode: 0o755 })
    fs.chmodSync(horde, 0o755) // an upgraded install's directory, not a fresh one
    const lib = JSON.stringify(path.resolve(import.meta.dirname, "../src/index.ts"))
    const body = `const { recordLifecycle } = await import(${lib}); recordLifecycle("probe", "1.2.3"); const keep = []; for (;;) keep.push(new Array(1e5).fill({}))`
    const proc = spawn(process.execPath, ["--max-old-space-size=64", "--import", "tsx", "--input-type=module", "-e", body], {
      env: { ...process.env, XDG_STATE_HOME: state, HORDE_REPORT_CANARY: "leak-canary" },
      stdio: ["pipe", "pipe", "pipe"],
    })
    await done(proc)
    assert.equal(proc.signalCode, "SIGABRT", "V8 aborts the process on running out of heap")
    assert.equal(fs.statSync(horde).mode & 0o777, 0o700, "an existing 0755 state directory is tightened")
    const reportFile = fs.readdirSync(horde).find((file) => /^report\..*\.json$/.test(file))
    assert.ok(reportFile, "a native abort leaves a report")
    const report = fs.readFileSync(path.join(horde, reportFile), "utf8")
    assert.doesNotMatch(report, /leak-canary/, "the report does not dump the environment")
    assert.doesNotMatch(report, /environmentVariables/)
  })
})

describe("HORDE_SCOPE", () => {
  test("known words enable or disable scopes; an unknown value counts as unset and is noted once", (t) => {
    const state = tmp(t)
    const previous = process.env.XDG_STATE_HOME
    process.env.XDG_STATE_HOME = state
    t.after(() => {
      if (previous === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = previous
    })
    for (const value of ["on", "1", "true", "yes", "auto", "ON", " Auto "]) assert.equal(scopeEnabled({ HORDE_SCOPE: value }), true, value)
    for (const value of ["off", "0", "false", "no", "OFF", " No "]) assert.equal(scopeEnabled({ HORDE_SCOPE: value }), false, value)
    assert.equal(scopeEnabled({ HORDE_SCOPE: "typo" }), true, "an unknown value behaves as unset (on)")
    assert.equal(scopeEnabled({ HORDE_SCOPE: "typo" }), true)
    const log = fs.readFileSync(path.join(state, "mcp-horde", "servers.log"), "utf8")
    assert.equal(log.match(/HORDE_SCOPE="typo"/g)?.length, 1, "the typo is noted once")
  })
})

describe("scopeAvailable", () => {
  test("re-probes for a different runtime directory and session bus", { skip: process.platform !== "linux" }, (t) => {
    const dir = tmp(t)
    const fake = path.join(dir, "systemd-run")
    fs.writeFileSync(fake, `#!/bin/sh\n[ "$XDG_RUNTIME_DIR" = "$FAKE_GOOD" ] && [ "$DBUS_SESSION_BUS_ADDRESS" = "unix:path=/good" ]\n`)
    fs.chmodSync(fake, 0o755)
    const good = path.join(dir, "runtime-good")
    const base = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      HORDE_SCOPE: "on",
      FAKE_GOOD: good,
    } as NodeJS.ProcessEnv
    const env = (runtime: string, bus: string) => ({ ...base, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: bus })
    assert.equal(scopeAvailable(env(good, "unix:path=/good"), "linux"), true)
    assert.equal(scopeAvailable(env(path.join(dir, "runtime-bad"), "unix:path=/good"), "linux"), false, "the runtime dir is part of the key")
    assert.equal(scopeAvailable(env(good, "unix:path=/bad"), "linux"), false, "the session bus is part of the key")
    assert.equal(scopeAvailable(env(good, "unix:path=/good"), "linux"), true)
  })
})

describe("runCommand", () => {
  test("a scoped check killed on timeout also stops its scope", {
    skip: process.platform !== "linux" || !scopeAvailable() ? "needs a systemd user scope" : false,
  }, async (t) => {
    const dir = tmp(t)
    const result = await runCommand("setsid sleep 60 >/dev/null 2>&1 & sleep 60", { cwd: dir, timeoutMs: 400 })
    assert.equal(result.stopped, "timeout")
    const units = spawnSync("systemctl", ["--user", "list-units", "--all", "--plain", "--no-legend", `horde-check-${process.pid}-*.scope`], {
      encoding: "utf8",
    }).stdout
    assert.doesNotMatch(units, /active running/, "the daemonized child's scope was stopped too")
  })
})
