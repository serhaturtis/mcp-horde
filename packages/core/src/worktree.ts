import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"

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

/** The folder that holds one repository's worktrees under the horde's worktree directory. */
export function repoKey(repo: string): string {
  return `${branchSlug(path.basename(repo))}-${createHash("sha1").update(repo).digest("hex").slice(0, 8)}`
}

/** Root for isolated worktrees: HORDE_OPENCODE_WORKTREE_DIR, else $XDG_DATA_HOME/mcp-horde/worktrees. */
export function defaultWorktreeDir(env: NodeJS.ProcessEnv = process.env): string {
  const dataHome = env.XDG_DATA_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), ".local", "share")
  return path.resolve(env.HORDE_OPENCODE_WORKTREE_DIR || path.join(dataHome, "mcp-horde", "worktrees"))
}
