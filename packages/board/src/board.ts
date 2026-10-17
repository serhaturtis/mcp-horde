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

// ------------------------------------------------------------------ project

/**
 * The board belongs to a repository, shared by every worktree of it: the key
 * is the main checkout's real path (git's common directory), so a worker in
 * `horde/<name>` and the orchestrator in the main checkout see one board.
 */
export async function projectOf(directory: string): Promise<{ root: string; key: string }> {
  const common = await git(directory, "rev-parse", "--path-format=absolute", "--git-common-dir").catch(() => undefined)
  const root = common ? path.dirname(common) : path.resolve(directory)
  const real = fs.realpathSync.native(root)
  const hash = createHash("sha256")
    .update(process.platform === "win32" ? real.toLowerCase() : real)
    .digest("hex")
    .slice(0, 10)
  return { root: real, key: `${path.basename(real).replace(/[^\w.-]+/g, "_")}-${hash}` }
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
    const { key } = await projectOf(directory)
    return new Board(path.join(stateRoot, key))
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
        byId.set(n.id, { ...byId.get(n.id), ...n })
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
      const fresh: Task[] = inputs.map((p, i) => {
        if (!p.title?.trim() || !p.goal?.trim()) throw new Error(`task ${i + 1}: title and goal are required`)
        return {
          id: this.newId(existing),
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
      const prev = t.attempts[t.attempts.length - 1]
      if (prev && !prev.endedAt) {
        prev.endedAt = Date.now()
        prev.outcome = "abandoned"
      }
      attempt = { n: t.attempts.length + 1, agent, tier: t.tier, token: randomBytes(4).toString("hex"), startedAt: Date.now() }
      t.attempts.push(attempt)
      t.status = "claimed"
      this.event("assign", { task: id, attempt: attempt.n, agent })
    }).then((task) => ({ task, attempt }))
  }

  accept(id: string, opts: { note?: string; cost?: number } = {}): Promise<Task> {
    return this.update(id, (t) => {
      const a = current(t)
      if (a && !a.endedAt) Object.assign(a, { endedAt: Date.now(), outcome: "accepted", note: opts.note, cost: opts.cost })
      if (opts.cost) t.cost += opts.cost
      t.status = "done"
      this.releaseLocks(id)
      this.event("accept", { task: id })
    })
  }

  /** The attempt failed: retry (optionally on the next tier), or give up on the task. */
  fail(id: string, opts: { reason: string; retry?: boolean; escalate?: boolean; cost?: number }): Promise<Task> {
    return this.update(id, (t) => {
      const a = current(t)
      if (a && !a.endedAt) Object.assign(a, { endedAt: Date.now(), outcome: "failed", note: opts.reason, cost: opts.cost })
      if (opts.cost) t.cost += opts.cost
      if (opts.escalate) t.tier++
      t.status = opts.retry === false ? "failed" : "open"
      this.releaseLocks(id)
      this.event("fail", { task: id, reason: opts.reason, escalate: !!opts.escalate })
    })
  }

  block(id: string, on: string): Promise<Task> {
    return this.update(id, (t) => {
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

  /** The worker proves which attempt it belongs to. Anything else is refused. */
  private worker(t: Task, token: string): Attempt {
    const a = current(t)
    if (!a || a.token !== token || a.endedAt) throw new Error(`token does not match the current attempt of ${t.id}; this attempt was closed or replaced`)
    if (!["claimed", "working"].includes(t.status)) throw new Error(`${t.id} is ${t.status}; nothing to do`)
    return a
  }

  seen(id: string, token: string, progress?: string): Promise<Task> {
    return this.update(id, (t) => {
      const a = this.worker(t, token)
      a.seenAt = Date.now()
      if (progress) a.progress = progress.slice(0, MAX_NOTE)
      if (t.status === "claimed") t.status = "working"
      // Progress renews this attempt's locks.
      for (const l of this.locks()) {
        if (l.task === id && l.attempt === a.n) writeJson(this.lockFile(l.path), { ...l, expires: Date.now() + LEASE_MS })
      }
      if (progress) this.event("progress", { task: id, attempt: a.n, note: a.progress })
    })
  }

  report(id: string, token: string, r: Partial<Omit<Report, "at" | "attempt">> & { summary: string }): Promise<Task> {
    return this.update(id, (t) => {
      const a = this.worker(t, token)
      const report: Report = {
        summary: r.summary.slice(0, MAX_REPORT),
        filesChanged: clean(r.filesChanged),
        testsAdded: clean(r.testsAdded),
        decisions: clean(r.decisions),
        questions: clean(r.questions),
        unverifiedClaims: clean(r.unverifiedClaims),
        confidence: r.confidence ?? "medium",
        at: Date.now(),
        attempt: a.n,
      }
      // Keep the whole report within the cap: lists are trimmed after the summary.
      while (JSON.stringify(report).length > MAX_REPORT * 2 && (report.decisions.length || report.filesChanged.length > 20)) {
        if (report.decisions.length) report.decisions.pop()
        else report.filesChanged.pop()
      }
      t.reports.push(report)
      a.seenAt = report.at
      t.status = "review"
      this.event("report", { task: id, attempt: a.n })
    })
  }

  finding(text: string, opts: { tags?: string[]; paths?: string[]; task?: string; token?: string } = {}): Promise<Note> {
    let source: Note["source"]
    if (opts.task) {
      const t = this.task(opts.task)
      source = { task: t.id, attempt: this.worker(t, opts.token ?? "").n }
    }
    return this.addNote("findings.jsonl", text, { tags: opts.tags, paths: opts.paths, source })
  }

  private addNote(file: string, text: string, opts: { tags?: string[]; paths?: string[]; confidence?: Note["confidence"]; source?: Note["source"] }) {
    const body = text.trim().slice(0, MAX_NOTE)
    if (!body) return Promise.reject(new Error("a note needs text"))
    return this.mutate(() => {
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
