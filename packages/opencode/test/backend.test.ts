import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { describe, type TestContext, test } from "node:test"
import {
  Backend,
  binaryVersion,
  droppedSecretWarning,
  isOurSharedServer,
  openSharedLog,
  processStartTime,
  retrySessionEnvironment,
  serverEnv,
  stopPid,
  stopServer,
} from "../src/backend.js"
import { cpuQuotaCores, defaultMaxRunning, effectiveCores, loadConfig } from "../src/config.js"
import { type ServerRecord, Store } from "../src/state.js"

function tmp(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "horde-backend-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error("timed out waiting")
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

/** A detached child that stands in for a server; always stops its whole group. */
function child(t: TestContext, body: string, args: string[] = []) {
  const proc = spawn(process.execPath, ["-e", body, ...args], { stdio: "ignore", detached: true })
  t.after(() => {
    try {
      process.kill(-proc.pid!, "SIGKILL")
    } catch {
      // Already gone.
    }
  })
  return proc
}

/** An executable node script for binaryVersion. */
function fakeBin(t: TestContext, body: string) {
  const dir = tmp(t)
  const file = path.join(dir, "opencode")
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`)
  fs.chmodSync(file, 0o755)
  return file
}

describe("server environment", () => {
  test("keeps the Windows names case-insensitively, including a PATH spelled Path", () => {
    const source = {
      Path: "C:\\bin",
      USERNAME: "u",
      HOMEDRIVE: "C:",
      HOMEPATH: "\\Users\\u",
      PATHEXT: ".EXE;.CMD",
      SystemDrive: "C:",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      ProgramData: "C:\\ProgramData",
      PROCESSOR_ARCHITECTURE: "AMD64",
      NUMBER_OF_PROCESSORS: "8",
      OS: "Windows_NT",
      windir: "C:\\Windows",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      APPDATA: "C:\\AppData",
      LOCALAPPDATA: "C:\\Local",
      USERPROFILE: "C:\\Users\\u",
    } as NodeJS.ProcessEnv
    const env = serverEnv({ username: "me", password: "pw" }, source, "win32")
    for (const [name, value] of Object.entries(source)) assert.equal(env[name], value, name)
  })

  test("keeps proxies, terminal variables and toolchain roots everywhere", () => {
    const roots = [
      "NVM_DIR",
      "VOLTA_HOME",
      "FNM_DIR",
      "N_PREFIX",
      "PNPM_HOME",
      "BUN_INSTALL",
      "DENO_DIR",
      "MISE_DATA_DIR",
      "MISE_CONFIG_DIR",
      "ASDF_DIR",
      "ASDF_DATA_DIR",
      "PYENV_ROOT",
      "RBENV_ROOT",
      "CARGO_HOME",
      "RUSTUP_HOME",
      "GOPATH",
      "GOROOT",
      "GOMODCACHE",
      "GOFLAGS",
      "JAVA_HOME",
      "SDKMAN_DIR",
      "ANDROID_HOME",
      "ANDROID_SDK_ROOT",
      "DOTNET_ROOT",
      "UV_CACHE_DIR",
      "PIP_CACHE_DIR",
    ]
    const source: NodeJS.ProcessEnv = {
      PATH: "/bin",
      ALL_PROXY: "socks5://proxy",
      CURL_CA_BUNDLE: "/ca/curl.pem",
      REQUESTS_CA_BUNDLE: "/ca/requests.pem",
      GIT_SSL_CAINFO: "/ca/git.pem",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      SSH_AUTH_SOCK: "/run/agent.sock",
      OPENAI_API_KEY: "sk-secret",
    }
    for (const name of roots) source[name] = `/tool/${name}`
    const env = serverEnv({ username: "me" }, source, "linux")
    for (const name of ["PATH", "ALL_PROXY", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "GIT_SSL_CAINFO", "TERM", "COLORTERM", "SSH_AUTH_SOCK", ...roots]) {
      assert.equal(env[name], source[name], name)
    }
    assert.equal(env.OPENAI_API_KEY, undefined, "a provider key still needs HORDE_OPENCODE_PASS_ENV")
  })

  test("names dropped provider keys in one warning, at most five plus a count", () => {
    const source = {
      PATH: "/bin",
      OPENAI_API_KEY: "a",
      ANTHROPIC_API_KEY: "b",
      DEEPSEEK_API_KEY: "c",
      GITHUB_TOKEN: "d",
      NPM_TOKEN: "e",
      HF_TOKEN: "f",
      LINEAR_TOKEN: "g",
    } as NodeJS.ProcessEnv
    const warning = droppedSecretWarning(source, "me")!
    assert.match(warning, /OPENAI_API_KEY/)
    assert.match(warning, /and 2 more/)
    assert.match(warning, /HORDE_OPENCODE_PASS_ENV/)
    assert.equal((warning.match(/_API_KEY|_TOKEN/g) ?? []).length, 5, "only five names are listed")
    assert.match(droppedSecretWarning(source, "me", ["*_API_KEY"])!, /GITHUB_TOKEN/)
    assert.equal(droppedSecretWarning({ OPENAI_API_KEY: "a" } as NodeJS.ProcessEnv, "me", ["OPENAI_API_KEY"]), undefined)
  })
})

describe("shared-server identity", () => {
  test("a recorded start time and the argv prove a pid is our server", async (t) => {
    const port = await freePort()
    const proc = child(t, "setInterval(() => {}, 1000)", ["serve", "--port", String(port)])
    const startTime = await waitFor(() => processStartTime(proc.pid!))
    const record: ServerRecord = { url: `http://127.0.0.1:${port}`, password: "pw", pid: proc.pid!, startedAt: Date.now(), startTime }
    await waitFor(() => isOurSharedServer(record))
    assert.equal(isOurSharedServer({ ...record, startTime: undefined }), false, "an old record is not proof")
    assert.equal(isOurSharedServer({ ...record, startTime: "0" }), false, "a different start time is not ours")
    assert.equal(isOurSharedServer({ ...record, url: `http://127.0.0.1:${port + 1}` }), false, "the argv port must match")
  })

  test("stopServer never kills a pid it cannot verify and names it as unverified", async (t) => {
    const dir = tmp(t)
    const port = await freePort()
    const body = `require("node:http").createServer((q, s) => { s.statusCode = 401; s.end("no") }).listen(Number(process.argv[1]), "127.0.0.1")`
    const proc = child(t, body, [String(port), "serve", "--port", String(port)])
    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) })).status === 401
      } catch {
        return false
      }
    })
    const store = new Store(dir)
    store.setServer({ url: `http://127.0.0.1:${port}`, password: "pw", pid: proc.pid!, startedAt: Date.now() })
    const config = loadConfig({ HORDE_OPENCODE_DIRECTORY: dir, HORDE_OPENCODE_SERVER: "shared" } as NodeJS.ProcessEnv, { cores: 4 })
    const text = await stopServer(config, store)
    assert.match(text, new RegExp(`pid ${proc.pid} could not be verified as our server`))
    assert.match(text, /must be stopped by hand/)
    assert.equal(alive(proc.pid!), true, "the unverified pid is left alone")
    assert.equal(store.server, undefined, "the record is cleared")
  })

  test("a probe that times out never kills the recorded server", async (t) => {
    const dir = tmp(t)
    const port = await freePort()
    const body = `require("node:net").createServer(() => {}).listen(Number(process.argv[1]), "127.0.0.1")`
    const proc = child(t, body, [String(port), "serve", "--port", String(port)])
    await waitFor(
      () =>
        new Promise<boolean>((resolve) => {
          const socket = net.connect(port, "127.0.0.1")
          socket.once("connect", () => {
            socket.destroy()
            resolve(true)
          })
          socket.once("error", () => resolve(false))
        }),
    )
    const startTime = await waitFor(() => processStartTime(proc.pid!))
    const store = new Store(dir)
    store.setServer({ url: `http://127.0.0.1:${port}`, password: "pw", pid: proc.pid!, startedAt: Date.now(), startTime })
    const config = loadConfig({ HORDE_OPENCODE_DIRECTORY: dir, HORDE_OPENCODE_BIN: process.execPath } as NodeJS.ProcessEnv, { cores: 4 })
    await assert.rejects(Backend.start(config, store), /not responding\. Stop it with opencode_server stop/)
    assert.equal(alive(proc.pid!), true, "a timed-out probe is not proof of a dead server")
    assert.ok(store.server, "its record is kept for the explicit stop")
  })
})

