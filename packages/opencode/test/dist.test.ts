/**
 * Smoke test of the compiled package (`npm run build` first): the entry point
 * and the private-mode supervisor must work from dist/, not only under tsx.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { connect, isolatedEnv, type Mock, makeRepo, pkg, until } from "./harness.js"
import { startMockLlm } from "./mock-llm.js"

let mock: Mock

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

describe("built package", { timeout: 300_000 }, () => {
  before(async () => {
    mock = await startMockLlm()
  })
  after(() => mock?.close())

  test("dist/index.js runs an agent on a private server and stops it on exit", async () => {
    assert.ok(fs.existsSync(path.join(pkg, "dist/index.js")), "run `npm run build` before the tests")
    assert.ok(fs.existsSync(path.join(pkg, "dist/supervisor.js")), "the supervisor is compiled too")
    const { tmp, repo } = makeRepo(mock.url)
    const h = await connect({ ...isolatedEnv(tmp, repo), HORDE_OPENCODE_SERVER: "private" }, { built: true })
    let pid = 0
    try {
      const version = (h.client.getServerVersion()?.version ?? "") as string
      assert.equal(version, JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).version)
      const out = await h.call("opencode_spawn", { prompt: "built ping", name: "built", wait: true, timeout_seconds: 60 })
      assert.match(out, /built .*— IDLE[\s\S]*Echo\[none\]: built ping/)
      pid = Number((await h.call("opencode_server", { action: "info" })).match(/pid (\d+)/)![1])
      assert.ok(alive(pid))
    } finally {
      await h.close()
    }
    await until(async () => !alive(pid), 15_000)
  })
})
