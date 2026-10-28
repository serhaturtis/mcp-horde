import fs from "node:fs"
import path from "node:path"
import type { AgentRecord } from "../src/state.js"
import { connect, type Harness, isolatedEnv, type Mock, makeRepo } from "./harness.js"
import { startMockLlm } from "./mock-llm.js"

/** The Claude Code session id the harness server publishes its news file under. */
export const NEWS_SESSION = "test-news-session"

/** One fleet file's mock LLM, repository, server and the helpers its tests share. */
export interface FleetEnv {
  h: Harness
  mock: Mock
  repo: string
  tmp: string
  boardState: string
  idOf: (text: string) => string
  agentRecord: (taskId: string) => AgentRecord | undefined
  alive: (pid: number) => boolean
  settle: (id: string) => Promise<string>
  close: () => Promise<void>
}

export async function createFleetEnv(): Promise<FleetEnv> {
  const mock = await startMockLlm()
  const { tmp, repo } = makeRepo(mock.url)
  const boardState = path.join(tmp, "board-state")
  const h = await connect({
    ...isolatedEnv(tmp, repo),
    HORDE_OPENCODE_MAX_RUNNING: "2",
    HORDE_BOARD_STATE_DIR: boardState,
    CLAUDE_CODE_SESSION_ID: NEWS_SESSION,
  })
  const idOf = (text: string) => text.match(/\bt-[0-9a-f]+\b/)![0]

  /** The fleet's record on disk for the agent working a task (it is written as the gate decides). */
  const agentRecord = (taskId: string): AgentRecord | undefined => {
    const dir = path.join(tmp, "state", "agents")
    for (const f of fs.readdirSync(dir)) {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as AgentRecord
      if (r.task?.id === taskId) return r
    }
    return undefined
  }
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /** The next outcome other than a permission request (this repo's config asks before shell). */
  const settle = async (id: string): Promise<string> => {
    for (;;) {
      const out = await h.call("horde_wait", { ids: [id], timeout_seconds: 120 })
      if (!/ NEEDS YOU /.test(out)) return out
      await h.call("horde_tell", { id, approve: true })
    }
  }

  return {
    h,
    mock,
    repo,
    tmp,
    boardState,
    idOf,
    agentRecord,
    alive,
    settle,
    close: async () => {
      await h.call("opencode_server", { action: "stop" }).catch(() => undefined)
      await h.close()
      mock.close()
    },
  }
}
