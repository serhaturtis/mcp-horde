// The horde_* tools beyond the simple path: the gate review outside the running limit, the
// running-agent limit, horde_investigate and the news file. Each describe starts its own server,
// so this file runs beside horde.test.ts instead of after it.
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { Board } from "@mcp-horde/board"
import { connect, git, type Harness, isolatedEnv, type Mock, makeRepo, until } from "./harness.js"
import { startMockLlm } from "./mock-llm.js"

const idOf = (text: string) => text.match(/\bt-[0-9a-f]+\b/)![0]

describe("the gate review runs outside the worker limit and its failure fails the task", { timeout: 600_000 }, () => {
  let rv: Harness
  let rvmock: Mock
  let rvrepo: string
  let rvtmp: string

  const rid = (text: string) => text.match(/\bt-[0-9a-f]+\b/)![0]
  const rrepo = (check: string, tiers: string[]): string => {
    const { repo } = makeRepo(rvmock.url, { permission: { bash: "allow" } })
    fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify({ verify: { checks: { test: check } }, tiers }))
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "checks")
    return repo
  }
  const rsettle = async (id: string, seconds = 180): Promise<string> => {
    for (;;) {
      const out = await rv.call("horde_wait", { ids: [id], timeout_seconds: seconds })
      if (/ NEEDS YOU /.test(out)) {
        await rv.call("horde_tell", { id, approve: true })
        continue
      }
      return out
    }
  }

  before(async () => {
    rvmock = await startMockLlm()
    ;({ tmp: rvtmp, repo: rvrepo } = makeRepo(rvmock.url))
    rv = await connect({ ...isolatedEnv(rvtmp, rvrepo), HORDE_OPENCODE_MAX_RUNNING: "1" })
  })

  after(async () => {
    await rv?.call("opencode_server", { action: "stop" }).catch(() => undefined)
    await rv?.close()
    rvmock?.close()
  })

  test("a task's review still runs (and judges it) when the running limit is full", async () => {
    const dir = rrepo(`node -e "setTimeout(() => process.exit(0), 5000)"`, ["mock/mock", "mock/pricey"])
    const started = await rv.call("horde_do", {
      directory: dir,
      goal: "Write the greeting file.\nRUN: echo ok > hello.txt && git add hello.txt && git commit -qm hello",
      done: ["hello.txt says ok"],
      scope: ["hello.txt"],
    })
    const id = rid(started)
    // The worker finishes and its gate starts the (slow) checks; the idle worker holds no slot.
    await until(async () => /gate: running checks/.test(await rv.call("opencode_status", { ids: [id] })), 90_000, 100)
    // Fill the single running slot while the checks run.
    await rv.call("opencode_spawn", { prompt: "SLOW hog one", name: "review-hog" })
    const ready = await rsettle(id)
    assert.match(ready, new RegExp(`^${id} READY`), ready)
    assert.match(ready, /review: 1 of 1 criteria met/, ready)
    await rv.call("opencode_interrupt", { id: "review-hog" })
  })

  test("a reviewer that errors twice fails the task, saying the review could not run", async () => {
    // The reviewer is the cheapest tier model other than the worker's; make that model fail at once
    // (a provider that never answers is covered by the core suite and would cost a minute per try here).
    const dir = rrepo(`node -e "process.exit(0)"`, ["mock/mock", "mock/fail"])
    const started = await rv.call("horde_do", {
      directory: dir,
      goal: "Write the greeting file.\nRUN: echo ok > hello.txt && git add hello.txt && git commit -qm hello",
      done: ["hello.txt says ok"],
      scope: ["hello.txt"],
    })
    const id = rid(started)
    const failed = await rsettle(id, 300)
    assert.match(failed, new RegExp(`^${id} FAILED`), failed)
    assert.doesNotMatch(failed, /READY/)
    assert.match(failed, /review could not run/, failed)
    assert.match(failed, /bad request from mock/, failed)
    assert.match(failed, /horde_tell \{id: "t-\w+", message: "Run the review again"\}/, failed)
  })

  test("a criterion judged not met on the last round fails the task, naming it", async () => {
    const dir = rrepo(`node -e "process.exit(0)"`, ["mock/mock", "mock/pricey"])
    const started = await rv.call("horde_do", {
      directory: dir,
      goal: "Write the greeting file.\nRUN: echo ok > hello.txt && git add hello.txt && git commit -qm hello",
      done: ["hello.txt says ok", "nothing else changes", "third.txt says ok"],
      scope: ["hello.txt"],
    })
    const id = rid(started)
    const failed = await rsettle(id)
    assert.match(failed, new RegExp(`^${id} FAILED`), failed)
    assert.match(failed, /1 criterion not met, by mock\/pricey/, failed)
    assert.match(failed, /third\.txt says ok/, failed)
  })

  test("a fix round that errors reports the error, not the round count", async () => {
    // The check fails with a message that makes the fix round's prompt a provider error.
    const dir = rrepo(`node -e "console.log('Error: FAIL400'); process.exit(1)"`, ["mock/mock", "mock/pricey"])
    const started = await rv.call("horde_do", {
      directory: dir,
      goal: "Write the result file.\nRUN: echo ok > result.txt && git add result.txt && git commit -qm result",
      done: ["result.txt says ok"],
      scope: ["result.txt"],
    })
    const id = rid(started)
    const failed = await rsettle(id)
    assert.match(failed, new RegExp(`^${id} FAILED`), failed)
    assert.match(failed, /error: bad request from mock/, failed)
    assert.doesNotMatch(failed, /checks failed after/, failed)
  })
})

