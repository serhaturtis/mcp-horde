import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { GIT_ENV, git, gitRaw, runCommand } from "@mcp-horde/core"

const isWindows = process.platform === "win32"

/** Never sign automated commits (a signer could block on a missing TTY). */
const NO_SIGN = ["-c", "commit.gpgsign=false"]
const IDENTITY = ["-c", "user.name=mcp-horde", "-c", "user.email=mcp-horde@localhost"]
/** Diff output that does not depend on the user's config (prefixes, colors, external tools). */
const DIFF = ["-c", "color.ui=never", "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "diff", "--no-ext-diff", "--no-color", "--no-textconv"]

export { git, gitRaw }

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
  /** Last agent commit already merged into the main checkout. */
  merged?: string
  /** Paths symlinked from the main checkout; never committed. */
  links?: string[]
  /** Root of the main checkout. */
  repo: string
}

/** Where the agent's not-yet-merged work starts. */
export function workStart(wt: Worktree): string {
  return wt.merged ?? wt.baseline ?? wt.base
}

export interface WorktreeOptions {
  /** Directory that holds all worktrees. */
  rootDir: string
  /** Carry over uncommitted (staged, unstaged and untracked) changes from the main checkout. */
  includeUncommitted: boolean
  /** Paths (relative to the repo root) to symlink from the main checkout, e.g. node_modules. */
  link: string[]
  /** Shell command run in the new worktree before the agent starts, e.g. "npm ci". */
  setup?: string
  /** Initialize submodules in the new worktree (default: when the repo has any). */
  submodules?: boolean
  signal?: AbortSignal
  onProgress?: (message: string) => void
}

/** Limits for carrying untracked files over. */
const CARRY_MAX_FILES = 5_000
const CARRY_MAX_BYTES = 200 * 1024 * 1024

export async function repoRoot(directory: string): Promise<string> {
  try {
    return await git(directory, "rev-parse", "--show-toplevel")
  } catch {
    throw new Error(`isolation "worktree" needs a git repository, but ${directory} is not inside one`)
  }
}

/** A slug git accepts in `horde/<slug>` (no "..", leading ".", trailing "." or ".lock"). */
export function branchSlug(name: string): string {
  let s = name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/(\.lock|\.)+$/i, "")
    .replace(/-+$/, "")
  if (!s) s = "agent"
  return s.slice(0, 80)
}

/** Validate a link path: relative, inside the repo, not "." and not tracked by git. */
export async function validateLink(repo: string, rel: string): Promise<string> {
  const norm = rel.replace(/\\/g, "/").replace(/\/+$/, "")
  if (!norm || norm === "." || path.isAbsolute(rel) || /^[A-Za-z]:/.test(norm) || norm.split("/").some((p) => p === ".." || p === "")) {
    throw new Error(`link "${rel}" must be a plain relative path inside the repository (no "..", not absolute, not ".")`)
  }
  const tracked = await git(repo, "ls-files", "--", norm).catch(() => "")
  if (tracked) throw new Error(`link "${rel}" is tracked by git; only untracked paths such as node_modules or .env can be linked`)
  return norm
}

/**
 * Create an isolated worktree on a new branch `horde/<name>`. Worktrees live
 * outside the repository (under rootDir) so they never appear in it.
 */
