import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd })
  return stdout.trim()
}

export interface Worktree {
  path: string
  branch: string
  base: string
  repo: string
}

/**
 * Create an isolated git worktree for one agent. Worktrees live inside the
 * repository's git dir (`.git/horde-worktrees/<name>`) so they never show up
 * as untracked files in the main checkout.
 */
export async function createWorktree(directory: string, name: string): Promise<Worktree> {
  let repo: string
  try {
    repo = await git(directory, "rev-parse", "--show-toplevel")
  } catch {
    throw new Error(`isolation "worktree" needs a git repository, but ${directory} is not inside one`)
  }
  const commonDir = path.resolve(repo, await git(repo, "rev-parse", "--git-common-dir"))
  const slug = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "agent"
  const base = await git(repo, "rev-parse", "HEAD")
  let wtPath = path.join(commonDir, "horde-worktrees", slug)
  let branch = `horde/${slug}`
  for (let i = 2; await exists(wtPath) || (await branchExists(repo, branch)); i++) {
    wtPath = path.join(commonDir, "horde-worktrees", `${slug}-${i}`)
    branch = `horde/${slug}-${i}`
  }
  await git(repo, "worktree", "add", "-b", branch, wtPath, base)
  // Keep the agent in the same sub-directory it would have used in the main checkout.
  const sub = path.relative(repo, directory)
  return { path: sub ? path.join(wtPath, sub) : wtPath, branch, base, repo }
}

export async function removeWorktree(wt: Worktree, force: boolean): Promise<string> {
  const root = await git(wt.path, "rev-parse", "--show-toplevel")
  const dirty = await git(root, "status", "--porcelain")
  if (dirty && !force) {
    return `worktree ${root} has uncommitted changes; kept it (pass force to discard)`
  }
  await git(wt.repo, "worktree", "remove", ...(force ? ["--force"] : []), root)
  const ahead = await git(wt.repo, "rev-list", "--count", `${wt.base}..${wt.branch}`).catch(() => "0")
  if (ahead === "0") {
    await git(wt.repo, "branch", "-D", wt.branch).catch(() => undefined)
    return `removed worktree ${root} and its branch ${wt.branch} (no new commits)`
  }
  return `removed worktree ${root}; kept branch ${wt.branch} (${ahead} commit(s) ahead of base)`
}

async function exists(p: string) {
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