describe("the running-agent limit refuses a start without leaving a task on the board", { timeout: 600_000 }, () => {
  let lh: Harness
  let lmock: Mock
  let ltmp: string
  let lrepo: string
  const lboardState = () => path.join(ltmp, "board-state")
  const lid = (text: string) => text.match(/\bt-[0-9a-f]+\b/)![0]
  const lrepoFor = (extra: Record<string, unknown> = {}): string => {
    const { repo } = makeRepo(lmock.url, { permission: { bash: "allow" } })
    fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } }, tiers: ["mock/mock", "mock/pricey"], ...extra }))
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "checks")
    return repo
  }

  before(async () => {
    lmock = await startMockLlm()
    ;({ tmp: ltmp, repo: lrepo } = makeRepo(lmock.url))
    lh = await connect({ ...isolatedEnv(ltmp, lrepo), HORDE_OPENCODE_MAX_RUNNING: "1", HORDE_BOARD_STATE_DIR: lboardState() })
  })

  after(async () => {
    await lh?.call("opencode_server", { action: "stop" }).catch((e: Error) => process.stderr.write(`could not stop the test server: ${e.message}\n`))
    await lh?.close()
    lmock?.close()
  })

  test("a start that fails for another reason still records a failed task", async () => {
    const dir = lrepoFor({ workers: { setup: "exit 1" } })
    await assert.rejects(
      lh.call("horde_do", {
        directory: dir,
        goal: "Write a file.\nRUN: echo ok > setup-failed.txt && git add setup-failed.txt && git commit -qm setup-failed",
        done: ["setup-failed.txt says ok"],
        scope: ["setup-failed.txt"],
      }),
      (err: Error) => {
        assert.match(err.message, /worktree setup `exit 1` failed \(exit 1\)/)
        return true
      },
    )
    const tasks = (await Board.open(dir, lboardState())).tasks()
    assert.equal(tasks.length, 1, "the failed start keeps its task")
    assert.equal(tasks[0]!.status, "failed")
    const board = await Board.open(dir, lboardState())
    const events = fs
      .readFileSync(path.join(board.dir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string; task?: string })
      .filter((e) => e.type === "fail" && e.task === tasks[0]!.id)
    assert.equal(events.length, 1, "the failed start is recorded once")
  })

  test("a second start at the running limit is refused and leaves no task behind", async () => {
    const dir = lrepoFor()
    const first = await lh.call("horde_do", {
      directory: dir,
      goal: "Take your time.\nRUN: sleep 30",
      done: ["it waited"],
      scope: ["slow/**"],
    })
    const id = lid(first)
    assert.equal((await Board.open(dir, lboardState())).tasks().length, 1)
    await assert.rejects(
      lh.call("horde_do", {
        directory: dir,
        goal: "Write a second file.\nRUN: echo ok > second.txt && git add second.txt && git commit -qm second",
        done: ["second.txt says ok"],
        scope: ["second.txt"],
      }),
      (err: Error) => {
        assert.match(err.message, /agents are already working or starting \(limit 1, from HORDE_OPENCODE_MAX_RUNNING\)/)
        assert.match(err.message, /Wait for one with opencode_wait, or stop one\./)
        return true
      },
    )
    await assert.rejects(lh.call("horde_investigate", { directory: dir, question: "What is in this repository?" }), (err: Error) => {
      assert.match(err.message, /agents are already working or starting \(limit 1/)
      return true
    })
    const after = (await Board.open(dir, lboardState())).tasks()
    assert.deepEqual(
      after.map((t) => t.id),
      [id],
      "only the running task remains on the board",
    )
    await lh.call("horde_drop", { id })
  })
})

