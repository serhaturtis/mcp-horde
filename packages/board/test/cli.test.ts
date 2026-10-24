import assert from "node:assert/strict"
import { execSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { Board, cliArgv, workerCommand } from "../src/lib.js"

const temps: string[] = []
after(() => {
  for (const t of temps) fs.rmSync(t, { recursive: true, force: true })
})
function tmp() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "horde-cli-")))
  temps.push(d)
  return d
}

/** Run a command the way a worker's shell tool would, returning stdout or throwing with stderr. */
function sh(command: string, cwd: string): string {
  return execSync(command, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_TEST_CONTEXT: "" } }).trim()
}

test("a --state path that does not exist is refused instead of becoming an empty board", async () => {
  const root = tmp()
  const right = path.join(root, "dsh-su-c9b57f0413")
  const typo = path.join(root, "dsh-su-c57f0413")
  const board = new Board(right)
  const t = (await board.plan([{ title: "x", goal: "y" }])).tasks[0]!
  const { attempt } = await board.assign(t.id)
  const refusal = (command: string) => {
    let message = ""
    try {
      sh(command, tmp())
    } catch (e) {
      message = (e as Error).message
    }
    for (const part of [`no board exists at ${typo}`, `boards in ${root}: dsh-su-c9b57f0413`, "copy the --state path from your brief exactly"])
      assert.ok(message.includes(part), `${part}\n${message}`)
  }
  refusal(`${workerCommand(typo)} report t-1 tok --summary "done"`)
  refusal(`${cliArgv().join(" ")} status --state "${typo}"`)
  assert.equal(fs.existsSync(typo), false, "no board is created at the typo")
  // The path from the brief still reaches the board, for workers and humans.
  assert.match(sh(`${workerCommand(right)} task ${t.id} ${attempt.token}`, tmp()), /"x" — working/)
  assert.match(sh(`${cliArgv().join(" ")} status --state "${right}"`, tmp()), /1 task: 1 working/)
})
