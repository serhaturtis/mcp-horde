import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { git, readJson, withLock, writeJson } from "@mcp-horde/core"

// ------------------------------------------------------------------ types

export type Status = "open" | "claimed" | "working" | "review" | "done" | "failed" | "blocked"

export interface Report {
  summary: string
  filesChanged: string[]
  testsAdded: string[]
  decisions: string[]
  questions: string[]
  /** Work the worker did not run or check itself. */
  unverifiedClaims: string[]
  confidence: "low" | "medium" | "high"
  at: number
  attempt: number
}

export interface Attempt {
  n: number
  agent?: string
  tier: number
  /** Proof of which attempt a worker belongs to; a new attempt gets a new token. */
  token: string
  startedAt: number
  /** Last time the worker touched the board (task, progress, lock, report). */
  seenAt?: number
  progress?: string
  endedAt?: number
  outcome?: "accepted" | "failed" | "abandoned"
  note?: string
  cost?: number
  /** The cost was given by the orchestrator (accept/fail): the runtime's estimate no longer replaces it. */
  costGiven?: boolean
  /** The model that worked it ("provider/model", plus variant), when the runtime said so. */
  model?: string
  variant?: string
  /** The latest acceptance review of the attempt's change (review_task). */
  review?: { model: string; met: number; notMet: number; total: number; at: number }
  /** What the runtime last said about the attempt's agent (opencode_spawn task): for people watching. */
  activity?: { state: string; gate?: string; at: number }
  /** Where the attempt's work lives, when the runtime that started it said so (opencode_spawn task). */
  workspace?: { path: string; base: string; session?: string }
}

/** A report's claims against the attempt's actual diff. */
export interface ReportCheck {
  /** Files the report names (changed, or tests added that do not exist) that the diff does not touch. */
  claimedNotChanged: string[]
  /** Existing test files the report lists that the diff does not touch (likely only run). */
  listedNotChanged: string[]
  /** Files the diff touches that the report does not mention. */
  changedNotReported: string[]
  /** Every file in the diff. */
  diff: string[]
}

export interface Task {
  id: string
  title: string
  goal: string
  acceptance: string[]
  scope: string[]
  deps: string[]
  status: Status
  tier: number
  parent?: string
  blockedOn?: string
  attempts: Attempt[]
  reports: Report[]
  cost: number
  createdAt: number
  updatedAt: number
}

export interface Note {
  id: string
  text: string
  tags: string[]
  paths: string[]
  /** Task (and attempt) that produced it; undefined for the orchestrator. */
  source?: { task: string; attempt: number }
  confidence?: "low" | "medium" | "high"
  at: number
  forgotten?: boolean
}

export interface Lock {
  path: string
  task: string
  attempt: number
  expires: number
}

export interface PlanInput {
  title: string
  goal: string
  acceptance?: string[]
  scope?: string[]
  /** Task ids, or titles of tasks in the same plan. */
  deps?: string[]
  tier?: number
  parent?: string
}

export const LEASE_MS = 30 * 60_000
const MAX_NOTE = 500
const MAX_REPORT = 2000
const MAX_ITEM = 300

// ------------------------------------------------------------------ project

/**
 * The board belongs to a repository, shared by every worktree of it: the key
 * is the main checkout's real path (git's common directory), so a worker in
 * `horde/<name>` and the orchestrator in the main checkout see one board.
 */
const digest = (p: string) =>
  createHash("sha256")
    .update(process.platform === "win32" ? p.toLowerCase() : p)
    .digest("hex")
    .slice(0, 10)

