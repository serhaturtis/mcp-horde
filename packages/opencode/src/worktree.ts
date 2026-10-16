import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 })
  return stdout.trim()
}

/** Run git with data on stdin (execFile cannot do that). */
function gitWithInput(cwd: string, args: string[], input: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["pipe", "ignore", "pipe"] })
    let err = ""
    child.stderr.on("data", (c: Buffer) => (err += c.toString()))
    child.on("error", reject)
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} failed: ${err.trim()}`))))
    child.stdin.end(input)
  })
}

export interface Worktree {
  /** The agent's working directory (inside the worktree). */
  path: string
  /** Root of the worktree checkout. */
  root: string
  branch: string
  /** Commit the branch was created from. */
  base: string
  /** Commit snapshotting changes carried over from the main checkout; the agent's own work starts after it. */
  baseline?: string
  /** Paths symlinked from the main checkout; never committed. */
  links?: string[]
  /** Root of the main checkout. */
  repo: string
}

/** Where the agent's own work starts. */
export function workStart(wt: Worktree): string {
  return wt.baseline ?? wt.base
}

const IDENTITY = ["-c", "user.name=mcp-horde", "-c", "user.email=mcp-horde@localhost"]

export interface WorktreeOptions {
  /** Directory that holds all worktrees. */
  rootDir: string
  /** Carry over uncommitted (staged, unstaged and untracked) changes from the main checkout. */
  includeUncommitted: boolean
  /** Paths (relative to the repo root) to symlink from the main checkout, e.g. node_modules. */
  link: string[]
  /** Shell command run in the new worktree before the agent starts, e.g. "npm ci". */
  setup?: string
}

export async function repoRoot(directory: string): Promise<string> {
  try {
    return await git(directory, "rev-parse", "--show-toplevel")
  } catch {
    throw new Error(`isolation "worktree" needs a git repository, but ${directory} is not inside one`)
  }
}

/**
 * Create an isolated worktree on a new branch `horde/<name>`. Worktrees live
 * outside the repository (under rootDir) so they never appear in it.
 */
export async function createWorktree(directory: string, name: string, opts: WorktreeOptions): Promise<{ worktree: Worktree; notes: string[] }> {
  const repo = await repoRoot(directory)
  const notes: string[] = []
  const slug = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "agent"
  const repoKey = `${path.basename(repo)}-${createHash("sha1").update(repo).digest("hex").slice(0, 8)}`
  const base = await git(repo, "rev-parse", "HEAD").catch(() => {
    throw new Error(`isolation "worktree" needs at least one commit in ${repo}`)
  })
  let root = path.join(opts.rootDir, repoKey, slug)
  let branch = `horde/${slug}`
  for (let i = 2; (await exists(root)) || (await branchExists(repo, branch)); i++) {
    root = path.join(opts.rootDir, repoKey, `${slug}-${i}`)
    branch = `horde/${slug}-${i}`
  }
  await fs.mkdir(path.dirname(root), { recursive: true })
  await git(repo, "worktree", "add", "-b", branch, root, base)
  // git reports resolved paths (e.g. /private/var on macOS), so compare like with like.
  const sub = path.relative(await fs.realpath(repo), await fs.realpath(directory))
  const worktree: Worktree = { path: path.join(root, sub), root, branch, base, repo, links: opts.link }

  try {
    if (opts.includeUncommitted) {
      const carried = await carryUncommitted(repo, root)
      if (carried) {
        // Snapshot them so diffs and merges only contain the agent's own work.
        await git(root, "add", "-A")
        await git(
          root,
          ...((await hasIdentity(root)) ? [] : IDENTITY),
          "commit",
          "-q",
          "--no-verify",
          "-m",
          "horde: uncommitted changes carried over from the main checkout",
        )
        worktree.baseline = await git(root, "rev-parse", "HEAD")
        notes.push(carried)
      }
    }
    for (const rel of opts.link) {
      const src = path.join(repo, rel)
      const dst = path.join(root, rel)
      if (!(await exists(src))) {
        notes.push(`link: ${rel} does not exist in the main checkout; skipped`)
        continue
      }
      await fs.rm(dst, { recursive: true, force: true })
      await fs.mkdir(path.dirname(dst), { recursive: true })
      const isDir = (await fs.stat(src)).isDirectory()
      await fs.symlink(src, dst, isDir ? (process.platform === "win32" ? "junction" : "dir") : "file")
      notes.push(`linked ${rel} from the main checkout`)
    }
    if (opts.setup) notes.push(await runSetup(opts.setup, worktree.path))
  } catch (err) {
    await git(repo, "worktree", "remove", "--force", root).catch(() => undefined)
    await git(repo, "branch", "-D", branch).catch(() => undefined)
    throw err
  }
  return { worktree, notes }
}

async function carryUncommitted(repo: string, root: string): Promise<string | undefined> {
  const parts: string[] = []
  const { stdout: patch } = await exec("git", ["diff", "HEAD", "--binary"], { cwd: repo, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 })
  if (patch.length) {
    await gitWithInput(root, ["apply", "--binary", "--whitespace=nowarn", "-"], patch)
    parts.push("uncommitted changes")
  }
  const untracked = (await git(repo, "ls-files", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean)
  for (const rel of untracked) {
    const dst = path.join(root, rel)
    await fs.mkdir(path.dirname(dst), { recursive: true })
    await fs.cp(path.join(repo, rel), dst, { recursive: true })
  }
  if (untracked.length) parts.push(`${untracked.length} untracked file(s)`)
  return parts.length ? `carried over ${parts.join(" and ")} from the main checkout` : undefined
}

async function runSetup(command: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    const collect = (c: Buffer) => {
      out = (out + c.toString()).slice(-4000)
    }
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    const timer = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000)
    child.on("error", (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on("exit", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(`setup \`${command}\` succeeded`)
      else reject(new Error(`worktree setup \`${command}\` failed (exit ${code}):\n${out}`))
    })
  })
}

