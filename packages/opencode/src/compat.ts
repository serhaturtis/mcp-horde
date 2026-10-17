/**
 * The only module that touches OpenCode's legacy (v1) API.
 *
 * Everything else uses the v2 API (`/api/*`, `client.v2`). Each function here
 * covers one thing v2 does not offer yet, says which, and is best effort: every
 * caller must keep working when it fails or disappears. A unit test fails if any
 * other source file reaches for the legacy client, so this list cannot grow
 * silently. Remove an entry as soon as v2 provides the equivalent.
 */
import type { OpencodeClient } from "@opencode-ai/sdk/v2"

/** v2 gap: no session title update. Titles only make agents recognisable in the TUI. */
export async function renameSession(client: OpencodeClient, sessionID: string, directory: string, title: string): Promise<void> {
  await client.session.update({ sessionID, directory, title }).catch(() => undefined)
}

/** v2 gap: no session delete. Returns whether the session is gone; otherwise it stays in history. */
export async function deleteSession(client: OpencodeClient, sessionID: string, directory: string): Promise<{ ok: boolean; status?: number }> {
  try {
    const res = await client.session.delete({ sessionID, directory })
    return { ok: res.response?.ok === true, status: res.response?.status }
  } catch {
    return { ok: false }
  }
}

/** v2 gap: no way to make the server let go of a directory before it is deleted. */
export async function releaseDirectory(client: OpencodeClient, directory: string): Promise<void> {
  await client.instance.dispose({ directory }).catch(() => undefined)
}

/** v2 gap: `/api/health` reports liveness only; the version (for the tested-version warning) is legacy. */
export async function serverVersion(client: OpencodeClient, timeoutMs = 5_000): Promise<string | undefined> {
  try {
    const res = await client.global.health({ signal: AbortSignal.timeout(timeoutMs) })
    return typeof res.data?.version === "string" ? res.data.version : undefined
  } catch {
    return undefined
  }
}
