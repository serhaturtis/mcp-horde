import fs from "node:fs"
import path from "node:path"
import { formatUsd, type Tier, tierLabel } from "@mcp-horde/core"
import { type Board, current, LEASE_MS, type ReportCheck, type Task } from "./board.js"
import { renderTask } from "./render.js"

/**
 * `horde watch`: the board live in a terminal, for people. Read-only: it never changes the
 * board. The frame is a pure function of the board (renderWatch), so it is tested without a
 * terminal; watch() only draws it, refreshes it and reads keys.
 */

export interface WatchState {
  /** Index of the selected task in the list. */
  selected: number
  /** A task's full view instead of the list, scrolled by `scroll` lines. */
  detail?: { id: string; text: string; scroll: number; check?: ReportCheck }
}

export interface Frame {
  lines: string[]
  /** Task ids in list order, for moving the selection. */
  order: string[]
}

export interface FrameOptions {
  width: number
  height: number
  now?: number
  tiers?: Tier[]
  color?: boolean
  title?: string
}

const ORDER: Task["status"][] = ["review", "working", "claimed", "blocked", "failed", "open", "done"]

const COLORS: Record<Task["status"], string> = {
  review: "33", // yellow: needs a decision
  working: "36",
  claimed: "36",
  blocked: "35",
  failed: "31",
  open: "0",
  done: "32",
}

const paint = (on: boolean, code: string, s: string) => (on && code !== "0" ? `\x1b[${code}m${s}\x1b[0m` : s)

/** Fit `s` into exactly `n` columns. */
const cell = (s: string, n: number) => (n <= 0 ? "" : s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s.padEnd(n))

const clock = (t: number) => new Date(t).toTimeString().slice(0, 8)

const ago = (t: number, now: number) => {
  const s = Math.max(0, Math.round((now - t) / 1000))
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`
}

/** What the current attempt's agent is doing, in a few words. */
function agentCell(t: Task, now: number): string {
  const a = current(t)
  if (!a || a.endedAt) return ""
  const who = `#${a.n}${a.agent ? ` ${a.agent}` : ""}`
  if (a.activity) return `${who} ${a.activity.state}${a.activity.gate ? ` · gate ${a.activity.gate}` : ""}`
  const seen = a.seenAt ?? a.startedAt
  return `${who} ${now - seen > LEASE_MS ? "STALE" : "seen"} ${ago(seen, now)} ago`
}

/** The board as lines for a terminal of the given size. */
export function renderWatch(board: Board, state: WatchState, opts: FrameOptions): Frame {
  const now = opts.now ?? Date.now()
  const color = opts.color ?? false
  const width = Math.max(40, opts.width)
  const height = Math.max(10, opts.height)
  const tasks = board.tasks().sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.createdAt - b.createdAt)
  const order = tasks.map((t) => t.id)
  const counts = ORDER.map((s) => [s, tasks.filter((t) => t.status === s).length] as const).filter(([, n]) => n)
  const cost = tasks.reduce((n, t) => n + t.cost, 0)
  const left = (c: boolean) =>
    `horde · ${opts.title ?? "board"} · ${tasks.length ? counts.map(([s, n]) => paint(c, COLORS[s], `${n} ${s}`)).join(", ") : "no tasks"}${cost ? ` · ${formatUsd(cost)}` : ""}`
  const right = clock(now)
  const header = `${left(color)}${" ".repeat(Math.max(1, width - left(false).length - right.length))}${right}`

  if (state.detail) {
    const body = state.detail.text.split("\n").flatMap((l) => wrap(l, width))
    const room = height - 3
    const scroll = Math.max(0, Math.min(state.detail.scroll, body.length - room))
    return {
      lines: [
        header,
        "",
        ...body.slice(scroll, scroll + room),
        ...pad(room - body.slice(scroll, scroll + room).length),
        hint(color, "↑↓ scroll · esc back · q quit"),
      ],
      order,
    }
  }

  // Columns: marker, id, status, title, tier, agent, cost. Narrow terminals drop tier and agent.
  const wide = width >= 110
  const w = { id: 9, status: 9, tier: wide ? 24 : 0, agent: width >= 80 ? 30 : 0, cost: 8 }
  const titleW = Math.max(12, width - 2 - w.id - w.status - w.tier - w.agent - w.cost - 1)
  const head = paint(
    color,
    "2",
    `  ${cell("TASK", w.id)}${cell("STATUS", w.status)}${cell("TITLE", titleW)} ${cell("TIER", w.tier)}${cell("AGENT", w.agent)}${cell("COST", w.cost)}`,
  )
  const rows = tasks.map((t, i) => {
    const mark = i === state.selected ? "▸ " : "  "
    const line = `${mark}${cell(t.id, w.id)}${paint(color, COLORS[t.status], cell(t.status, w.status))}${cell(t.title, titleW)} ${cell(w.tier ? tierLabel(t.tier, opts.tiers ?? []) : "", w.tier)}${cell(agentCell(t, now), w.agent)}${cell(t.cost ? formatUsd(t.cost) : "", w.cost)}`
    // Reverse video for the selection, kept on across the status color's reset.
    return i === state.selected && color ? `\x1b[7m${line.split("\x1b[0m").join("\x1b[0m\x1b[7m")}\x1b[0m` : line
  })

  const locks = board.locks(now)
  const footer: string[] = []
  if (locks.length) footer.push(cell(`locks: ${locks.map((l) => `${l.path} → ${l.task}`).join(", ")}`, width))
  const events = recentEvents(board.dir, 50)
  const room = height - 3 - footer.length
  // The list gets what it needs (scrolled to keep the selection visible); events get the rest.
  const listRoom = Math.max(3, Math.min(rows.length + 1, room - Math.min(events.length + 1, 6)))
  const first = Math.max(0, Math.min(state.selected - listRoom + 2, rows.length - (listRoom - 1)))
  const list = tasks.length ? [head, ...rows.slice(first, first + listRoom - 1)] : ["  The board is empty: plan tasks with board_plan."]
  const eventRoom = room - list.length - 1
  const recent = eventRoom > 1 && events.length ? ["", paint(color, "2", "recent"), ...events.slice(-(eventRoom - 1)).map((e) => cell(e, width))] : []
  const used = list.length + recent.length + footer.length
  return {
    lines: [header, ...list, ...recent, ...pad(height - 2 - used), ...footer, hint(color, tasks.length ? "↑↓ select · enter details · q quit" : "q quit")],
    order,
  }
}