/** Hide files we generate (agent profiles) from git in every worktree of the repo. */
export async function excludeFromGit(directory: string, pattern: string) {
  const excludeFile = await git(directory, "rev-parse", "--git-path", "info/exclude")
    .then((p) => path.resolve(directory, p))
    .catch(() => undefined)
  if (!excludeFile) return
  const current = await fs.readFile(excludeFile, "utf8").catch(() => "")
  if (current.split("\n").includes(pattern)) return
  await fs.mkdir(path.dirname(excludeFile), { recursive: true })
  await fs.appendFile(excludeFile, `${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`)
}

async function hasIdentity(cwd: string) {
  return git(cwd, "config", "user.email").then(
    (v) => v !== "",
    () => false,
  )
}

/** Commit everything in the worktree to its branch. Returns a note, or undefined if clean. */
export async function commitAll(wt: Worktree, message: string): Promise<string | undefined> {
  if (!(await exists(wt.root))) return undefined
  const dirty = await git(wt.root, "status", "--porcelain")
  if (!dirty) return undefined
  await git(wt.root, "add", "-A", "--", ".", ...(wt.links ?? []).map((l) => `:(exclude)${l}`))
  if (!(await git(wt.root, "diff", "--cached", "--name-only"))) return undefined
  const identity = (await hasIdentity(wt.root)) ? [] : IDENTITY
  await git(wt.root, ...identity, "commit", "-q", "--no-verify", "-m", message)
  return `committed uncommitted work to ${wt.branch} (${await git(wt.root, "rev-parse", "--short", "HEAD")})`
}