export async function createWorktree(directory: string, name: string, opts: WorktreeOptions): Promise<{ worktree: Worktree; notes: string[] }> {
  const repo = await repoRoot(directory)
  const links = await Promise.all(opts.link.map((l) => validateLink(repo, l)))
  const notes: string[] = []
  const slug = branchSlug(name)
  const repoKey = `${branchSlug(path.basename(repo))}-${createHash("sha1").update(repo).digest("hex").slice(0, 8)}`
  const base = await git(repo, "rev-parse", "--verify", "HEAD^{commit}").catch(() => {
    throw new Error(`isolation "worktree" needs at least one commit in ${repo}`)
  })

  // Pick a free path/branch; retry if a concurrent spawn takes it first.
  let root = ""
  let branch = ""
  for (let i = 1; ; i++) {
    const suffix = i === 1 ? "" : `-${i}`
    root = path.join(opts.rootDir, repoKey, `${slug}${suffix}`)
    branch = `horde/${slug}${suffix}`
    if ((await exists(root)) || (await branchExists(repo, branch))) continue
    await fs.mkdir(path.dirname(root), { recursive: true })
    try {
      await git(repo, "worktree", "add", "-b", branch, root, base)
      break
    } catch (err) {
      if (i < 20 && /already exists|already checked out/i.test((err as Error).message)) continue
      throw err
    }
  }

  // git reports resolved paths (e.g. /private/var on macOS), so compare like with like.
  const sub = path.relative(await fs.realpath(repo), await fs.realpath(directory))
  const worktree: Worktree = { path: path.join(root, sub), root, branch, base, repo, links }

  try {
    if (opts.includeUncommitted) {
      opts.onProgress?.("carrying over uncommitted changes")
      const carried = await carryUncommitted(repo, root, notes)
      if (carried) {
        // Snapshot them so diffs and merges only contain the agent's own work.
        await git(root, "add", "-A")
        if (await git(root, "diff", "--cached", "--name-only")) {
          await git(
            root,
            ...NO_SIGN,
            ...((await hasIdentity(root)) ? [] : IDENTITY),
            "commit",
            "-q",
            "--no-verify",
            "-m",
            "horde: uncommitted changes carried over from the main checkout",
          )
          worktree.baseline = await git(root, "rev-parse", "HEAD")
        }
        notes.push(carried)
      }
    }
    for (const rel of links) {
      const src = path.join(repo, rel)
      const dst = path.join(root, rel)
      if (!(await exists(src))) {
        notes.push(`link: ${rel} does not exist in the main checkout; skipped`)
        continue
      }
      await fs.rm(dst, { recursive: true, force: true })
      await fs.mkdir(path.dirname(dst), { recursive: true })
      const isDir = (await fs.stat(src)).isDirectory()
      try {
        await fs.symlink(src, dst, isDir ? (isWindows ? "junction" : "dir") : "file")
      } catch (err) {
        // Windows needs Developer Mode for file symlinks: copy the file instead.
        if (isDir) throw err
        await fs.copyFile(src, dst)
        notes.push(`copied ${rel} (symlinks to files are not permitted here)`)
        continue
      }
      // A symlink is not matched by "dir/" ignore patterns. The exclude file is
      // shared with your checkout, so only add paths that are ignored there anyway.
      const ignoredInRepo = await git(repo, "check-ignore", "-q", "--", rel).then(
        () => true,
        () => false,
      )
      if (ignoredInRepo) await excludeFromGit(root, `/${rel}`)
      notes.push(
        `linked ${rel} from the main checkout${ignoredInRepo ? "" : " (not git-ignored: automated commits skip it, but tell the agent not to commit it)"}`,
      )
    }
    const wantSubmodules = opts.submodules ?? existsSync(path.join(root, ".gitmodules"))
    if (wantSubmodules) {
      opts.onProgress?.("initializing submodules")
      await git(root, "submodule", "update", "--init", "--recursive").then(
        () => notes.push("initialized submodules"),
        (err: Error) => notes.push(`could not initialize submodules: ${err.message.split("\n")[0]}`),
      )
    }
    if (!(await exists(worktree.path))) {
      await fs.mkdir(worktree.path, { recursive: true })
      notes.push(`${sub} is not in the committed tree; created it empty in the worktree`)
    }
    if (opts.setup) notes.push(await runSetup(opts.setup, worktree.path, opts.signal, opts.onProgress))
  } catch (err) {
    await git(repo, "worktree", "remove", "--force", root).catch(() => fs.rm(root, { recursive: true, force: true }))
    await git(repo, "worktree", "prune").catch(() => undefined)
    await git(repo, "branch", "-D", branch).catch(() => undefined)
    throw err
  }
  return { worktree, notes }
}

/** Stream `git diff HEAD` into `git apply` in the worktree (no size limit). */
function pipePatch(repo: string, root: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const diff = spawn("git", [...DIFF, "--binary", "--src-prefix=a/", "--dst-prefix=b/", "HEAD"], {
      cwd: repo,
      env: GIT_ENV,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const apply = spawn("git", ["apply", "--binary", "--whitespace=nowarn", "-"], { cwd: root, env: GIT_ENV, stdio: ["pipe", "ignore", "pipe"] })
    let any = false
    let err = ""
    diff.stdout.on("data", (c: Buffer) => {
      if (c.length) any = true
    })
    diff.stdout.pipe(apply.stdin)
    diff.stderr.on("data", (c: Buffer) => (err += c.toString()))
    apply.stderr.on("data", (c: Buffer) => (err += c.toString()))
    let diffCode: number | null = null
    diff.on("error", reject)
    apply.on("error", reject)
    diff.on("close", (code) => {
      diffCode = code
    })
    apply.on("close", (code) => {
      if (diffCode !== 0 && diffCode !== null) return reject(new Error(`git diff failed: ${err.trim()}`))
      if (code !== 0) return reject(new Error(`could not apply your uncommitted changes in the worktree: ${err.trim()}`))
      resolve(any)
    })
  })
}