const pad = (n: number) => Array.from({ length: Math.max(0, n) }, () => "")

const hint = (color: boolean, s: string) => paint(color, "2", s)

function wrap(line: string, width: number): string[] {
  if (line.length <= width) return [line]
  const out: string[] = []
  for (let i = 0; i < line.length; i += width) out.push(line.slice(i, i + width))
  return out
}

/** The board's latest events, one line each (the end of events.jsonl only). */
export function recentEvents(dir: string, max: number): string[] {
  const file = path.join(dir, "events.jsonl")
  let text: string
  try {
    const size = fs.statSync(file).size
    const fd = fs.openSync(file, "r")
    try {
      const len = Math.min(size, 64 * 1024)
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, size - len)
      text = buf.toString("utf8")
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return []
  }
  const out: string[] = []
  for (const line of text.split("\n").slice(-max - 1)) {
    try {
      const { at, type, ...rest } = JSON.parse(line) as { at: number; type: string; [k: string]: unknown }
      const detail = Object.entries(rest)
        .filter(([, v]) => v !== undefined && v !== false && !(Array.isArray(v) && !v.length))
        .map(([k, v]) => (k === "task" ? String(v) : `${k} ${Array.isArray(v) ? v.join(",") : String(v)}`))
        .join(" · ")
      out.push(`  ${clock(at)}  ${type.padEnd(9)}${detail}`)
    } catch {
      // A partial first line (cut by the 64 KB window) or a line being written.
    }
  }
  return out.slice(-max)
}

export interface WatchOptions {
  title?: string
  tiers?: Tier[]
  intervalMs?: number
}

/** Draw the board until the user quits. Without a terminal, print one frame (no color) and return. */
export async function watch(board: Board, opts: WatchOptions = {}): Promise<void> {
  const out = process.stdout
  const size = () => ({ width: out.columns || 100, height: out.rows || 30 })
  const state: WatchState = { selected: 0 }
  if (!out.isTTY || !process.stdin.isTTY) {
    out.write(
      `${renderWatch(board, state, { ...size(), tiers: opts.tiers, title: opts.title })
        .lines.join("\n")
        .trimEnd()}\n`,
    )
    return
  }
  const color = !process.env.NO_COLOR
  let order: string[] = []
  const draw = () => {
    try {
      // The open task is re-read on every frame; its diff check is from when it was opened.
      if (state.detail) state.detail.text = renderTask(board.task(state.detail.id), "full", Date.now(), state.detail.check, opts.tiers)
      const frame = renderWatch(board, state, { ...size(), tiers: opts.tiers, title: opts.title, color })
      order = frame.order
      state.selected = Math.min(state.selected, Math.max(0, order.length - 1))
      out.write(`\x1b[H${frame.lines.map((l) => `${l}\x1b[K`).join("\n")}\x1b[J`)
    } catch (err) {
      out.write(`\x1b[H\x1b[Jcannot read the board: ${(err as Error).message}`)
    }
  }
  out.write("\x1b[?1049h\x1b[?25l")
  process.stdin.setRawMode(true)
  process.stdin.resume()
  const timer = setInterval(draw, opts.intervalMs ?? 1000)
  out.on("resize", draw)
  await new Promise<void>((resolve) => {
    const quit = () => {
      clearInterval(timer)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdin.off("data", onKey)
      out.write("\x1b[?25h\x1b[?1049l")
      resolve()
    }
    const onKey = (data: Buffer) => {
      const k = data.toString()
      if (k === "q" || k === "\u0003") return quit()
      const up = k === "\x1b[A" || k === "k"
      const down = k === "\x1b[B" || k === "j"
      if (state.detail) {
        if (k === "\x1b" || k === "b" || k === "\x7f") state.detail = undefined
        else if (up) state.detail.scroll = Math.max(0, state.detail.scroll - 1)
        else if (down) state.detail.scroll++
        else if (k === " ") state.detail.scroll += size().height - 4
      } else if (up) state.selected = Math.max(0, state.selected - 1)
      else if (down) state.selected = Math.min(order.length - 1, state.selected + 1)
      else if (k === "\r" && order[state.selected]) {
        const id = order[state.selected]!
        void board
          .checkReport(id)
          .catch(() => undefined)
          .then((check) => {
            state.detail = { id, text: "", scroll: 0, check }
            draw()
          })
        return
      }
      draw()
    }
    process.stdin.on("data", onKey)
    process.once("SIGTERM", quit)
    draw()
  })
}
