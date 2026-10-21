import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { after, describe, test } from "node:test"
import type { McpServer } from "@modelcontextprotocol/server"
import type { PermissionRequest } from "@opencode/client"
import { ASK_GUARDED_PROFILE, ASK_PROFILE, unsupportedSchema, validate } from "../src/ask.js"
import { passwordFilePath, stopServer } from "../src/backend.js"
import { type Config, inProject, loadConfig } from "../src/config.js"
import { profileRules, type Snapshot } from "../src/fleet.js"
import { makeHooks, permissionMessage } from "../src/hooks.js"
import { Store } from "../src/state.js"
import { attachCommand, renderSnapshot } from "../src/tools.js"
import { anchoredPattern, commitAll, createWorktree, dependencyLinks, excludeFromGit, removeWorktree, syncWorktree, workStart } from "../src/worktree.js"
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
    assert.deepEqual(await dependencyLinks(r), [".venv", "node_modules", "packages/a/node_modules"])
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
  })
})