async function carryUncommitted(repo: string, root: string, notes: string[]): Promise<string | undefined> {
  const parts: string[] = []
  // git apply ignores gitlink (submodule pointer) changes; say so instead of dropping them silently.
  const raw = await git(repo, "diff", "--no-ext-diff", "--raw", "HEAD").catch(() => "")
  const gitlinks = raw.split("\n").filter((l) => /^:(\d{6}) (\d{6})/.exec(l)?.slice(1).includes("160000"))
  if (gitlinks.length) notes.push(`${gitlinks.length} submodule pointer change(s) were not carried over`)
  if (await pipePatch(repo, root)) parts.push("uncommitted changes")

  const entries = (await gitRaw(repo, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean)
  let files = 0
  let bytes = 0
  let skippedRepos = 0
  let capped = false
  for (const rel of entries) {
    // A nested repository shows up as "dir/": copying it would embed its .git.
    if (rel.endsWith("/")) {
      skippedRepos++
      continue
    }
    const src = path.join(repo, rel)
    const st = await fs.lstat(src).catch(() => undefined)
    if (!st) continue
    if (files >= CARRY_MAX_FILES || bytes + st.size > CARRY_MAX_BYTES) {
      capped = true
      break
    }
    const dst = path.join(root, rel)
    await fs.mkdir(path.dirname(dst), { recursive: true })
    // Keep symlinks as they are, so relative links do not start pointing into the main checkout.
    await fs.cp(src, dst, { recursive: true, verbatimSymlinks: true })
    files++
    bytes += st.size
  }
  if (files) parts.push(`${files} untracked file(s)`)
  if (skippedRepos) notes.push(`skipped ${skippedRepos} untracked nested git repositor${skippedRepos === 1 ? "y" : "ies"}`)
  if (capped)
    notes.push(`stopped carrying untracked files at ${CARRY_MAX_FILES} files / ${CARRY_MAX_BYTES >> 20} MB; add large directories to .gitignore or link them`)
  return parts.length ? `carried over ${parts.join(" and ")} from the main checkout` : undefined
}

/** Run the setup command; it is killed with all its children on timeout or abort. */
async function runSetup(command: string, cwd: string, signal?: AbortSignal, onProgress?: (m: string) => void): Promise<string> {
  const r = await runCommand(command, {
    cwd,
    signal,
    timeoutMs: 15 * 60_000,
    stripEnv: ["OPENCODE_SERVER_"],
    maxChars: 8_000,
    onProgress: onProgress && ((line) => onProgress(`setup: ${line.slice(0, 120) || "running"}`)),
  })
  if (r.code === 0 && !r.stopped) return `setup \`${command}\` succeeded`
  const why = r.stopped === "timeout" ? "timed out after 15 minutes" : r.stopped === "cancelled" ? "cancelled" : `failed (exit ${r.code})`
  throw new Error(`worktree setup \`${command}\` ${why}:\n${r.output.slice(-4000)}`)
}

/** Hide files we generate (agent profiles, links) from git in every worktree of the repo. */
export async function excludeFromGit(directory: string, pattern: string) {
  const excludeFile = await git(directory, "rev-parse", "--git-path", "info/exclude")
    .then((p) => path.resolve(directory, p))
    .catch(() => undefined)
  if (!excludeFile) return
  const current = await fs.readFile(excludeFile, "utf8").catch(() => "")
  if (current.split(/\r?\n/).includes(pattern)) return
  await fs.mkdir(path.dirname(excludeFile), { recursive: true })
  await fs.appendFile(excludeFile, `${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`)
}

async function hasIdentity(cwd: string) {
  return git(cwd, "config", "user.email").then(
    (v) => v !== "",
    () => false,
  )
}

/** An in-progress merge, rebase, cherry-pick or revert in the checkout at `cwd`, if any. */
async function operationInProgress(cwd: string): Promise<string | undefined> {
  const gitDir = path.resolve(cwd, await git(cwd, "rev-parse", "--git-dir"))
  for (const [file, what] of [
    ["MERGE_HEAD", "a merge"],
    ["CHERRY_PICK_HEAD", "a cherry-pick"],
    ["REVERT_HEAD", "a revert"],
    ["rebase-merge", "a rebase"],
    ["rebase-apply", "a rebase or am"],
    ["sequencer", "a cherry-pick/revert sequence"],
  ] as const) {
    if (await exists(path.join(gitDir, file))) return what
  }
  return undefined
}

/** Commit everything in the worktree to its branch. Returns a note, or undefined if there was nothing to commit. */
export async function commitAll(wt: Worktree, message: string): Promise<string | undefined> {
  if (!(await exists(wt.root))) return undefined
  const head = await git(wt.root, "symbolic-ref", "-q", "HEAD").catch(() => "")
  if (head !== `refs/heads/${wt.branch}`) {
    throw new Error(`the worktree ${wt.root} is not on ${wt.branch} (HEAD: ${head || "detached"}); not committing. Resolve it manually.`)
  }
  const busy = await operationInProgress(wt.root)
  if (busy) throw new Error(`the worktree ${wt.root} has ${busy} in progress; not committing. Finish or abort it first.`)
  // Do not trust `git status` (status.showUntrackedFiles may hide new files): stage, then look.
  // Linked paths that git already ignores need no exclusion (git rejects naming ignored paths).
  const excludes: string[] = []
  for (const l of wt.links ?? []) {
    const rel = l.replace(/\/+$/, "")
    const ignored = await git(wt.root, "check-ignore", "-q", "--", rel).then(
      () => true,
      () => false,
    )
    if (!ignored) excludes.push(`:(exclude)${rel}`)
  }
  await git(wt.root, "add", "-A", "--", ".", ...excludes)
  if (!(await git(wt.root, "diff", "--cached", "--name-only"))) return undefined
  const identity = (await hasIdentity(wt.root)) ? [] : IDENTITY
  await git(wt.root, ...NO_SIGN, ...identity, "commit", "-q", "--no-verify", "-m", message)
  return `committed uncommitted work to ${wt.branch} (${await git(wt.root, "rev-parse", "--short", "HEAD")})`
}

/** Run git and keep at most maxChars of stdout (the rest is not buffered). */
function gitCapped(cwd: string, args: string[], maxChars: number): Promise<{ text: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] })
    let text = ""
    let truncated = false
    let err = ""
    child.stdout.on("data", (c: Buffer) => {
      if (truncated) return
      text += c.toString()
      if (text.length > maxChars) {
        text = text.slice(0, maxChars)
        truncated = true
        child.kill()
      }
    })
    child.stderr.on("data", (c: Buffer) => (err += c.toString()))
    child.on("error", reject)
    child.on("close", (code) => {
      if (code !== 0 && !truncated) reject(new Error(`git ${args.join(" ")} failed: ${err.trim()}`))
      else resolve({ text, truncated })
    })
  })
}

