import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { after, describe, test } from "node:test"
import { scopeAvailable } from "@mcp-horde/core"
import type { McpServer } from "@modelcontextprotocol/server"
import type { PermissionRequest } from "@opencode/client"
import { ASK_GUARDED_PROFILE, ASK_PROFILE, unsupportedSchema, validate } from "../src/ask.js"
import { passwordFilePath, serverEnv, stopServer, versionMismatch } from "../src/backend.js"
import { type Config, inProject, loadConfig } from "../src/config.js"
import { profileRules, type Snapshot } from "../src/fleet.js"
import { makeHooks, permissionMessage } from "../src/hooks.js"
import { News } from "../src/news.js"
import { Store } from "../src/state.js"
import { attachCommand, renderSnapshot } from "../src/tools.js"
import {
  anchoredPattern,
  commitAll,
  createWorktree,
  dependencyLinks,
  excludeFromGit,
  removeWorktree,
  repoRoot,
  sweepWorktrees,
  syncWorktree,
  workStart,
} from "../src/worktree.js"
import { connect, git, pkg } from "./harness.js"

const tmps: string[] = []
const tmpDir = () => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "horde-fix-")))
  tmps.push(d)
  return d
}
after(() => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true })
})

const repo = () => {
  const dir = path.join(tmpDir(), "repo")
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, "README.md"), "# r\n")
  git(dir, "init", "-q")
  git(dir, "add", ".")
  git(dir, "commit", "-qm", "init")
  return dir
}

const perm: PermissionRequest = { id: "per_1", sessionID: "ses_x", action: "shell", resources: ["npm install x"], save: ["npm install *"] }