export async function projectOf(directory: string): Promise<{ root: string; key: string; legacyKey?: string }> {
  // The common dir identifies the repository (submodules and bare repositories have their
  // own, not a ".git" in a parent). Older git has no --path-format: resolve it ourselves.
  const common =
    (await git(directory, "rev-parse", "--path-format=absolute", "--git-common-dir").catch(() => undefined)) ??
    (await git(directory, "rev-parse", "--git-common-dir")
      .then((c) => path.resolve(directory, c))
      .catch(() => undefined))
  const real = fs.realpathSync.native(common ?? path.resolve(directory))
  const hash = digest(real)
  // Named after the checkout for the usual layout, after the repository directory otherwise.
  const root = common && path.basename(real) === ".git" ? path.dirname(real) : real
  const name = path.basename(root).replace(/\.git$/, "") || "repo"
  // Boards made before the key moved to the common dir were keyed by the checkout.
  const legacy = common && path.basename(real) === ".git" ? `${path.basename(root).replace(/[^\w.-]+/g, "_")}-${digest(root)}` : undefined
  return { root, key: `${name.replace(/[^\w.-]+/g, "_")}-${hash}`, legacyKey: legacy }
}

export function defaultStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || env.USERPROFILE || "."
  return path.resolve(env.HORDE_BOARD_STATE_DIR || path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), "mcp-horde", "board"))
}

// ------------------------------------------------------------------ board

export class Board {
  readonly dir: string
  private readonly tasksDir: string
  private readonly locksDir: string

  constructor(dir: string) {
    this.dir = dir
    this.tasksDir = path.join(dir, "tasks")
    this.locksDir = path.join(dir, "locks")
    fs.mkdirSync(this.tasksDir, { recursive: true, mode: 0o700 })
    fs.mkdirSync(this.locksDir, { recursive: true, mode: 0o700 })
  }

  /** The board for the repository containing `directory`. */
  static async open(directory: string, stateRoot = defaultStateRoot()): Promise<Board> {
    const { key, legacyKey } = await projectOf(directory)
    const dir = path.join(stateRoot, key)
    const old = legacyKey && path.join(stateRoot, legacyKey)
    if (old && old !== dir && fs.existsSync(old) && !fs.existsSync(dir)) {
      fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
      // One process migrates; the others wait, then use the directory that is there.
      await withLock(stateRoot, "board-migrate", async () => {
        if (fs.existsSync(old) && !fs.existsSync(dir)) fs.renameSync(old, dir)
      })
    }
    return new Board(fs.existsSync(dir) || !old || !fs.existsSync(old) ? dir : old)
  }

  private mutate<T>(fn: () => T): Promise<T> {
    return withLock(this.dir, "board", async () => fn(), 30_000)
  }

  private taskFile(id: string) {
    if (!/^t-[a-z0-9]+$/.test(id)) throw new Error(`invalid task id "${id}"`)
    return path.join(this.tasksDir, `${id}.json`)
  }

  private event(type: string, data: Record<string, unknown>) {
    fs.appendFileSync(path.join(this.dir, "events.jsonl"), `${JSON.stringify({ at: Date.now(), type, ...data })}\n`, { mode: 0o600 })
  }

  // -------------------------------------------------------------- reads

  task(id: string): Task {
    const t = readJson<Task>(this.taskFile(id))
    if (!t) throw new Error(`no task ${id} on this board`)
    return t
  }

  tasks(): Task[] {
    return fs
      .readdirSync(this.tasksDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson<Task>(path.join(this.tasksDir, f)))
      .filter((t): t is Task => !!t)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }

  /** Open tasks whose dependencies are all done. */
  ready(tasks = this.tasks()): Task[] {
    const done = new Set(tasks.filter((t) => t.status === "done").map((t) => t.id))
    return tasks.filter((t) => t.status === "open" && t.deps.every((d) => done.has(d)))
  }