describe("binary version", () => {
  test("is cached per binary path", (t) => {
    const counter = path.join(tmp(t), "calls")
    const file = fakeBin(t, `require("node:fs").appendFileSync(${JSON.stringify(counter)}, "x"); console.log("opencode v9.9.9")`)
    assert.equal(binaryVersion({ command: file, shell: false }), "9.9.9")
    assert.equal(binaryVersion({ command: file, shell: false }), "9.9.9")
    assert.equal(fs.readFileSync(counter, "utf8"), "x", "the second read comes from the cache")
  })

  test("gives up after 5 s", (t) => {
    const file = fakeBin(t, "setTimeout(() => {}, 10000)")
    const started = Date.now()
    assert.equal(binaryVersion({ command: file, shell: false }), undefined)
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 4_500 && elapsed < 8_000, `took ${elapsed}ms`)
  })

  test("is computed before the server lock is taken", async (t) => {
    const dir = tmp(t)
    const marker = path.join(dir, "version-read")
    const file = fakeBin(t, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x"); console.log("opencode v2.1.1")`)
    const srv = http.createServer((_req, res) => {
      res.statusCode = 401
      res.end("no")
    })
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()))
    t.after(() => srv.close())
    const port = (srv.address() as net.AddressInfo).port
    const record: ServerRecord = { url: `http://127.0.0.1:${port}`, password: "pw", pid: process.pid, startedAt: Date.now() }
    let sawMarker = false
    const store = {
      dir,
      get server() {
        return record
      },
      setServer() {
        // The probe rejects before any record is written.
      },
      async lock<T>(_name: string, fn: () => Promise<T>): Promise<T> {
        sawMarker = fs.existsSync(marker)
        return fn()
      },
    }
    const config = loadConfig({ HORDE_OPENCODE_DIRECTORY: dir, HORDE_OPENCODE_BIN: file } as NodeJS.ProcessEnv, { cores: 4 })
    await assert.rejects(Backend.start(config, store as unknown as Store), /answers but is not usable/)
    assert.equal(sawMarker, true, "the version was read before the lock callback ran")
  })
})

