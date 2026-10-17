import { execFile } from "node:child_process"

/** Environment for git: never prompt, never page, stable messages. Use it for any git child process. */
export const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C" }

/** Run git and return stdout untrimmed (needed for -z output). Rejects with git's stderr. */
export function gitRaw(cwd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env: GIT_ENV, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const e = err as Error & { stderr?: string }
        e.message = `git ${args.join(" ")} failed: ${String(stderr).trim() || err.message}`
        reject(e)
      } else resolve(stdout)
    })
  })
}

/** Run git and return trimmed stdout. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await gitRaw(cwd, args)).trim()
}

/** Split NUL-separated git output (`-z`) without trimming names. */
export function splitZ(out: string): string[] {
  return out.split("\0").filter((s) => s.length > 0)
}