  private readNotes(file: string): Note[] {
    const p = path.join(this.dir, file)
    if (!fs.existsSync(p)) return []
    const byId = new Map<string, Note>()
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue
      try {
        const n = JSON.parse(line) as Note
        // A forget marks the note; the same note added again afterwards is back.
        if (n.forgotten) {
          const prev = byId.get(n.id)
          if (prev) byId.set(n.id, { ...prev, forgotten: true })
        } else byId.set(n.id, n)
      } catch {
        // A torn last line from a crash: skip it.
      }
    }
    return [...byId.values()].filter((n) => !n.forgotten)
  }

  findings(filter: { tags?: string[]; paths?: string[] } = {}): Note[] {
    return rank(this.readNotes("findings.jsonl"), filter)
  }

  memory(filter: { tags?: string[]; paths?: string[]; query?: string } = {}): Note[] {
    return rank(this.readNotes("memory.jsonl"), filter)
  }

  locks(now = Date.now()): Lock[] {
    return fs
      .readdirSync(this.locksDir)
      .map((f) => readJson<Lock>(path.join(this.locksDir, f)))
      .filter((l): l is Lock => !!l && l.expires > now)
  }

  // -------------------------------------------------------------- orchestrator

  plan(inputs: PlanInput[]): Promise<{ tasks: Task[]; warnings: string[] }> {
    return this.mutate(() => {
      const existing = this.tasks()
      const warnings: string[] = []
      const now = Date.now()
      // createdAt orders tasks, so it stays after every existing task even within one millisecond.
      const first = Math.max(now, ...existing.map((t) => t.createdAt + 1))
      const taken = [...existing]
      const fresh: Task[] = inputs.map((p, i) => {
        if (!p.title?.trim() || !p.goal?.trim()) throw new Error(`task ${i + 1}: title and goal are required`)
        const t: Task = {
          id: this.newId(taken),
          title: p.title.trim(),
          goal: p.goal.trim(),
          acceptance: clean(p.acceptance),
          scope: clean(p.scope),
          deps: [],
          status: "open",
          tier: p.tier ?? 0,
          parent: p.parent,
          attempts: [],
          reports: [],
          cost: 0,
          createdAt: first + i,
          updatedAt: now,
        }
        taken.push(t)
        return t
      })
      // Dependencies may name tasks of this plan by title, or any task by id.
      const all = [...existing, ...fresh]
      fresh.forEach((t, i) => {
        t.deps = clean(inputs[i]!.deps).map((d) => {
          const hit = all.find((x) => x.id === d) ?? fresh.find((x) => x.title === d) ?? existing.find((x) => x.title === d)
          if (!hit) throw new Error(`task "${t.title}": unknown dependency "${d}"`)
          if (hit.id === t.id) throw new Error(`task "${t.title}" depends on itself`)
          return hit.id
        })
      })
      const cycle = findCycle(all)
      if (cycle) throw new Error(`dependency cycle: ${cycle.map((id) => all.find((t) => t.id === id)!.title).join(" → ")}`)
      // Overlapping scopes between tasks that can run at the same time invite conflicts.
      const open = all.filter((t) => !["done", "failed"].includes(t.status))
      const reported = new Set<string>()
      for (const t of fresh) {
        for (const o of open) {
          const pair = [t.id, o.id].sort().join("|")
          if (o.id === t.id || reported.has(pair) || dependsOn(all, t.id, o.id) || dependsOn(all, o.id, t.id)) continue
          const overlap = t.scope.find((a) => o.scope.some((b) => overlaps(a, b)))
          if (!overlap) continue
          reported.add(pair)
          warnings.push(`"${t.title}" and "${o.title}" both touch ${overlap} and may run in parallel; add a dependency or narrow a scope`)
        }
      }
      for (const t of fresh) writeJson(this.taskFile(t.id), t)
      this.event("plan", { tasks: fresh.map((t) => t.id) })
      return { tasks: fresh, warnings }
    })
  }

  private newId(existing: Task[]): string {
    for (;;) {
      const id = `t-${randomBytes(3).toString("hex").slice(0, 4)}`
      if (!existing.some((t) => t.id === id) && !fs.existsSync(this.taskFile(id))) return id
    }
  }

  private update(id: string, fn: (t: Task) => void): Promise<Task> {
    return this.mutate(() => {
      const t = this.task(id)
      fn(t)
      t.updatedAt = Date.now()
      writeJson(this.taskFile(id), t)
      return t
    })
  }

  /** Start an attempt: the task is claimed by an agent, and a new token is minted for its worker. */
  assign(id: string, agent?: string): Promise<{ task: Task; attempt: Attempt }> {
    let attempt!: Attempt
    return this.update(id, (t) => {
      if (t.status === "done") throw new Error(`${id} is already done`)
      if (t.status === "blocked") throw new Error(`${id} is blocked${t.blockedOn ? ` on ${t.blockedOn}` : ""}; unblock it first`)
      const deps = t.deps.filter((d) => this.task(d).status !== "done")
      if (deps.length) throw new Error(`${id} waits for ${deps.join(", ")}`)
      // The previous worker can no longer report or renew; its locks would only block the new one.
      this.endAttempt(t, "abandoned")
      attempt = { n: t.attempts.length + 1, agent, tier: t.tier, token: randomBytes(4).toString("hex"), startedAt: Date.now() }
      t.attempts.push(attempt)
      t.status = "claimed"
      this.event("assign", { task: id, attempt: attempt.n, agent })
    }).then((task) => ({ task, attempt }))
  }

  /** Record where the current attempt works (a worktree and the commit its work starts from). */
  bindWorkspace(id: string, token: string, workspace: NonNullable<Attempt["workspace"]>): Promise<Task> {
    return this.update(id, (t) => {
      const a = current(t)
      if (!a || a.token !== token || a.endedAt) throw new Error(`${id}: that attempt is no longer current`)
      a.workspace = workspace
    })
  }

  /**
   * Check the latest report against the attempt's diff (its workspace from base, untracked
   * files included). Undefined when there is no report or no workspace left to look at.
   */
  async checkReport(id: string): Promise<ReportCheck | undefined> {
    const t = this.task(id)
    const r = t.reports[t.reports.length - 1]
    const a = r && t.attempts.find((x) => x.n === r.attempt)
    if (!r || !a?.workspace || !fs.existsSync(a.workspace.path)) return undefined
    const ws = a.workspace
    let diff: string[]
    let root: string
    try {
      root = await git(ws.path, "rev-parse", "--show-toplevel")
      const Q = ["-c", "core.quotePath=false"]
      // Both sides of a rename: a worker that renamed a.ts to b.ts changed both.
      const changed = await git(root, ...Q, "diff", "--name-only", "--no-renames", ws.base)
      const untracked = await git(root, ...Q, "ls-files", "--others", "--exclude-standard")
      diff = [...new Set(`${changed}\n${untracked}`.split("\n").filter(Boolean))].sort()
    } catch {
      return undefined
    }
    // Claims may be absolute paths, or relative to the workspace when it is a subdirectory of
    // the repository; the diff always names paths relative to the repository root.
    const norm = (p: string) => normalize(path.relative(root, path.resolve(ws.path, p)).replace(/\\/g, "/"))
    // A command a worker ran is not a path; neither is a test it only ran (an existing file
    // outside the diff). A changed file missing from the diff, or a test that does not exist,
    // is still a claim the diff does not support.
    const isFile = (p: string) => fs.existsSync(path.join(root, p)) || fs.existsSync(path.join(ws.path, p))
    const claimedPath = (p: string) => Boolean(p) && (!/\s/.test(p) || isFile(p))
    const changed = r.filesChanged.map(norm).filter(claimedPath)
    const testPaths = r.testsAdded.map(norm).filter(claimedPath)
    const tests = testPaths.filter((p) => diff.includes(p) || !isFile(p))
    const listedNotChanged = testPaths.filter((p) => !diff.includes(p) && isFile(p))
    const claimed = [...new Set([...changed, ...tests])]
    return {
      claimedNotChanged: claimed.filter((c) => !diff.includes(c)),
      listedNotChanged: [...new Set(listedNotChanged)],
      changedNotReported: diff.filter((d) => !claimed.includes(d)),
      diff,
    }
  }

  /**
   * What an attempt has cost so far (the runtime that runs it reports this as it goes,
   * e.g. opencode for a task-bound agent). The task's cost is the sum over its attempts.
   */
  /** The runtime's view of an attempt's agent: its spend so far, state and gate (tracking only, no limits). */
  recordActivity(id: string, attempt: number, activity: { cost?: number; state?: string; gate?: string; model?: string; variant?: string }): Promise<Task> {
    return this.update(id, (t) => {
      const a = t.attempts.find((x) => x.n === attempt)
      if (!a) throw new Error(`${id} has no attempt ${attempt}`)
      // A cost the orchestrator gave when closing the attempt stays.
      if (activity.cost !== undefined && !a.costGiven) a.cost = Math.max(a.cost ?? 0, activity.cost)
      if (activity.state) a.activity = { state: activity.state, gate: activity.gate, at: Date.now() }
      if (activity.model) Object.assign(a, { model: activity.model, variant: activity.variant })
      t.cost = totalCost(t)
    })
  }

  /** Keep the outcome of an acceptance review on the attempt it judged. */
  recordReview(id: string, attempt: number, review: NonNullable<Attempt["review"]>): Promise<Task> {
    return this.update(id, (t) => {
      const a = t.attempts.find((x) => x.n === attempt)
      if (!a) throw new Error(`${id} has no attempt ${attempt}`)
      a.review = review
      this.event("review", { task: id, attempt, met: `${review.met}/${review.total}` })
    })
  }

  /**
   * The task is done. Usually after reviewing a worker's report; also for a task the
   * orchestrator did itself (no live attempt).
   */
  accept(id: string, opts: { note?: string; cost?: number } = {}): Promise<Task> {
    return this.update(id, (t) => {
      if (t.status === "done") throw new Error(`${id} is already done`)
      this.endAttempt(t, "accepted", opts.note, opts.cost)
      t.cost = totalCost(t)
      t.status = "done"
      t.blockedOn = undefined
      this.releaseLocks(id)
      this.event("accept", { task: id })
    })
  }

  /** The attempt failed: retry (optionally on the next tier), or give up on the task. */
  fail(id: string, opts: { reason: string; retry?: boolean; escalate?: boolean; cost?: number }): Promise<Task> {
    return this.update(id, (t) => {
      if (t.status === "done") throw new Error(`${id} is done; nothing to fail (board_edit status "open" reopens a task)`)
      const a = current(t)
      // Failing again what already failed (a retried call) must not escalate twice.
      if ((!a || a.endedAt) && opts.retry !== false)
        throw new Error(`${id} has no running attempt to fail (it is ${t.status}); change its tier with board_edit`)
      this.endAttempt(t, "failed", opts.reason, opts.cost)
      t.cost = totalCost(t)
      if (opts.escalate) t.tier++
      t.status = opts.retry === false ? "failed" : "open"
      this.releaseLocks(id)
      this.event("fail", { task: id, reason: opts.reason, escalate: !!opts.escalate })
    })
  }

  block(id: string, on: string): Promise<Task> {
    return this.update(id, (t) => {
      if (t.status === "done") throw new Error(`${id} is already done`)
      // A blocked task's worker cannot report or renew its locks: end its attempt.
      this.endAttempt(t, "abandoned", `blocked on ${on}`)
      t.status = "blocked"
      t.blockedOn = on
      this.event("block", { task: id, on })
    })
  }

  edit(id: string, patch: Partial<Pick<Task, "title" | "goal" | "acceptance" | "scope" | "tier">> & { status?: "open" }): Promise<Task> {
    return this.update(id, (t) => {
      if (patch.title !== undefined) t.title = patch.title
      if (patch.goal !== undefined) t.goal = patch.goal
      if (patch.acceptance) t.acceptance = clean(patch.acceptance)
      if (patch.scope) t.scope = clean(patch.scope)
      if (patch.tier !== undefined) t.tier = patch.tier
      if (patch.status === "open") {
        this.endAttempt(t, "abandoned", "reopened")
        t.status = "open"
        t.blockedOn = undefined
      }
      this.event("edit", { task: id, fields: Object.keys(patch) })
    })
  }

  remember(text: string, opts: { tags?: string[]; paths?: string[]; confidence?: Note["confidence"]; source?: Note["source"] } = {}): Promise<Note> {
    return this.addNote("memory.jsonl", text, opts)
  }

  forget(id: string): Promise<void> {
    return this.mutate(() => {
      for (const file of ["memory.jsonl", "findings.jsonl"]) {
        if (this.readNotes(file).some((n) => n.id === id)) {
          fs.appendFileSync(path.join(this.dir, file), `${JSON.stringify({ id, forgotten: true })}\n`)
          this.event("forget", { id })
          return
        }
      }
      throw new Error(`no note ${id}`)
    })
  }

  unlock(p: string): Promise<boolean> {
    return this.mutate(() => {
      const file = this.lockFile(p)
      const had = fs.existsSync(file)
      fs.rmSync(file, { force: true })
      if (had) this.event("unlock", { path: p, by: "orchestrator" })
      return had
    })
  }

  // -------------------------------------------------------------- worker

  /**
   * The worker proves which attempt it belongs to. Anything else is refused. A task in
   * review still takes its worker's updates (a gate sent the work back; the report changes).
   */
  private worker(t: Task, token: string): Attempt {
    const a = current(t)
    if (!a || a.token !== token || a.endedAt) throw new Error(`token does not match the current attempt of ${t.id}; this attempt was closed or replaced`)
    if (!["claimed", "working", "review"].includes(t.status)) throw new Error(`${t.id} is ${t.status}; nothing to do`)
    return a
  }

  seen(id: string, token: string, progress?: string): Promise<Task> {
    return this.update(id, (t) => {
      const a = this.worker(t, token)
      a.seenAt = Date.now()
      if (progress) a.progress = progress.slice(0, MAX_NOTE)
      if (t.status === "claimed") t.status = "working"
      this.renewLocks(id, a)
      if (progress) this.event("progress", { task: id, attempt: a.n, note: a.progress })
    })
  }

  report(id: string, token: string, r: Partial<Omit<Report, "at" | "attempt">> & { summary: string }): Promise<Task> {
    return this.update(id, (t) => {
      const a = this.worker(t, token)
      const item = (list?: string[]) => clean(list).map((x) => x.slice(0, MAX_ITEM))
      const report: Report = {
        summary: r.summary.slice(0, MAX_REPORT),
        filesChanged: item(r.filesChanged),
        testsAdded: item(r.testsAdded),
        decisions: item(r.decisions),
        questions: item(r.questions),
        unverifiedClaims: item(r.unverifiedClaims),
        confidence: r.confidence ?? "medium",
        at: Date.now(),
        attempt: a.n,
      }
      // Keep the whole report within the cap: the longest list is trimmed first, each to a few
      // entries at least; files and unverified claims matter most, so they go last.
      const lists = ["decisions", "questions", "testsAdded", "filesChanged", "unverifiedClaims"] as const
      while (JSON.stringify(report).length > MAX_REPORT * 2) {
        const longest = lists.filter((k) => report[k].length > 3).sort((x, y) => report[y].length - report[x].length)[0]
        if (!longest) break
        report[longest].pop()
      }
      // Lists are at their floor and the report is still too long: shorten the longest text.
      while (JSON.stringify(report).length > MAX_REPORT * 2) {
        const texts = [
          { length: () => report.summary.length, cut: (n: number) => (report.summary = report.summary.slice(0, n)) },
          ...lists.flatMap((k) =>
            report[k].map((_, i) => ({ length: () => report[k][i]!.length, cut: (n: number) => (report[k][i] = report[k][i]!.slice(0, n)) })),
          ),
        ].sort((x, y) => y.length() - x.length())
        const biggest = texts[0]!
        if (biggest.length() < 2) break
        biggest.cut(Math.floor(biggest.length() / 2))
      }
      t.reports.push(report)
      a.seenAt = report.at
      this.renewLocks(id, a)
      t.status = "review"
      this.event("report", { task: id, attempt: a.n })
    })
  }

  /** A fact a worker shares, attributed to its attempt (checked under the board's lock). */
  finding(text: string, opts: { tags?: string[]; paths?: string[]; task?: string; token?: string } = {}): Promise<Note> {
    return this.addNote("findings.jsonl", text, { tags: opts.tags, paths: opts.paths }, () => {
      if (!opts.task) return undefined
      const t = this.task(opts.task)
      return { task: t.id, attempt: this.worker(t, opts.token ?? "").n }
    })
  }

  private addNote(
    file: string,
    text: string,
    opts: { tags?: string[]; paths?: string[]; confidence?: Note["confidence"]; source?: Note["source"] },
    sourceOf?: () => Note["source"],
  ) {
    const body = text.trim().slice(0, MAX_NOTE)
    if (!body) return Promise.reject(new Error("a note needs text"))
    return this.mutate(() => {
      if (sourceOf) opts = { ...opts, source: sourceOf() }
      // The same fact twice is one note.
      const id = `n-${createHash("sha256").update(body.toLowerCase()).digest("hex").slice(0, 8)}`
      const existing = this.readNotes(file).find((n) => n.id === id)
      if (existing) return existing
      const note: Note = { id, text: body, tags: clean(opts.tags), paths: clean(opts.paths), source: opts.source, confidence: opts.confidence, at: Date.now() }
      fs.appendFileSync(path.join(this.dir, file), `${JSON.stringify(note)}\n`, { mode: 0o600 })
      this.event(file.startsWith("memory") ? "remember" : "finding", { id, source: opts.source })
      return note
    })
  }

  private lockFile(p: string) {
    return path.join(this.locksDir, `${createHash("sha256").update(normalize(p)).digest("hex").slice(0, 16)}.json`)
  }

  /** Advisory leases on paths. All or nothing: a conflict names its holder and takes nothing. */
  lock(id: string, token: string, paths: string[]): Promise<{ ok: true } | { ok: false; conflicts: Lock[] }> {
    return this.mutate(() => {
      const t = this.task(id)
      const a = this.worker(t, token)
      const want = clean(paths).map(normalize)
      if (!want.length) throw new Error("lock needs at least one path")
      // Locks are repository-relative and specific: "**", absolute paths or ".." would lock
      // everything, or nothing that another worktree's lock could ever overlap.
      for (const p of want)
        if (!p || p === "." || /^(\/|[A-Za-z]:)/.test(p) || p.split("/").includes("..") || !p.replace(/\/?[^/]*[*?[].*$/, ""))
          throw new Error(`cannot lock "${p}": use a path relative to the repository root, not a pattern for everything`)
      const conflicts = this.locks().filter((l) => !(l.task === id && l.attempt === a.n) && want.some((p) => overlaps(p, l.path)))
      if (conflicts.length) return { ok: false as const, conflicts }
      for (const p of want) writeJson(this.lockFile(p), { path: p, task: id, attempt: a.n, expires: Date.now() + LEASE_MS } satisfies Lock)
      this.event("lock", { task: id, paths: want })
      return { ok: true as const }
    })
  }

  workerUnlock(id: string, token: string, paths: string[]): Promise<number> {
    return this.mutate(() => {
      const a = this.worker(this.task(id), token)
      let n = 0
      for (const p of clean(paths).map(normalize)) {
        const l = readJson<Lock>(this.lockFile(p))
        if (l && l.task === id && l.attempt === a.n) {
          fs.rmSync(this.lockFile(p), { force: true })
          n++
        }
      }
      return n
    })
  }

  /** End the task's live attempt, if any, and release its locks. */
  private endAttempt(t: Task, outcome: NonNullable<Attempt["outcome"]>, note?: string, cost?: number) {
    const a = current(t)
    if (a && !a.endedAt) {
      Object.assign(a, { endedAt: Date.now(), outcome, note })
      if (cost !== undefined) Object.assign(a, { cost, costGiven: true })
    }
    this.releaseLocks(t.id)
  }

  private renewLocks(id: string, a: Attempt) {
    for (const l of this.locks()) if (l.task === id && l.attempt === a.n) writeJson(this.lockFile(l.path), { ...l, expires: Date.now() + LEASE_MS })
  }

  private releaseLocks(id: string) {
    for (const f of fs.readdirSync(this.locksDir)) {
      const l = readJson<Lock>(path.join(this.locksDir, f))
      if (l?.task === id) fs.rmSync(path.join(this.locksDir, f), { force: true })
    }
  }
}

