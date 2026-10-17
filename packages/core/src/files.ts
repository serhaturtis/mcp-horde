import { randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** This process: a random token tells it apart from a later process that reuses its PID. */
export const SELF = { pid: process.pid, host: os.hostname(), token: randomBytes(8).toString("hex") } as const

/** Whether a local process exists (EPERM means it exists but belongs to someone else). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

export function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Replace a file atomically (temp file + rename), mode 0600. Readers never see a partial write. */
export function writeAtomic(file: string, data: string) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  fs.writeFileSync(tmp, data, { mode: 0o600 })
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file)
      return
    } catch (err) {
      // Windows refuses to replace a file another process has open for a moment.
      if (i >= 20 || (err as NodeJS.ErrnoException).code !== "EPERM") {
        fs.rmSync(tmp, { force: true })
        throw err
      }
      sleepSync(25)
    }
  }
}

export function writeJson(file: string, value: unknown) {
  writeAtomic(file, JSON.stringify(value, null, 2))
}

/** The parsed file, or undefined when it is missing or not valid JSON. */
export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T
  } catch {
    return undefined
  }
}

/**
 * Cross-process lock on `<dir>/<name>.lock`. The holder keeps the file fresh;
 * a lock is only taken over when its holder process is gone (same host) or it
 * has not been refreshed for 30 s. Release only removes our own lock.
 */
export async function withLock<T>(dir: string, name: string, fn: () => Promise<T>, timeoutMs = 120_000): Promise<T> {
  const file = path.join(dir, `${name}.lock`)
  const mine = JSON.stringify({ pid: process.pid, host: SELF.host, token: randomBytes(8).toString("hex") })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      fs.writeFileSync(file, mine, { flag: "wx", mode: 0o600 })
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
    }
    let content: string
    let age: number
    try {
      content = fs.readFileSync(file, "utf8")
      age = Date.now() - fs.statSync(file).mtimeMs
    } catch {
      continue // released between our attempts
    }
    const holder = (() => {
      try {
        return JSON.parse(content) as { pid: number; host: string }
      } catch {
        return undefined
      }
    })()
    const dead = holder ? holder.host === SELF.host && !pidAlive(holder.pid) : age > 5_000
    if (dead || age > 30_000) {
      // Only one contender can rename the stale file away; if what we moved
      // turns out to be a fresh lock, put it back.
      const tomb = `${file}.stale.${process.pid}.${randomBytes(4).toString("hex")}`
      try {
        fs.renameSync(file, tomb)
        if (fs.readFileSync(tomb, "utf8") === content) fs.rmSync(tomb, { force: true })
        else fs.renameSync(tomb, file)
      } catch {
        // Another contender took it over first.
      }
      continue
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file} (held by ${content})`)
    await new Promise((r) => setTimeout(r, 200))
  }
  const heartbeat = setInterval(() => {
    try {
      const now = new Date()
      fs.utimesSync(file, now, now)
    } catch {
      // Lock file gone; nothing to refresh.
    }
  }, 5_000)
  heartbeat.unref()
  try {
    return await fn()
  } finally {
    clearInterval(heartbeat)
    try {
      if (fs.readFileSync(file, "utf8") === mine) fs.rmSync(file, { force: true })
    } catch {
      // Already gone.
    }
  }
}
