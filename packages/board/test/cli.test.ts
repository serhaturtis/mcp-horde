import assert from "node:assert/strict"
import { execSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { Board, cliArgv, projectOf, workerCommand } from "../src/lib.js"

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
function sh(command: string, cwd: string, env: NodeJS.ProcessEnv = {}): string {
  return execSync(command, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_TEST_CONTEXT: "", ...env },
  }).trim()
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

test("status and remove refuse a directory with no board instead of creating one", async () => {
  const root = tmp()
  const state = path.join(root, "state")
  const env = { HORDE_BOARD_STATE_DIR: state }
  const cli = cliArgv().join(" ")
  // An existing board so the refusal can name the boards in the state root.
  new Board(path.join(state, "notrepo-aaaaaaaaaa"))

  const plain = path.join(root, "notrepo")
  fs.mkdirSync(plain)
  const plainKey = (await projectOf(plain)).key
  const refusal = (command: string, cwd: string, expected: string, listed?: string) => {
    let message = ""
    try {
      sh(command, cwd, env)
      assert.fail(`expected a refusal: ${command}`)
    } catch (e) {
      message = (e as Error).message
    }
    const parts = [`no board exists at ${expected}`, ...(listed ? [`boards in ${state}: ${listed}`] : []), "copy the --state path from your brief exactly"]
    for (const part of parts) assert.ok(message.includes(part), `${part}\n${message}`)
  }
  const before = fs.readdirSync(state).sort()
  const plainBoard = path.join(state, plainKey)
  refusal(`${cli} status --repo "${plain}"`, root, plainBoard, "notrepo-aaaaaaaaaa")
  refusal(`${cli} status`, plain, plainBoard, "notrepo-aaaaaaaaaa")
  refusal(`${cli} remove --repo "${plain}"`, root, plainBoard, "notrepo-aaaaaaaaaa")
  refusal(`${cli} remove --repo "${plain}" --yes`, root, plainBoard, "notrepo-aaaaaaaaaa")
  assert.deepEqual(fs.readdirSync(state).sort(), before, "a refused command creates nothing")

  // A git repository whose board was never created is refused the same way.
  const gitRepo = path.join(root, "gitrepo")
  fs.mkdirSync(gitRepo)
  execSync("git init -q", { cwd: gitRepo })
  const gitBoard = path.join(state, (await projectOf(gitRepo)).key)
  const beforeGit = fs.readdirSync(state).sort()
  refusal(`${cli} status --repo "${gitRepo}"`, root, gitBoard)
  refusal(`${cli} remove --repo "${gitRepo}"`, root, gitBoard)
  assert.deepEqual(fs.readdirSync(state).sort(), beforeGit, "a refused command creates nothing")
})
