import { truncate } from "@mcp-horde/core"
import { type Project, readText, relPath, select } from "./files.js"
import { fileInfo } from "./graph.js"
import type { Definition } from "./lang.js"
import { isCode } from "./syntax.js"

export interface Hit {
  file: string
  line: number
  text: string
}

export type FindKind = "text" | "definition" | "reference"

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * A query as a regular expression: `/re/flags` is used as written; anything else is a
 * literal, case-insensitive unless it has capitals (smart case).
 */
export function queryRegex(query: string, word = false): RegExp {
  const m = /^\/(.+)\/([a-z]*)$/.exec(query)
  if (m) return new RegExp(m[1]!, m[2]!.replace(/g/g, ""))
  const body = word ? `(?<![\\w$])${escapeRe(query)}(?![\\w$])` : escapeRe(query)
  return new RegExp(body, /[A-Z]/.test(query) ? "" : "i")
}

export interface FindOptions {
  kind?: FindKind
  paths?: string[]
  limit?: number
}

export function find(project: Project, query: string, opts: FindOptions = {}): { hits: Hit[]; total: number } {
  const kind = opts.kind ?? "text"
  const limit = opts.limit ?? 50
  const hits: Hit[] = []
  let total = 0
  const files = select(project, opts.paths)
  if (kind === "definition") {
    const re = queryRegex(query)
    const exact: Hit[] = []
    for (const f of files) {
      for (const d of fileInfo(project, f)?.defs ?? []) {
        if (!re.test(d.name)) continue
        total++
        ;(d.name === query ? exact : hits).push({ file: f, line: d.line, text: d.signature })
      }
    }
    return { hits: [...exact, ...hits].slice(0, limit), total }
  }
  const re = queryRegex(query, kind === "reference")
  for (const f of files) {
    const text = readText(project, f)
    if (text === undefined || !re.test(text)) continue
    const info = kind === "reference" ? fileInfo(project, f) : undefined
    const defLines = info ? new Set(info.defs.filter((d) => d.name === query).map((d) => d.line)) : undefined
    const all = info?.spans ? new RegExp(re.source, `${re.flags}g`) : undefined
    const lines = text.split(/\n/)
    let offset = 0
    for (let i = 0; i < lines.length; offset += lines[i]!.length + 1, i++) {
      if (!re.test(lines[i]!) || defLines?.has(i + 1)) continue
      // A parsed file knows its comments and strings: a mention there is no reference.
      if (all && info?.spans && ![...lines[i]!.matchAll(all)].some((m) => isCode(info.spans!, offset + m.index))) continue
      total++
      if (hits.length < limit) hits.push({ file: f, line: i + 1, text: truncate(lines[i]!.trim(), 200) })
    }
  }
  return { hits, total }
}

export interface SymbolInfo {
  file: string
  def: Definition
  /** References outside the definition itself. */
  calls: Hit[]
  callCount: number
}

/** Definitions named `name` (optionally in one file or directory), each with its call sites. */
export function symbol(project: Project, name: string, opts: { path?: string; calls?: number } = {}): SymbolInfo[] {
  const scope = opts.path ? [relPath(project, opts.path)] : undefined
  const defs: { file: string; def: Definition }[] = []
  for (const f of select(project, scope)) for (const d of fileInfo(project, f)?.defs ?? []) if (d.name === name) defs.push({ file: f, def: d })
  if (!defs.length) return []
  const refs = find(project, name, { kind: "reference", limit: 10_000 }).hits
  return defs.map(({ file, def }) => {
    // Call sites: not the definition itself, not comments (its own doc comment included).
    const calls = refs.filter((h) => !(h.file === file && h.line >= def.line && h.line <= def.end) && !/^(\/\/|#|\*|\/\*)/.test(h.text))
    return { file, def, calls: calls.slice(0, opts.calls ?? 10), callCount: calls.length }
  })
}

/** Lines `a..b` (1-based, inclusive) with right-aligned line numbers. */
export function numbered(text: string, a = 1, b = Number.POSITIVE_INFINITY): string {
  const lines = text.split(/\r?\n/)
  // A final newline ends the last line; it does not start another.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  const end = Math.min(b, lines.length)
  const w = String(end).length
  const out: string[] = []
  for (let i = Math.max(1, a); i <= end; i++) out.push(`${String(i).padStart(w)}  ${lines[i - 1]}`)
  return out.join("\n")
}

/** One line per definition: `12-40  function name(args)`; methods indented under their class. */
export function outline(defs: Definition[]): string {
  return defs.map((d) => `${`${d.line}${d.end > d.line ? `-${d.end}` : ""}`.padEnd(9)} ${d.kind === "method" ? "  " : ""}${d.signature}`).join("\n")
}

export interface ExcerptOptions {
  /** "a-b", 1-based inclusive. */
  lines?: string
  symbols?: string[]
  budgetChars?: number
}

/**
 * An excerpt of a file with line numbers: the given lines, the given symbols' definitions,
 * or the whole file when it fits the budget (otherwise its outline and its head).
 */
export function excerpt(project: Project, file: string, opts: ExcerptOptions = {}): string {
  const rel = relPath(project, file)
  const text = readText(project, rel)
  if (text === undefined) throw new Error(project.files.includes(rel) ? `${rel} is binary or too large to read` : `no file ${rel} in ${project.root}`)
  const budget = opts.budgetChars ?? 12_000
  const total = text.split(/\r?\n/).length
  const fit = (s: string) => (s.length > budget ? `${s.slice(0, budget)}\n… (cut at ${budget} chars; ask for a line range)` : s)
  if (opts.lines) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(opts.lines.trim())
    if (!m) throw new Error(`lines must look like "10-40", not "${opts.lines}"`)
    const a = Number(m[1])
    const b = m[2] ? Number(m[2]) : a
    return fit(`${rel} (lines ${a}-${Math.min(b, total)} of ${total})\n${numbered(text, a, b)}`)
  }
  const defs = fileInfo(project, rel)?.defs ?? []
  if (opts.symbols?.length) {
    const want = new Set(opts.symbols)
    const picked = defs.filter((d) => want.has(d.name))
    const missing = opts.symbols.filter((s) => !picked.some((d) => d.name === s))
    const parts = picked.map((d) => `${rel}:${d.line}-${d.end} ${d.kind} ${d.name}\n${numbered(text, d.line, d.end)}`)
    if (missing.length)
      parts.push(
        `not defined in ${rel}: ${missing.join(", ")}${
          defs.length
            ? ` (it defines: ${defs
                .map((d) => d.name)
                .slice(0, 30)
                .join(", ")})`
            : ""
        }`,
      )
    return fit(parts.join("\n\n"))
  }
  const whole = `${rel} (${total} lines)\n${numbered(text)}`
  if (whole.length <= budget) return whole
  const head = numbered(text, 1, 40)
  return fit(`${rel} (${total} lines; too long to show whole: outline, then the first 40 lines)\n${outline(defs) || "(no definitions found)"}\n\n${head}`)
}