describe("server log", () => {
  test("an older 0644 log becomes 0600 when opened", { skip: process.platform === "win32" }, (t) => {
    const dir = tmp(t)
    const log = path.join(dir, "opencode-server.log")
    fs.writeFileSync(log, "old", { mode: 0o644 })
    fs.chmodSync(log, 0o644)
    const opened = openSharedLog(dir)
    fs.closeSync(opened.fd)
    assert.equal(fs.statSync(opened.path).mode & 0o777, 0o600)
    assert.equal(fs.readFileSync(opened.path, "utf8"), "")
  })
})

describe("subagent isolation", () => {
  test("retries a transient environment failure instead of skipping the session", async () => {
    let calls = 0
    const notes: string[] = []
    const ok = await retrySessionEnvironment(
      async () => {
        calls++
        if (calls < 3) throw new Error("transient")
      },
      (note) => notes.push(note),
      1,
    )
    assert.equal(ok, true)
    assert.equal(calls, 3)
    assert.deepEqual(notes, [])
  })

  test("notes a subagent whose environment still cannot be set after three retries", async () => {
    let calls = 0
    const notes: string[] = []
    const ok = await retrySessionEnvironment(
      async () => {
        calls++
        throw new Error("still failing")
      },
      (note) => notes.push(note),
      1,
    )
    assert.equal(ok, false)
    assert.equal(calls, 4, "the first attempt and three retries")
    assert.match(notes[0]!, /subagent session's environment could not be set after 3 retries/)
  })
})

describe("stopping a shared server", () => {
  test("stopPid escalates to SIGKILL after the grace period", { skip: process.platform === "win32" }, async (t) => {
    const ready = path.join(tmp(t), "ready")
    // Wait until the handler is installed, or the default SIGTERM would end it before the grace period.
    const proc = child(t, `require("node:fs").writeFileSync(${JSON.stringify(ready)}, "x"); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)`)
    await waitFor(() => fs.existsSync(ready))
    const started = Date.now()
    const pid = proc.pid!
    await stopPid(pid, "http://127.0.0.1:1")
    assert.ok(Date.now() - started >= 4_500, "SIGTERM alone would have left it alive")
    await waitFor(() => !alive(pid), 2_000)
  })
})

describe("running limit", () => {
  test("a cgroup v2 quota caps the CPUs used for the default limit", (t) => {
    const dir = tmp(t)
    const cpuMax = path.join(dir, "cpu.max")
    fs.writeFileSync(cpuMax, "100000 100000\n")
    assert.equal(cpuQuotaCores(cpuMax), 1)
    assert.equal(effectiveCores(16, cpuMax), 1)
    const repo = path.join(dir, "repo")
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true })
    const config = loadConfig({ HORDE_OPENCODE_DIRECTORY: repo } as NodeJS.ProcessEnv, { cpuMaxFile: cpuMax })
    assert.equal(config.maxRunning, defaultMaxRunning(1))
    assert.equal(config.maxRunning, 2)
    fs.writeFileSync(cpuMax, "max 100000\n")
    assert.equal(cpuQuotaCores(cpuMax), undefined, "no quota leaves the host count alone")
    assert.equal(effectiveCores(16, cpuMax), 16)
  })

  test("HORDE_OPENCODE_PASS_ENV drops empty entries", (t) => {
    const dir = tmp(t)
    fs.mkdirSync(path.join(dir, ".git"))
    const config = loadConfig({ HORDE_OPENCODE_DIRECTORY: dir, HORDE_OPENCODE_PASS_ENV: " A , , B , " } as NodeJS.ProcessEnv, { cores: 4 })
    assert.deepEqual(config.passEnv, ["A", "B"])
  })
})
