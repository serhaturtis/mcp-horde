import fs from "node:fs"
import path from "node:path"
import { connect, git, type Harness, isolatedEnv, type Mock, makeRepo } from "./harness.js"
import { startMockLlm } from "./mock-llm.js"

// The project's one check: every .txt file says "ok" (a hint fixes it, except for stubborn.txt),
// and the guard file a test commits to master breaks it.
export const CHECK = `const fs = require("fs")
const bad = []
for (const f of fs.readdirSync(".").filter((f) => f.endsWith(".txt"))) {
  if (fs.readFileSync(f, "utf8").trim() === "ok") continue
  bad.push([f, "Error: " + f + " must say ok." + (f === "stubborn.txt" ? "" : " TOOL: echo ok > " + f + " && git add -A && git commit -qm fix")])
}
if (fs.existsSync("broken.flag")) bad.push(["broken.flag", "Error: broken.flag exists"])
// Passes alone on either side, fails only once the worker's file and master's move meet.
if (fs.existsSync("third.txt") && fs.existsSync("gate.txt")) bad.push(["third.txt+gate.txt", "Error: third.txt and gate.txt must not exist together"])
// TAP so several failures are each reported (the generic extractor only sees one in a block).
console.log("TAP version 13")
bad.forEach(([f, message], i) => {
  console.log("not ok " + (i + 1) + " - " + f)
  console.log("  ---")
  console.log("  message: " + message)
  console.log("  ...")
})
if (bad.length) process.exit(1)
`

/** One simple-path file's mock LLM, repository, server and the helpers its tests share. */
export interface HordeEnv {
  h: Harness
  mock: Mock
  repo: string
  tmp: string
  boardState: () => string
  idOf: (text: string) => string
  branches: () => string
  baselineBranches: () => string
  baselineLeftovers: () => string[]
  settle: (id: string) => Promise<string>
  close: () => Promise<void>
}

export async function createHordeEnv(): Promise<HordeEnv> {
  const mock = await startMockLlm()
  const { tmp, repo } = makeRepo(mock.url)
  fs.writeFileSync(path.join(repo, "check.js"), CHECK)
  fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify({ verify: { checks: { test: "node check.js" } }, tiers: ["mock/mock", "mock/pricey"] }))
  git(repo, "add", ".")
  git(repo, "commit", "-qm", "checks")
  const boardState = () => path.join(tmp, "board-state")
  const h = await connect({ ...isolatedEnv(tmp, repo), HORDE_BOARD_STATE_DIR: boardState() })
  const idOf = (text: string) => text.match(/\bt-[0-9a-f]+\b/)![0]
  const branches = () => git(repo, "branch", "--list", "horde/*")
  const baselineBranches = () => git(repo, "branch", "--list", "horde/base-*")

  /** Baseline checkouts left under the worktree directory (they are named base-<sha>-<hex>). */
  const baselineLeftovers = (): string[] => {
    const root = path.join(tmp, "worktrees")
    const out: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        if (e.name.startsWith("base-")) out.push(path.join(dir, e.name))
        walk(path.join(dir, e.name))
      }
    }
    if (fs.existsSync(root)) walk(root)
    return out
  }

  /** The next outcome other than a permission request; the test repo's OpenCode config asks before shell commands. */
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
    branches,
    baselineBranches,
    baselineLeftovers,
    settle,
    close: async () => {
      await h.call("opencode_server", { action: "stop" }).catch(() => undefined)
      await h.close()
      mock.close()
    },
  }
}