// ------------------------------------------------------------------ helpers

export function current(t: Task): Attempt | undefined {
  return t.attempts[t.attempts.length - 1]
}

function clean(list?: string[]): string[] {
  return [...new Set((list ?? []).map((s) => String(s).trim()).filter(Boolean))]
}

function normalize(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .replace(/\/\*\*$/, "")
}

/** Two scope entries overlap when one is the other or contains it (globs are treated as their directory). */
const totalCost = (t: Task) => t.attempts.reduce((n, a) => n + (a.cost ?? 0), 0)

export function overlaps(a: string, b: string): boolean {
  const base = (p: string) => normalize(p).replace(/\/?[^/]*[*?[].*$/, "")
  const x = base(a)
  const y = base(b)
  if (!x || !y) return true // a scope of "**" or "*" covers everything
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
}

function dependsOn(all: Task[], from: string, to: string, seen = new Set<string>()): boolean {
  const t = all.find((x) => x.id === from)
  if (!t || seen.has(from)) return false
  seen.add(from)
  return t.deps.includes(to) || t.deps.some((d) => dependsOn(all, d, to, seen))
}

function findCycle(all: Task[]): string[] | undefined {
  const state = new Map<string, "visiting" | "done">()
  const stack: string[] = []
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === "done") return undefined
    if (state.get(id) === "visiting") return [...stack.slice(stack.indexOf(id)), id]
    state.set(id, "visiting")
    stack.push(id)
    for (const d of all.find((t) => t.id === id)?.deps ?? []) {
      const c = visit(d)
      if (c) return c
    }
    stack.pop()
    state.set(id, "done")
    return undefined
  }
  for (const t of all) {
    const c = visit(t.id)
    if (c) return c
  }
  return undefined
}

/** Notes that overlap the tags, paths or words asked for come first, then the newest. */
function rank(notes: Note[], f: { tags?: string[]; paths?: string[]; query?: string }): Note[] {
  const words = (f.query ?? "")
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2)
  const score = (n: Note) =>
    (f.tags ?? []).filter((t) => n.tags.includes(t)).length * 3 +
    (f.paths ?? []).filter((p) => n.paths.some((q) => overlaps(p, q))).length * 3 +
    words.filter((w) => n.text.toLowerCase().includes(w) || n.tags.includes(w)).length
  const filtering = (f.tags?.length ?? 0) + (f.paths?.length ?? 0) + words.length > 0
  return notes
    .map((n) => ({ n, s: score(n) }))
    .filter((x) => !filtering || x.s > 0)
    .sort((a, b) => b.s - a.s || b.n.at - a.n.at)
    .map((x) => x.n)
}