describe("horde_investigate: read-only workers that answer with a checked report", { timeout: 600_000 }, () => {
  let iv: Harness
  let ivmock: Mock
  let ivrepo: string
  let ivtmp: string
  const boardState = () => path.join(ivtmp, "board-state")
  const iid = (text: string) => text.match(/\bt-[0-9a-f]+\b/)![0]

  before(async () => {
    ivmock = await startMockLlm()
    ;({ tmp: ivtmp, repo: ivrepo } = makeRepo(ivmock.url))
    fs.writeFileSync(path.join(ivrepo, "horde.json"), JSON.stringify({ tiers: ["mock/mock", "mock/pricey"] }))
    fs.writeFileSync(path.join(ivrepo, "greeting.txt"), "hello\n")
    git(ivrepo, "add", ".")
    git(ivrepo, "commit", "-qm", "base")
    iv = await connect({ ...isolatedEnv(ivtmp, ivrepo), HORDE_BOARD_STATE_DIR: boardState() })
  })

  after(async () => {
    await iv?.call("opencode_server", { action: "stop" }).catch(() => undefined)
    await iv?.close()
    ivmock?.close()
  })

  test("a valid JSON answer becomes a REPORT, listed by default, and its worktree is discarded", async () => {
    const findings = [
      { title: "greeting present", severity: "info", file: "greeting.txt", line: 1, evidence: "ran grep hello greeting.txt", confidence: "high" },
      { title: "a critical bug", severity: "critical", file: "greeting.txt", line: 1, evidence: "ran grep hello greeting.txt", confidence: "high" },
    ]
    const question = `Find the greeting.\nJSON: ${JSON.stringify({ summary: "the greeting is in greeting.txt", findings })}`
    const started = await iv.call("horde_investigate", { question, want: ["which file has the greeting"], focus: ["greeting.txt"] })
    assert.match(started, /^t-\w+ investigating: "Find the greeting" · mock\/mock \(tier 0 of 2\) · worktree horde\/t-\w+/, started)
    assert.doesNotMatch(started, /checked by:/, started)
    const id = iid(started)

    // horde_wait with no ids lists the investigation by default.
    const report = await iv.call("horde_wait", { timeout_seconds: 120 })
    assert.match(report, new RegExp(`^${id} REPORT · "Find the greeting"`), report)
    assert.match(report, /the greeting is in greeting\.txt/, report)
    assert.match(report, /findings \(2\):/, report)
    assert.ok(report.indexOf("[critical]") < report.indexOf("[info]"), `severity order:\n${report}`)
    assert.match(report, /greeting\.txt:1 · high · ✓ cited/, report)
    const reportFile = report.match(/full report: (\S+)/)![1]!
    assert.ok(fs.existsSync(reportFile), reportFile)
    const saved = JSON.parse(fs.readFileSync(reportFile, "utf8"))
    assert.equal(saved.task, id)
    assert.equal(saved.findings[0].severity, "critical")
    assert.equal(saved.findings[0].cite, "✓ cited")

    // Done on the board, worktree and branch removed, and nothing lands.
    assert.equal((await Board.open(ivrepo, boardState())).task(id).status, "done")
    assert.equal(git(ivrepo, "branch", "--list", "horde/*"), "")
    await assert.rejects(iv.call("horde_land", { id }), /finished investigation/)
  })

  test("a finding citing a missing file or a line past its end is marked", async () => {
    const findings = [
      { title: "ghost", severity: "medium", file: "nope.txt", line: 1, evidence: "ran ls", confidence: "low" },
      { title: "too deep", severity: "high", file: "greeting.txt", line: 99, evidence: "ran wc -l", confidence: "medium" },
    ]
    const id = iid(await iv.call("horde_investigate", { question: `Check the files.\nJSON: ${JSON.stringify({ summary: "two broken citations", findings })}` }))
    const report = await iv.call("horde_wait", { ids: [id], timeout_seconds: 120 })
    assert.match(report, /nope\.txt not found/, report)
    assert.match(report, /line 99 past end \(1 line\)/, report)
  })

  test("an answer that never becomes valid JSON is FAILED with its tail", async () => {
    const id = iid(await iv.call("horde_investigate", { question: "Find the bug. JSON-NEVER" }))
    const failed = await iv.call("horde_wait", { ids: [id], timeout_seconds: 120 })
    assert.match(failed, new RegExp(`^${id} FAILED · "Find the bug" \\(the answer never became valid JSON\\)`), failed)
    assert.match(failed, /still prose/, failed)
    assert.doesNotMatch(failed, /REPORT/, failed)
  })
})

