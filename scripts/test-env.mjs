// Preloaded by the packages' test scripts (--import). The servers the tests start log how they
// start and end in $XDG_STATE_HOME/mcp-horde/servers.log; this points that at a temporary
// directory instead of the user's real state. The test runner's process makes it and removes it
// when it exits; the test files it runs inherit it.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// A shell that points the horde's state directories somewhere (HORDE_*_STATE_DIR) must not reach
// the tests: they build their own isolated environments and would read or write that state instead.
for (const name of ["HORDE_BOARD_STATE_DIR", "HORDE_VERIFY_STATE_DIR", "HORDE_OPENCODE_STATE_DIR", "HORDE_OPENCODE_WORKTREE_DIR"]) delete process.env[name]

if (!process.env.HORDE_TEST_STATE_HOME) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "horde-test-state-"))
  process.env.HORDE_TEST_STATE_HOME = dir
  process.env.XDG_STATE_HOME = dir
  process.env.XDG_CONFIG_HOME = dir
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }))
}