export async function worktreeDiff(wt: Worktree, maxChars: number): Promise<string> {
  const live = await exists(wt.root)
  const cwd = live ? wt.root : wt.repo
  const start = workStart(wt)
  // In the worktree: everything since `start`, committed or not. Otherwise: the branch.
  const range = live ? [start] : [`${start}..${wt.branch}`]
  const log = await git(wt.repo, "log", "--oneline", `${start}..${wt.branch}`).catch((e: Error) => `(could not read commits: ${e.message})`)
  const stat = await git(cwd, ...DIFF, "--stat", ...range)
  const untracked = live ? await git(cwd, "ls-files", "--others", "--exclude-standard") : ""
  const patch = await gitCapped(cwd, [...DIFF, "--src-prefix=a/", "--dst-prefix=b/", ...range], maxChars)
  return [
    `branch ${wt.branch} (base ${wt.base.slice(0, 10)}${wt.baseline ? `, agent work after ${wt.baseline.slice(0, 10)}` : ""}${wt.merged ? `, merged up to ${wt.merged.slice(0, 10)}` : ""})`,
    log ? `commits:\n${log}` : "commits: none yet",
    stat ? `changes:\n${stat}` : "no changes",
    untracked ? `untracked:\n${untracked}` : "",
    patch.text + (patch.truncated ? "\n… [patch truncated]" : ""),
  ]
    .filter(Boolean)
    .join("\n\n")
}

/**
 * Bring the agent's own, not yet merged commits (after the carried-over
 * baseline) into the main checkout's current branch. "merge" replays them as
 * commits; "squash" applies them as staged, uncommitted changes. Returns the
 * new merged marker. Failures leave the checkout exactly as it was.
 */