describe("permission requests", () => {
  test("the dialog and the snapshot show what 'always' saves", () => {
    assert.match(permissionMessage("a", "/w", perm), /"Always" saves: npm install \*/)
    const snap = {
      id: "ses_x",
      state: "needs_input",
      steps: 0,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      limits: {},
      policy: "ask",
      questionPolicy: "ask",
      directory: "/w",
      children: [],
      pending: { permissions: [perm], questions: [] },
      unreported: [],
    } as unknown as Snapshot
    assert.match(renderSnapshot(snap), /needs permission per_1: shell \["npm install x"\] \(always saves \["npm install \*"\]\)/)
  })

  test("only an explicit once/always approves; anything else goes to the caller", async () => {
    let answer: unknown
    const server = {
      server: {
        elicitInput: async (req: { message: string }) => {
          assert.match(req.message, /Always" saves/)
          return answer
        },
        getClientCapabilities: () => ({ elicitation: {} }),
      },
    } as unknown as McpServer
    const hooks = makeHooks(server, { elicitTimeoutMs: 1000, channel: false } as Config)
    const ask = (a: unknown) => {
      answer = a
      return hooks.askPermission({ id: "ses_x", directory: "/w" } as Snapshot, perm, new AbortController().signal)
    }
    assert.equal((await ask({ action: "accept", content: { decision: "once" } }))?.reply, "once")
    assert.equal((await ask({ action: "accept", content: { decision: "always" } }))?.reply, "always")
    assert.deepEqual(await ask({ action: "accept", content: { decision: "reject", message: "no" } }), { reply: "reject", message: "no" })
    assert.equal(await ask({ action: "accept", content: {} }), undefined)
    assert.equal(await ask({ action: "accept", content: { decision: "yes please" } }), undefined)
    assert.equal(await ask({ action: "cancel" }), undefined)
    assert.equal((await ask({ action: "decline" }))?.reply, "reject")
  })
})

describe("ask schemas", () => {
  test("unsupported keywords are rejected, common combinators work", () => {
    assert.deepEqual(unsupportedSchema({ type: "object", properties: { a: { enum: ["x"] } }, required: ["a"] }), [])
    assert.match(unsupportedSchema({ $ref: "#/x" }).join("\n"), /\$ref.*not supported/)
    assert.match(unsupportedSchema({ type: "array", items: [{ type: "string" }] }).join("\n"), /tuple/)
    assert.match(unsupportedSchema({ properties: { a: { not: {} } } }).join("\n"), /\$\.properties\.a\.not/)
    assert.match(unsupportedSchema({ pattern: "(" }).join("\n"), /not a valid regular expression/)
    assert.deepEqual(validate("b", { anyOf: [{ const: "a" }, { const: "b" }] }), [])
    assert.equal(validate("c", { anyOf: [{ const: "a" }, { const: "b" }] }).length, 1)
    assert.match(validate(2, { oneOf: [{ type: "integer" }, { type: "number" }] }).join(), /matches 2/)
    assert.match(validate("ab", { pattern: "^a$" }).join(), /must match/)
    assert.deepEqual(validate({ a: 1 }, { allOf: [{ required: ["a"] }, { properties: { a: { type: "integer" } } }] }), [])
  })

  test("ask sessions deny every tool; the guarded profile allows read-only tools after the catch-all", () => {
    // The last matching rule wins: the catch-all first, then the exceptions.
    assert.deepEqual(profileRules(ASK_PROFILE), [{ action: "*", resource: "*", effect: "deny" }])
    const guarded = profileRules(ASK_GUARDED_PROFILE)
    assert.deepEqual(guarded[0], { action: "*", resource: "*", effect: "deny" })
    assert.deepEqual(
      guarded.slice(1).map((r) => `${r.action}:${r.effect}`),
      ["read:allow", "grep:allow", "glob:allow"],
    )
  })

  test("profiles become session rules: tool switches first, OpenCode 1 action names renamed", () => {
    assert.deepEqual(profileRules({ tools: { bash: false, webfetch: true }, permission: { edit: { "*": "deny", "src/**": "allow" }, task: "ask" } }), [
      { action: "shell", resource: "*", effect: "deny" },
      { action: "webfetch", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: "src/**", effect: "allow" },
      { action: "subagent", resource: "*", effect: "ask" },
    ])
    assert.throws(() => profileRules({ permission: { edit: "maybe" } }), /allow, deny or ask/)
  })
})

describe("server support", () => {
  test("the attach command quotes the password file, with a PowerShell variant", () => {
    assert.equal(attachCommand("http://h:1", "/a b/it's", "opencode", "linux"), `OPENCODE_SERVER_PASSWORD="$(cat '/a b/it'\\''s')" opencode attach http://h:1`)
    assert.match(
      attachCommand("http://h:1", "C:\\x y\\pw", "me", "win32"),
      /^\$env:OPENCODE_SERVER_USERNAME = 'me'; \$env:OPENCODE_SERVER_PASSWORD = Get-Content -Raw 'C:\\x y\\pw'; opencode attach/,
    )
  })

  test("password files are per server", () => {
    assert.notEqual(passwordFilePath("/s", "shared", "http://127.0.0.1:1"), passwordFilePath("/s", "private", "http://127.0.0.1:1"))
    assert.notEqual(passwordFilePath("/s", "shared", "http://127.0.0.1:1"), passwordFilePath("/s", "shared", "http://127.0.0.1:2"))
  })

  test("the backend environment is an allowlist: secrets and horde/claude vars are dropped, auth and opts survive", () => {
    const env = serverEnv(
      { username: "me", password: "server-pw", passEnv: ["*_API_KEY"] },
      {
        PATH: "/bin",
        HOME: "/home/u",
        USER: "u",
        LOGNAME: "u",
        SHELL: "/bin/bash",
        LANG: "C",
        LC_ALL: "C",
        TZ: "UTC",
        TMPDIR: "/tmp",
        XDG_CONFIG_HOME: "/x",
        HTTP_PROXY: "http://p",
        https_proxy: "http://p",
        NO_PROXY: "localhost",
        SSL_CERT_FILE: "/ca",
        OPENCODE_SESSION_ID: "ses_x",
        OPENCODE_SERVER_PASSWORD: "parent-pw",
        OPENCODE_SERVER_USERNAME: "parent-user",
        DEEPSEEK_API_KEY: "dk",
        ANTHROPIC_API_KEY: "ak",
        CLAUDE_CODE_MESSAGING_TOKEN: "cc",
        CLAUDECODE: "1",
        HORDE_OPENCODE_STATE_DIR: "/h",
        MCP_SERVER: "mcp",
        AUDIT_CANARY_SECRET: "canary",
        SOME_RANDOM_VAR: "x",
      } as NodeJS.ProcessEnv,
      "linux",
    )
    // The fixed allowlist and opts survive.
    assert.equal(env.PATH, "/bin")
    assert.equal(env.HOME, "/home/u")
    assert.equal(env.LC_ALL, "C")
    assert.equal(env.OPENCODE_SESSION_ID, "ses_x")
    assert.equal(env.DEEPSEEK_API_KEY, "dk")
    assert.equal(env.ANTHROPIC_API_KEY, "ak")
    // Auth is the server's own values, never the parent's.
    assert.equal(env.OPENCODE_SERVER_USERNAME, "me")
    assert.equal(env.OPENCODE_SERVER_PASSWORD, "server-pw")
    // Everything else is dropped, secret-looking or not.
    assert.equal(env.CLAUDE_CODE_MESSAGING_TOKEN, undefined)
    assert.equal(env.CLAUDECODE, undefined)
    assert.equal(env.HORDE_OPENCODE_STATE_DIR, undefined)
    assert.equal(env.MCP_SERVER, undefined)
    assert.equal(env.AUDIT_CANARY_SECRET, undefined)
    assert.equal(env.SOME_RANDOM_VAR, undefined)
  })

  test("the version mismatch warning names both versions and is absent when they match or are unknown", () => {
    assert.equal(
      versionMismatch("2.1.4", "2.1.1"),
      "the shared OpenCode server runs 2.1.4, the configured binary is 2.1.1; opencode_server stop then any call restarts it",
    )
    assert.equal(versionMismatch("2.1.1", "2.1.1"), undefined)
    assert.equal(versionMismatch(undefined, "2.1.1"), undefined)
    assert.equal(versionMismatch("2.1.4", undefined), undefined)
  })

  test("agents belong to the session's project by directory or worktree checkout", () => {
    assert.ok(inProject({ directory: "/p/sub" }, "/p"))
    assert.ok(inProject({ directory: "/wt/x", worktree: { repo: "/p" } }, "/p"))
    assert.ok(!inProject({ directory: "/other" }, "/p"))
    assert.ok(!inProject({ directory: "/p2" }, "/p"))
  })

  test("stopping a recorded shared server that hangs kills it instead of just forgetting it", {
    skip: process.platform === "win32" ? "POSIX process groups" : false,
  }, async () => {
    const dir = tmpDir()
    const store = new Store(dir)
    // Accepts connections, never answers: the health probe times out.
    const sockets: net.Socket[] = []
    const hung = net.createServer((s) => void sockets.push(s))
    await new Promise<void>((r) => hung.listen(0, "127.0.0.1", () => r()))
    const port = (hung.address() as net.AddressInfo).port
    const proc = spawn("sleep", ["300"], { detached: true, stdio: "ignore" })
    try {
      store.setServer({ url: `http://127.0.0.1:${port}`, password: "pw", pid: proc.pid!, startedAt: Date.now() })
      const exited = new Promise((r) => proc.once("exit", r))
      const text = await stopServer(loadConfig({ HORDE_OPENCODE_STATE_DIR: dir } as NodeJS.ProcessEnv), store)
      assert.match(text, /was not responding, so it was killed/)
      await exited
      assert.equal(store.server, undefined)
    } finally {
      for (const s of sockets) s.destroy()
      hung.close()
      try {
        process.kill(-proc.pid!, "SIGKILL")
      } catch {
        // gone
      }
    }
  })

  test("the supervisor stops OpenCode's whole process group", { skip: process.platform === "win32" ? "POSIX process groups" : false }, async () => {
    const dir = tmpDir()
    const pidFile = path.join(dir, "grandchild")
    const sup = spawn(
      process.execPath,
      ["--import", "tsx", path.join(pkg, "src/supervisor.ts"), String(process.pid), "sh", "-c", `sleep 300 & echo $! > '${pidFile}'; wait`],
      { cwd: pkg, stdio: ["pipe", "ignore", "inherit"] },
    )
    try {
      const deadline = Date.now() + 20_000
      while (!fs.existsSync(pidFile) || !fs.readFileSync(pidFile, "utf8").trim()) {
        if (Date.now() > deadline) throw new Error("the grandchild never started")
        await new Promise((r) => setTimeout(r, 100))
      }
      const grandchild = Number(fs.readFileSync(pidFile, "utf8").trim())
      const exited = new Promise((r) => sup.once("exit", r))
      sup.kill("SIGTERM")
      await exited
      const gone = Date.now() + 5_000
      let alive = true
      while (alive && Date.now() < gone) {
        try {
          process.kill(grandchild, 0)
          await new Promise((r) => setTimeout(r, 100))
        } catch {
          alive = false
        }
      }
      assert.equal(alive, false, "the tool process OpenCode started was stopped too")
    } finally {
      sup.kill("SIGKILL")
    }
  })

  test("the shared backend records the opencode process and runs it in a horde-opencode scope", {
    skip: process.platform !== "linux" ? "Linux systemd user scopes" : !scopeAvailable() ? "no systemd user manager" : false,
    timeout: 180_000,
  }, async () => {
    const dir = tmpDir()
    const h = await connect({
      HORDE_OPENCODE_SERVER: "shared",
      HORDE_OPENCODE_DIRECTORY: repo(),
      HORDE_OPENCODE_STATE_DIR: path.join(dir, "state"),
    })
    let pid = 0
    try {
      const info = await h.call("opencode_server", { action: "info" })
      pid = Number(info.match(/pid (\d+)/)![1])
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean)
      assert.ok(
        cmdline.some((arg) => /opencode/.test(arg)),
        `recorded pid ${pid} is opencode: ${cmdline.join(" ")}`,
      )
      assert.ok(cmdline.includes("serve"), cmdline.join(" "))
      const cgroup = fs.readFileSync(`/proc/${pid}/cgroup`, "utf8").trim()
      assert.match(cgroup, /\/horde-opencode-\d+\.scope$/)
      assert.notEqual(cgroup, fs.readFileSync("/proc/self/cgroup", "utf8").trim(), "not the test session's scope")
    } finally {
      await h.call("opencode_server", { action: "stop" }).catch(() => undefined)
      await h.close()
    }
  })

  test("a bad configuration does not stop the MCP handshake; tools report it", async () => {
    const dir = tmpDir()
    const h = await connect({ HORDE_OPENCODE_PERMISSIONS: "maybe", HORDE_OPENCODE_STATE_DIR: path.join(dir, "state"), HORDE_OPENCODE_DIRECTORY: dir })
    try {
      await assert.rejects(h.call("opencode_status"), /misconfigured: HORDE_OPENCODE_PERMISSIONS must be one of/)
      await assert.rejects(h.call("opencode_server", { action: "info" }), /misconfigured/)
    } finally {
      await h.close()
    }
  })
})

