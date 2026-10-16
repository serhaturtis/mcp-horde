/**
 * End-to-end test against a real model, using your own OpenCode providers.
 * Skipped unless HORDE_E2E_MODEL is set, e.g.
 *
 *   HORDE_E2E_MODEL=deepseek/deepseek-chat npm run test:e2e
 *   HORDE_E2E_MODEL=anthropic/claude-haiku-4-5 HORDE_E2E_VARIANT=high npm run test:e2e
 *
 * It spends a few cents of tokens.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, test } from "node:test"
import { connect, git } from "./harness.js"

const model = process.env.HORDE_E2E_MODEL
const variant = process.env.HORDE_E2E_VARIANT

describe("real model end to end", { skip: !model && "set HORDE_E2E_MODEL=provider/model to run", timeout: 900_000 }, () => {
  test("parallel agents edit, run, report; one is steered and one is isolated", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "horde-e2e-"))
    const repo = path.join(tmp, "repo")
    fs.mkdirSync(repo)
    fs.writeFileSync(path.join(repo, "README.md"), "# e2e\n")
    git(repo, "init", "-q")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "init")
    const h = await connect({
      HORDE_OPENCODE_DIRECTORY: repo,
      HORDE_OPENCODE_STATE_DIR: path.join(tmp, "state"),
      HORDE_OPENCODE_WORKTREE_DIR: path.join(tmp, "worktrees"),
      HORDE_OPENCODE_SERVER: "private",
    })
    try {
      assert.match(await h.call("opencode_models", { query: model!.split("/")[1] }), new RegExp(model!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      await h.call("opencode_spawn", {
        name: "writer",
        model,
        variant,
        permissions: "allow",
        limits: { max_steps: 20, timeout_minutes: 10 },
        prompt: "Create a file named hello.txt containing exactly the text: hello from opencode. Then reply with the single word DONE.",
      })
      await h.call("opencode_spawn", {
        name: "isolated",
        model,
        variant,
        permissions: "allow",
        isolation: "worktree",
        limits: { max_steps: 20, timeout_minutes: 10 },
        prompt: "Create a file named notes.md with one line describing this repository, commit it, then reply DONE.",
      })
      await h.call("opencode_message", { id: "writer", message: "Also create bye.txt containing: bye." })
      const all = await h.call("opencode_wait", { ids: ["writer", "isolated"], mode: "all", timeout_seconds: 600 })
      assert.doesNotMatch(all, /ERROR/)
      assert.match(fs.readFileSync(path.join(repo, "hello.txt"), "utf8"), /hello from opencode/)
      assert.ok(fs.existsSync(path.join(repo, "bye.txt")), "the steer was followed")
      assert.match(await h.call("opencode_worktree", { id: "isolated", action: "diff" }), /notes\.md/)
      assert.match(await h.call("opencode_status", { ids: ["writer"] }), /\$\d/)
    } finally {
      await h.close()
    }
  })
})
