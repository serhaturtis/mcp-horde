import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, test } from "node:test"
import { Board } from "../src/lib.js"

const temps: string[] = []
after(() => {
  for (const t of temps) fs.rmSync(t, { recursive: true, force: true })
})

function boardAt(): { board: Promise<Board>; dir: string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "horde-board-unplan-")))
  temps.push(dir)
  return { board: Board.open(dir, path.join(dir, "state")), dir }
}

async function planned(board: Board) {
  const { tasks } = await board.plan([{ title: "A planned task", goal: "Never started.", acceptance: [], scope: [] }])
  return tasks[0]!
}

describe("unplan", () => {
  test("a planned task is removed and no longer listed", async () => {
    const { board } = boardAt()
    const b = await board
    const task = await planned(b)
    assert.equal(b.tasks().length, 1)
    await b.unplan(task.id)
    assert.deepEqual(b.tasks(), [])
    assert.throws(() => b.task(task.id), /no task/)
    await assert.rejects(b.unplan(task.id), /no task/)
  })

  test("a task with an attempt is refused and kept", async () => {
    const { board } = boardAt()
    const b = await board
    const task = await planned(b)
    await b.assign(task.id, "worker")
    await assert.rejects(b.unplan(task.id), /has attempts; a started task is history/)
    assert.equal(b.task(task.id).attempts.length, 1)
    assert.deepEqual(
      b.tasks().map((t) => t.id),
      [task.id],
    )
  })
})