describe("worktree fixes", () => {
  test("exclude patterns are anchored at the directory's place in the repository", async () => {
    assert.equal(anchoredPattern("", ".opencode/x"), "/.opencode/x")
    assert.equal(anchoredPattern("sub/dir/", "/.opencode/x"), "/sub/dir/.opencode/x")
    assert.equal(anchoredPattern("a*b/", "x"), "/a\\*b/x")
    const r = repo()
    const sub = path.join(r, "pkg", "app")
    fs.mkdirSync(path.join(sub, ".opencode", "agent"), { recursive: true })
    fs.writeFileSync(path.join(sub, ".opencode", "agent", "horde-a.md"), "x")
    fs.mkdirSync(path.join(r, ".opencode", "agent"), { recursive: true })
    fs.writeFileSync(path.join(r, ".opencode", "agent", "horde-top.md"), "x")
    await excludeFromGit(sub, ".opencode/agent/horde-*.md")
    const status = git(r, "status", "--porcelain", "--untracked-files=all")
    assert.doesNotMatch(status, /pkg\/app\/\.opencode/)
    assert.match(status, /^\?\? \.opencode\/agent\/horde-top\.md$/m, "only the directory's own files are excluded")
  })

  test("linked paths are not carried into the baseline; branch deletion is reported truthfully", async () => {
    const r = repo()
    fs.mkdirSync(path.join(r, "data"))
    fs.writeFileSync(path.join(r, "data", "big.bin"), "x")
    fs.writeFileSync(path.join(r, "notes.txt"), "carried")
    const { worktree } = await createWorktree(r, "lnk", { rootDir: path.join(tmpDir(), "wt"), includeUncommitted: true, link: ["data"] })
    assert.ok(worktree.baseline)
    const files = git(worktree.root, "show", "--name-only", "--format=", worktree.baseline!)
    assert.match(files, /notes\.txt/)
    assert.doesNotMatch(files, /data\//)
    // A branch that is checked out elsewhere cannot be deleted: say so.
    const other = path.join(tmpDir(), "other")
    git(r, "worktree", "remove", "--force", worktree.root)
    git(r, "worktree", "add", other, worktree.branch)
    const text = await removeWorktree({ ...worktree, root: path.join(tmpDir(), "gone") }, "lnk", true)
    assert.match(text, /could not delete branch horde\/lnk/)
    assert.doesNotMatch(text, /deleted branch/)
  })

  test("secret-looking untracked files are not carried into the baseline", async () => {
    const r = repo()
    fs.writeFileSync(path.join(r, ".env"), "TOKEN=super-secret\n")
    fs.writeFileSync(path.join(r, ".env.example"), "TOKEN=\n")
    fs.writeFileSync(path.join(r, "notes.txt"), "carried")
    const { worktree, notes } = await createWorktree(r, "secret", {
      rootDir: path.join(tmpDir(), "wt"),
      includeUncommitted: true,
      link: [],
    })
    assert.equal(fs.existsSync(path.join(worktree.root, ".env")), false)
    assert.equal(fs.existsSync(path.join(worktree.root, ".env.example")), true)
    assert.match(notes.join("\n"), /secret-looking untracked file/)
    const files = git(worktree.root, "show", "--name-only", "--format=", worktree.baseline!)
    assert.match(files, /\.env\.example/)
    assert.doesNotMatch(files, /^\.env$/m)
  })

  test("sync refuses a branch with merge commits instead of dropping merge-only changes", async () => {
    const r = repo()
    const { worktree } = await createWorktree(r, "merges", {
      rootDir: path.join(tmpDir(), "wt"),
      includeUncommitted: false,
      link: [],
    })
    git(worktree.root, "checkout", "-q", "-b", "side")
    fs.writeFileSync(path.join(worktree.root, "side.txt"), "s\n")
    git(worktree.root, "add", "-A")
    git(worktree.root, "commit", "-qm", "side")
    git(worktree.root, "checkout", "-q", worktree.branch)
    git(worktree.root, "merge", "--no-ff", "-qm", "merge side", "side")
    fs.writeFileSync(path.join(r, "main.txt"), "m\n")
    git(r, "add", "-A")
    git(r, "commit", "-qm", "main")
    await assert.rejects(syncWorktree(worktree, "merges"), /merge commits/)
  })

  test("sync identifies the baseline by position, not by a message a worker can reuse", async () => {
    const r = repo()
    fs.writeFileSync(path.join(r, "notes.txt"), "carried\n")
    const { worktree } = await createWorktree(r, "baseline", {
      rootDir: path.join(tmpDir(), "wt"),
      includeUncommitted: true,
      link: [],
    })
    assert.ok(worktree.baseline)
    const subject = git(worktree.root, "log", "-1", "--format=%s", worktree.baseline!)
    fs.writeFileSync(path.join(worktree.root, "work.txt"), "w\n")
    git(worktree.root, "add", "-A")
    git(worktree.root, "commit", "-qm", "the work")
    git(worktree.root, "commit", "--allow-empty", "-qm", subject)
    fs.writeFileSync(path.join(r, "main.txt"), "m\n")
    git(r, "add", "main.txt")
    git(r, "commit", "-qm", "main")
    const synced = (await syncWorktree(worktree, "baseline")).worktree!
    const start = workStart(synced)
    assert.equal(git(synced.root, "rev-list", "--count", `${start}..HEAD`), "2")
    assert.match(git(synced.root, "show", "--name-only", "--format=", start), /notes\.txt/)
  })

  test("sync keeps the baseline when the target already has the agent's patch", async () => {
    const r = repo()
    fs.writeFileSync(path.join(r, "notes.txt"), "carried\n")
    const { worktree } = await createWorktree(r, "replayed", {
      rootDir: path.join(tmpDir(), "wt"),
      includeUncommitted: true,
      link: [],
    })
    assert.ok(worktree.baseline)
    fs.writeFileSync(path.join(worktree.root, "work.txt"), "w\n")
    git(worktree.root, "add", "-A")
    git(worktree.root, "commit", "-qm", "the work")
    fs.writeFileSync(path.join(r, "work.txt"), "w\n")
    git(r, "add", "work.txt")
    git(r, "commit", "-qm", "the same work")
    const synced = (await syncWorktree(worktree, "replayed")).worktree!
    const start = workStart(synced)
    assert.match(git(synced.root, "show", "--name-only", "--format=", start), /notes\.txt/)
    assert.equal(git(synced.root, "diff", "--name-only", start, "HEAD"), "")
  })

  test("commits need both user.name and user.email, else the fallback identity is used", async () => {
    const r = repo()
    git(r, "config", "user.email", "only@mail")
    git(r, "config", "user.name", "")
    const root = path.join(tmpDir(), "wt")
    const { worktree } = await createWorktree(r, "ident", { rootDir: root, includeUncommitted: false, link: [] })
    fs.writeFileSync(path.join(worktree.root, "f.txt"), "x")
    assert.match((await commitAll(worktree, "work")) ?? "", /committed/)
    assert.equal(execFileSync("git", ["log", "-1", "--format=%an"], { cwd: worktree.root }).toString().trim(), "mcp-horde")
  })

  test("dependencyLinks finds ignored dependency directories at any depth and nothing else", async () => {
    const r = repo()
    fs.writeFileSync(path.join(r, ".gitignore"), "node_modules/\n.venv/\nvenv/\ndist/\n")
    for (const dir of ["node_modules", "packages/a/node_modules", ".venv", "dist"]) {
      fs.mkdirSync(path.join(r, dir), { recursive: true })
      fs.writeFileSync(path.join(r, dir, "keep.txt"), "x")
    }
    fs.mkdirSync(path.join(r, "tracked", "node_modules"), { recursive: true })
    fs.writeFileSync(path.join(r, "tracked", "node_modules", "keep.txt"), "x")
    git(r, "add", ".gitignore")
    git(r, "add", "-f", "tracked/node_modules/keep.txt")
    git(r, "commit", "-qm", "ignore deps")
    assert.deepEqual(await dependencyLinks(r), { links: [".venv", "node_modules", "packages/a/node_modules"], notes: [] })
  })

  test("dependencyLinks leaves out directories that point back into the checkout", async () => {
    const r = repo()
    fs.writeFileSync(path.join(r, ".gitignore"), "node_modules/\n.venv/\n")
    fs.mkdirSync(path.join(r, "packages", "b"), { recursive: true })
    fs.writeFileSync(path.join(r, "packages", "b", "package.json"), "{}\n")
    git(r, "add", ".")
    git(r, "commit", "-qm", "workspace")
    // npm workspaces: node_modules/@s/b is a link to packages/b; another package's own deps are fine.
    fs.mkdirSync(path.join(r, "node_modules", "@s"), { recursive: true })
    fs.mkdirSync(path.join(r, "node_modules", "left-pad"))
    fs.symlinkSync(path.join(r, "packages", "b"), path.join(r, "node_modules", "@s", "b"), "junction")
    fs.mkdirSync(path.join(r, "packages", "b", "node_modules", "dep"), { recursive: true })
    // uv/pip editable install: a .pth naming the checkout's sources.
    const site = path.join(r, ".venv", "lib", "python3.12", "site-packages")
    fs.mkdirSync(site, { recursive: true })
    fs.writeFileSync(path.join(site, "distutils-precedence.pth"), "import os\n")
    fs.writeFileSync(path.join(site, "_app.pth"), `${fs.realpathSync(r)}/src\n`)
    const { links, notes } = await dependencyLinks(r)
    assert.deepEqual(links, [])
    assert.match(
      notes.join("\n"),
      /^\.venv not linked: it has an editable install of this checkout \(_app\.pth\), which the worktree must take from its own checkout; install dependencies in horde\.json "workers\.setup"$/m,
    )
    assert.match(notes.join("\n"), /^node_modules not linked: its @s\/b is the workspace package packages\/b, /m)
    assert.match(notes.join("\n"), /^packages\/b\/node_modules not linked: part of the same workspace install as node_modules$/m)
    // A path that only starts like the checkout's is someone else's.
    fs.writeFileSync(path.join(site, "_app.pth"), `${fs.realpathSync(r)}-other/src\n`)
    assert.ok((await dependencyLinks(r)).links.includes(".venv"))
  })

  test("createWorktree at a commit creates the worktree there instead of HEAD", async () => {
    const r = repo()
    fs.writeFileSync(path.join(r, "one.txt"), "one\n")
    git(r, "add", ".")
    git(r, "commit", "-qm", "one")
    const first = git(r, "rev-parse", "HEAD")
    fs.writeFileSync(path.join(r, "two.txt"), "two\n")
    git(r, "add", ".")
    git(r, "commit", "-qm", "two")
    const { worktree } = await createWorktree(r, "old", { rootDir: path.join(tmpDir(), "wt"), includeUncommitted: false, at: first })
    assert.equal(worktree.base, first)
    assert.equal(git(worktree.root, "rev-parse", "HEAD"), first)
    assert.ok(fs.existsSync(path.join(worktree.root, "one.txt")))
    assert.ok(!fs.existsSync(path.join(worktree.root, "two.txt")), "the later commit is not in the worktree")
  })

  test("createWorktree links dependency directories by default and only those given explicitly", async () => {
    const r = repo()
    fs.writeFileSync(path.join(r, ".gitignore"), "node_modules/\n.venv/\n")
    git(r, "add", ".gitignore")
    git(r, "commit", "-qm", "ignore deps")
    fs.mkdirSync(path.join(r, "node_modules", "pkg"), { recursive: true })
    fs.writeFileSync(path.join(r, "node_modules", "pkg", "index.js"), "module.exports = 1\n")
    fs.mkdirSync(path.join(r, ".venv"), { recursive: true })
    fs.writeFileSync(path.join(r, ".venv", "pyvenv.cfg"), "x\n")
    const rootDir = path.join(tmpDir(), "wt")
    const { worktree } = await createWorktree(r, "deps", { rootDir, includeUncommitted: false })
    for (const rel of ["node_modules", ".venv"]) {
      const dst = path.join(worktree.root, rel)
      assert.ok(fs.lstatSync(dst).isSymbolicLink(), `${rel} is a symlink into the main checkout`)
      assert.equal(fs.realpathSync(dst), fs.realpathSync(path.join(r, rel)))
    }
    const bare = await createWorktree(r, "no-deps", { rootDir, includeUncommitted: false, link: [] })
    assert.equal(fs.existsSync(path.join(bare.worktree.root, "node_modules")), false)
    assert.equal(fs.existsSync(path.join(bare.worktree.root, ".venv")), false)
    // A setup installs into the worktree; through a link it would write into the checkout.
    const setUp = await createWorktree(r, "setup", { rootDir, includeUncommitted: false, setup: "mkdir node_modules && touch node_modules/own" })
    assert.ok(!fs.lstatSync(path.join(setUp.worktree.root, "node_modules")).isSymbolicLink())
    assert.ok(fs.existsSync(path.join(r, "node_modules", "pkg", "index.js")), "the checkout's node_modules is untouched")
  })

  test("repoRoot refuses an empty, relative or missing top level", async () => {
    const r = repo()
    const sub = path.join(r, "pkg")
    fs.mkdirSync(sub)
    assert.equal(await repoRoot(sub), fs.realpathSync.native(r), "a real checkout still resolves")
    await assert.rejects(repoRoot(""), /not inside one/)
    await assert.rejects(
      repoRoot(r, async () => ""),
      /not inside one/,
    )
    await assert.rejects(
      repoRoot(r, async () => "relative/path"),
      /not inside one/,
    )
    await assert.rejects(
      repoRoot(r, async () => path.join(r, "missing")),
      /not inside one/,
    )
  })

  test("a failure after git worktree add removes the worktree and its branch", async () => {
    const r = repo()
    const rootDir = path.join(tmpDir(), "wt")
    await assert.rejects(createWorktree(r, "leak", { rootDir, includeUncommitted: false, link: [], setup: "exit 1" }), /setup/)
    const left = fs.existsSync(rootDir) ? fs.readdirSync(rootDir, { recursive: true }).map(String) : []
    assert.ok(!left.some((p) => p.includes("leak")), `no worktree left: ${left.join(", ")}`)
    assert.equal(git(r, "branch", "--list", "horde/leak"), "")
    assert.doesNotMatch(git(r, "worktree", "list"), /horde\/leak/)
  })

  test("removeWorktree deletes the per-repository folder once it is empty", async () => {
    const r = repo()
    const rootDir = path.join(tmpDir(), "wt")
    const { worktree } = await createWorktree(r, "empty", { rootDir, includeUncommitted: false, link: [] })
    const folder = path.dirname(worktree.root)
    assert.ok(fs.existsSync(folder))
    await removeWorktree(worktree, "empty", true)
    assert.equal(fs.existsSync(worktree.root), false)
    assert.equal(fs.existsSync(folder), false, "the emptied per-repository folder is deleted")
  })

  test("the start-up sweep removes unregistered, unreferenced worktree folders", async () => {
    const r = repo()
    const rootDir = path.join(tmpDir(), "wt")
    const { worktree } = await createWorktree(r, "keep", { rootDir, includeUncommitted: false, link: [] })
    const folder = path.dirname(worktree.root)
    // A container can recreate a removed worktree's mount sources as plain directories.
    const leftover = path.join(folder, "t-0164")
    fs.mkdirSync(path.join(leftover, "infrastructure", "nats", "nats.conf"), { recursive: true })
    const empty = path.join(rootDir, "gone-12345678")
    fs.mkdirSync(empty)
    const lines: string[] = []
    const swept = await sweepWorktrees(rootDir, [{ id: "ses_live", worktree }], (line) => lines.push(line))
    assert.ok(fs.existsSync(worktree.root), "a live record keeps its worktree")
    assert.equal(fs.existsSync(leftover), false)
    assert.equal(fs.existsSync(empty), false)
    assert.equal(fs.existsSync(folder), true, "the folder still holds a live worktree")
    assert.deepEqual(swept.gone, [])
    assert.ok(
      lines.some((l) => l.includes(leftover)),
      lines.join("\n"),
    )
    assert.ok(
      lines.some((l) => l.includes(empty)),
      lines.join("\n"),
    )
  })

  test("the sweep reports a record whose worktree directory is gone and prunes its registration", async () => {
    const r = repo()
    const rootDir = path.join(tmpDir(), "wt")
    const { worktree } = await createWorktree(r, "gone", { rootDir, includeUncommitted: false, link: [] })
    fs.rmSync(worktree.root, { recursive: true, force: true })
    assert.match(git(r, "worktree", "list"), /horde\/gone/, "git still registers the vanished worktree")
    const swept = await sweepWorktrees(rootDir, [{ id: "ses_gone", worktree }])
    assert.deepEqual(
      swept.gone.map((g) => g.id),
      ["ses_gone"],
    )
    assert.match(swept.gone[0]?.error ?? "", /worktree directory .* is gone/)
    assert.doesNotMatch(git(r, "worktree", "list"), /horde\/gone/)
    assert.equal(fs.existsSync(path.dirname(worktree.root)), false, "the emptied folder is gone too")
  })

  test("the worktree root, repository folder and worktree are mode 0700", { skip: process.platform === "win32" ? "POSIX modes" : false }, async () => {
    const r = repo()
    const rootDir = path.join(tmpDir(), "wt")
    fs.mkdirSync(rootDir, { recursive: true, mode: 0o755 })
    fs.chmodSync(rootDir, 0o755)
    const { worktree } = await createWorktree(r, "mode", { rootDir, includeUncommitted: false, link: [] })
    const mode = (p: string) => fs.statSync(p).mode & 0o777
    assert.equal(mode(rootDir), 0o700)
    assert.equal(mode(path.dirname(worktree.root)), 0o700)
    assert.equal(mode(worktree.root), 0o700)
  })
})

describe("news file fixes", () => {
  const waitFor = async (file: string) => {
    for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 10))
    return JSON.parse(fs.readFileSync(file, "utf8")) as { at: number }
  }

  test("an unchanged list is rewritten on the heartbeat while an outcome waits", async () => {
    const dir = tmpDir()
    const news = new News(dir, "heartbeat", { heartbeatMs: 50 })
    const file = path.join(dir, "news", "heartbeat.json")
    try {
      news.update([{ id: "t-1", title: "waits", kind: "finished" }], [])
      const first = await waitFor(file)
      await new Promise((r) => setTimeout(r, 150))
      const second = await waitFor(file)
      assert.ok(second.at > first.at, `at was refreshed: ${first.at} -> ${second.at}`)
    } finally {
      await news.remove()
    }
  })

  test("a session id that is not a plain file name writes no news file", async () => {
    const dir = tmpDir()
    for (const session of ["../escape", "a/b", ".", "..", "x.json"]) {
      new News(dir, session).update([{ id: "t-1", title: "nope", kind: "finished" }], [])
    }
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(fs.existsSync(path.join(dir, "news")), false)
    const valid = new News(dir, "plain_name-1")
    valid.update([{ id: "t-1", title: "yes", kind: "finished" }], [])
    await waitFor(path.join(dir, "news", "plain_name-1.json"))
    await valid.remove()
  })
})