export async function mergeWorktree(wt: Worktree, name: string, strategy: "merge" | "squash"): Promise<{ text: string; merged?: string }> {
  const notes: string[] = []
  const committed = await commitAll(wt, `horde: work from ${name}`)
  if (committed) notes.push(committed)

  const target = await git(wt.repo, "symbolic-ref", "-q", "--short", "HEAD").catch(() => "")
  if (!target) throw new Error(`your checkout ${wt.repo} is on a detached HEAD; switch to a branch first`)
  const busy = await operationInProgress(wt.repo)
  if (busy) throw new Error(`your checkout ${wt.repo} has ${busy} in progress; finish or abort it first`)
  if (strategy === "squash" && (await git(wt.repo, "diff", "--cached", "--name-only"))) {
    throw new Error("squash needs an empty index in your checkout (it stages the agent's changes); commit or unstage your staged changes first")
  }

  const start = workStart(wt)
  const tip = await git(wt.repo, "rev-parse", "--verify", `${wt.branch}^{commit}`)
  const commits = (await git(wt.repo, "rev-list", "--reverse", "--first-parent", `${start}..${tip}`)).split("\n").filter(Boolean)
  if (!commits.length) return { text: [...notes, `nothing to merge: no new agent commits on ${wt.branch}`].join("\n"), merged: wt.merged }
  const merges = (await git(wt.repo, "rev-list", "--merges", `${start}..${tip}`)).split("\n").filter(Boolean)
  if (merges.length) {
    throw new Error(
      `${wt.branch} contains merge commits (${merges.map((m) => m.slice(0, 10)).join(", ")}), which cannot be replayed safely. Merge it yourself, e.g. git merge ${wt.branch}`,
    )
  }
  const identity = (await hasIdentity(wt.repo)) ? [] : IDENTITY
  const pick = async (extra: string[]) =>
    git(wt.repo, ...NO_SIGN, ...identity, "cherry-pick", "--allow-empty", ...extra, ...(strategy === "squash" ? ["--no-commit"] : []), ...commits)
  try {
    // Drop commits whose changes you already have (git >= 2.45); older git keeps them.
    await pick(["--empty=drop"]).catch(async (err: Error) => {
      if (!/unknown option|usage: git cherry-pick/i.test(err.message)) throw err
      await pick(["--keep-redundant-commits"])
    })
  } catch (err) {
    const conflicts = await git(wt.repo, "diff", "--name-only", "--diff-filter=U").catch(() => "")
    // Nothing was in progress before we started, so this only aborts our own cherry-pick.
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
  return { text: notes.join("\n"), merged: tip }
}

/** Remove the worktree. Uncommitted work is committed to the branch first unless discard is set. */
export async function removeWorktree(wt: Worktree, name: string, discard: boolean, release?: () => Promise<void>): Promise<string> {
  const notes: string[] = []
  if (!discard) {
    // Throws (and keeps the worktree) if the work cannot be committed safely.
    const committed = await commitAll(wt, `horde: uncommitted work from ${name}`)
    if (committed) notes.push(committed)
  }
  // Ask OpenCode to let go of the directory once, before anything is removed: asking
  // again later would make it open an instance on a half-deleted directory.
  await release?.()
  // Windows refuses to delete files another process (OpenCode, a tool it ran) still has
  // open, so retry for a while and say what was left when it still fails.
  let lastError = ""
  for (let attempt = 0; attempt < 6 && (await exists(wt.root)); attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * attempt))
    try {
      if (attempt === 0) await git(wt.repo, "worktree", "remove", "--force", "--force", wt.root)
      else await fs.rm(wt.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    } catch (err) {
      lastError = (err as Error).message.split("\n")[0] ?? String(err)
    }
  }
  await git(wt.repo, "worktree", "prune").catch(() => undefined)
  if (await exists(wt.root)) {
    const left = await fs.readdir(wt.root).catch(() => [] as string[])
    notes.push(
      `could not fully remove worktree ${wt.root}; delete it by hand (${lastError || "no error reported"}; left: ${left.slice(0, 8).join(", ") || "nothing listed"})`,
    )
  } else notes.push(`removed worktree ${wt.root}`)
  let ahead: number
  try {
    ahead = Number(await git(wt.repo, "rev-list", "--count", `${wt.baseline ?? wt.base}..${wt.branch}`))
  } catch (err) {
    notes.push(`kept branch ${wt.branch}: could not count its commits (${(err as Error).message.split("\n")[0]})`)
    return notes.join("\n")
  }
  if (ahead === 0) {
    await git(wt.repo, "branch", "-D", wt.branch).catch(() => undefined)
    notes.push(`deleted branch ${wt.branch} (no agent commits)`)
  } else {
    notes.push(`kept branch ${wt.branch} (${ahead} agent commit(s))`)
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