describe("the server's news file for Claude Code hooks (real opencode, mock LLM)", { timeout: 600_000 }, () => {
  const SESSION = "test-session-news"
  let h: Harness
  let mock: Mock
  let repo: string
  let tmp: string
  let newsFile: string

  type News = { pid: number; at: number; waiting: { id: string; title: string; kind: string }[]; working: { id: string; title: string }[] }

  const read = (): News | undefined => {
    try {
      return JSON.parse(fs.readFileSync(newsFile, "utf8")) as News
    } catch {
      return undefined
    }
  }
  const has = (n: News | undefined, list: "waiting" | "working", id: string) => !!n?.[list].some((x) => x.id === id)

  before(async () => {
    mock = await startMockLlm()
    ;({ tmp, repo } = makeRepo(mock.url, { permission: { bash: "allow" } }))
    fs.writeFileSync(path.join(repo, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } }, tiers: ["mock/mock"] }))
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "checks")
    h = await connect({ ...isolatedEnv(tmp, repo), CLAUDE_CODE_SESSION_ID: SESSION })
    newsFile = path.join(tmp, "state", "news", `${SESSION}.json`)
  })

  after(async () => {
    await h?.call("opencode_server", { action: "stop" }).catch(() => undefined)
    await h?.close()
    mock?.close()
  })

  test("a finished, unread task is news; a wait reports it and a drop removes it", async () => {
    const started = await h.call("horde_do", {
      goal: "Write the news file.\nRUN: echo ok > news.txt && git add news.txt && git commit -qm news",
      done: ["news.txt says ok"],
      scope: ["news.txt"],
    })
    const id = idOf(started)
    const title = "Write the news file"

    const waiting = await until(async () => {
      const n = read()
      return has(n, "waiting", id) ? n : undefined
    }, 120_000)
    assert.ok(Number.isInteger(waiting.pid) && waiting.pid > 0, `server pid: ${waiting.pid}`)
    assert.ok(waiting.at > 0, "write time")
    assert.deepEqual(
      waiting.waiting.find((w) => w.id === id),
      { id, title, kind: "finished" },
    )
    assert.ok(!has(waiting, "working", id), "a finished task is not also working")

    const outcome = await h.call("horde_wait", { ids: [id], timeout_seconds: 120 })
    assert.match(outcome, new RegExp(`^${id} READY`), outcome)
    const reported = await until(async () => {
      const n = read()
      return n && !has(n, "waiting", id) ? n : undefined
    })
    assert.ok(!has(reported, "working", id), "a reported task is not working")

    await h.call("horde_drop", { id })
    const dropped = await until(async () => {
      const n = read()
      return n && !has(n, "waiting", id) && !has(n, "working", id) ? n : undefined
    })
    assert.deepEqual(dropped.waiting, [])
    assert.deepEqual(dropped.working, [])
  })

  test("a task still running is listed under working", async () => {
    const started = await h.call("horde_do", {
      goal: "Take your time.\nRUN: sleep 10",
      done: ["the slow command ran"],
    })
    const id = idOf(started)
    const working = await until(async () => {
      const n = read()
      return has(n, "working", id) ? n : undefined
    }, 60_000)
    assert.deepEqual(
      working.working.find((w) => w.id === id),
      { id, title: "Take your time" },
    )
    await h.call("horde_drop", { id })
    await until(async () => {
      const n = read()
      return n && !has(n, "working", id) ? n : undefined
    })
  })

  test("without CLAUDE_CODE_SESSION_ID no file is written", async () => {
    const { tmp: ntmp, repo: nrepo } = makeRepo(mock.url, { permission: { bash: "allow" } })
    fs.writeFileSync(path.join(nrepo, "horde.json"), JSON.stringify({ verify: { checks: { test: "true" } }, tiers: ["mock/mock"] }))
    git(nrepo, "add", ".")
    git(nrepo, "commit", "-qm", "checks")
    const saved = process.env.CLAUDE_CODE_SESSION_ID
    delete process.env.CLAUDE_CODE_SESSION_ID
    let nh: Harness
    try {
      nh = await connect({ ...isolatedEnv(ntmp, nrepo) })
    } finally {
      if (saved !== undefined) process.env.CLAUDE_CODE_SESSION_ID = saved
    }
    try {
      const id = idOf(await nh.call("horde_do", { goal: "Write nothing.\nRUN: echo ok > nothing.txt", done: ["nothing.txt says ok"] }))
      await nh.call("horde_wait", { ids: [id], timeout_seconds: 120 })
      assert.equal(fs.existsSync(path.join(ntmp, "state", "news")), false, "no news directory without a session id")
    } finally {
      await nh.call("opencode_server", { action: "stop" }).catch(() => undefined)
      await nh.close()
    }
  })

  test("the file is removed when the server stops", async () => {
    assert.ok(fs.existsSync(newsFile), "the file exists while the server runs")
    await h.call("opencode_server", { action: "stop" })
    await until(async () => !fs.existsSync(newsFile), 30_000)
  })
})