export async function worktreeDiff(wt: Worktree, maxChars: number): Promise<string> {
  const cwd = (await exists(wt.root)) ? wt.root : wt.repo
  const ref = (await exists(wt.root)) ? undefined : wt.branch
  const start = workStart(wt)
  const range = ref ? [`${start}..${ref}`] : [start]
  const log = await git(wt.repo, "log", "--oneline", `${start}..${wt.branch}`).catch(() => "")
  const stat = await git(cwd, "diff", "--stat", ...range)
  const untracked = ref ? "" : await git(cwd, "ls-files", "--others", "--exclude-standard")
  let patch = await git(cwd, "diff", ...range)
  if (patch.length > maxChars) patch = `${patch.slice(0, maxChars)}\n… [patch truncated, ${patch.length - maxChars} more chars]`
  return [
    `branch ${wt.branch} (base ${wt.base.slice(0, 10)}${wt.baseline ? `, agent work after ${wt.baseline.slice(0, 10)}` : ""})`,
    log ? `commits:\n${log}` : "commits: none yet",
    stat ? `changes vs base:\n${stat}` : "no changes vs base",
    untracked ? `untracked:\n${untracked}` : "",
    patch,
  ]
    .filter(Boolean)
    .join("\n\n")
}

/**
 * Bring the agent's own commits (after the carried-over baseline) into the
 * main checkout's current branch. "merge" replays them as commits; "squash"
 * applies them as staged, uncommitted changes. Conflicts abort cleanly.
 */
export async function mergeWorktree(wt: Worktree, name: string, strategy: "merge" | "squash"): Promise<string> {
  const notes: string[] = []
  const committed = await commitAll(wt, `horde: work from ${name}`)
  if (committed) notes.push(committed)
  const start = workStart(wt)
  const commits = (await git(wt.repo, "rev-list", "--reverse", "--no-merges", `${start}..${wt.branch}`)).split("\n").filter(Boolean)
  if (!commits.length) return [...notes, `nothing to merge: the agent made no changes on ${wt.branch}`].join("\n")
  const target = await git(wt.repo, "rev-parse", "--abbrev-ref", "HEAD")
  const identity = (await hasIdentity(wt.repo)) ? [] : IDENTITY
  try {
    await git(wt.repo, ...identity, "cherry-pick", "--allow-empty", "--keep-redundant-commits", ...(strategy === "squash" ? ["--no-commit"] : []), ...commits)
  } catch (err) {
    const conflicts = await git(wt.repo, "diff", "--name-only", "--diff-filter=U").catch(() => "")
    await git(wt.repo, "cherry-pick", "--abort").catch(() => undefined)
    if (strategy === "squash") await git(wt.repo, "reset", "--merge").catch(() => undefined)
    const detail = conflicts ? `conflicting files:\n${conflicts}` : err instanceof Error ? err.message : String(err)
    throw new Error(`merge of ${wt.branch} into ${target} failed and was aborted; your checkout is unchanged.\n${detail}`)
  }
  notes.push(
    strategy === "squash"
      ? `applied ${commits.length} commit(s) from ${wt.branch} to ${target} as staged, uncommitted changes`
      : `merged ${commits.length} commit(s) from ${wt.branch} into ${target}`,
  )
  return notes.join("\n")
}

/** Remove the worktree. Uncommitted work is committed to the branch first unless discard is set. */
export async function removeWorktree(wt: Worktree, name: string, discard: boolean): Promise<string> {
  const notes: string[] = []
  if (!discard) {
    const committed = await commitAll(wt, `horde: uncommitted work from ${name}`)
    if (committed) notes.push(committed)
  }
  if (await exists(wt.root)) {
    try {
      await git(wt.repo, "worktree", "remove", "--force", wt.root)
    } catch {
      // Something may still be writing into it (e.g. OpenCode); delete it outright.
      await fs.rm(wt.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      await git(wt.repo, "worktree", "prune")
    }
  }
  notes.push(`removed worktree ${wt.root}`)
  const ahead = await git(wt.repo, "rev-list", "--count", `${workStart(wt)}..${wt.branch}`).catch(() => "0")
  if (ahead === "0") {
    await git(wt.repo, "branch", "-D", wt.branch).catch(() => undefined)
    notes.push(`deleted branch ${wt.branch} (no commits)`)
  } else {
    notes.push(`kept branch ${wt.branch} (${ahead} commit(s) ahead of base)`)
  }
  return notes.join("\n")
}

export async function exists(p: string) {
  return fs.stat(p).then(
    () => true,
    () => false,
  )
}

async function branchExists(repo: string, branch: string) {
  return git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).then(
    () => true,
    () => false,
  )
}
