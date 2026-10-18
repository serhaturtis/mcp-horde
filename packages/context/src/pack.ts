import { fitSections, isTestPath, type Section } from "@mcp-horde/core"
import { isProjectFile, type Project, readText, relPath, select } from "./files.js"
import { fileInfo, type TestLink, testsFor } from "./graph.js"
import { INSTRUCTION_FILES } from "./map.js"
import { numbered, outline } from "./search.js"

export interface PackOptions {
  /** What the work is about; identifiers and paths in it pick symbols and regions. */
  goal: string
  /** Paths or globs the work is confined to. */
  scope?: string[]
  /** Extra files to include. */
  files?: string[]
  /** Symbols to include with their definitions. */
  symbols?: string[]
  budgetTokens?: number
}

/** A file shown whole when it is at most this long; otherwise its outline and relevant regions. */
const SMALL_FILE = 4000
const MAX_FILES = 8
const MAX_SYMBOLS = 8
const SYMBOL_LINES = 60
const CONVENTION_LINES = 60

/** Identifiers worth looking up in a goal: `backticked`, camelCase, PascalCase, snake_case, dotted. */
export function goalTerms(goal: string): { identifiers: string[]; words: string[]; paths: string[] } {
  const ids = new Set<string>()
  for (const m of goal.matchAll(/`([^`\n]+)`/g)) for (const p of m[1]!.split(/[^\w$]+/)) if (p.length > 2) ids.add(p)
  for (const m of goal.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
    const w = m[1]!
    if (/[a-z][A-Z]|^[A-Z][a-z]+[A-Z]|_[a-z]|[a-z]_/.test(w) && w.length > 3) ids.add(w)
  }
  const paths = [...goal.matchAll(/(?:^|\s|`)((?:[\w.-]+\/)+[\w.-]+|[\w-]+\.(?:ts|tsx|js|jsx|mjs|py|go|rs|java|kt|cs))(?=$|[\s`,.;:)])/g)].map((m) => m[1]!)
  const words = [...new Set(goal.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? [])].filter((w) => !STOP.has(w))
  return { identifiers: [...ids], words, paths }
}

const STOP = new Set(
  "this that with from into when then than they them their there what which while should would could must have been make makes made only also each other more most some such very just like does done added adds using used uses file files code test tests change changes the and for are not but all any can its use add new".split(
    " ",
  ),
)

/** Lines matching any of the words, merged into regions of ±3 lines (at most `max` regions). */
function regions(text: string, words: string[], max = 3): [number, number][] {
  if (!words.length) return []
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i")
  const lines = text.split(/\r?\n/)
  const out: [number, number][] = []
  for (let i = 0; i < lines.length && out.length <= max; i++) {
    if (!re.test(lines[i]!)) continue
    const a = Math.max(1, i + 1 - 3)
    const b = Math.min(lines.length, i + 1 + 3)
    const last = out[out.length - 1]
    if (last && a <= last[1] + 1) last[1] = b
    else out.push([a, b])
  }
  return out.slice(0, max)
}

/**
 * Code context for a task, within a token budget: the scoped files (whole when small,
 * outline plus relevant regions when large), the definitions of symbols the goal names,
 * the tests that cover the scope, and the project's instruction files. Sections are
 * kept in that priority order and trimmed to fit.
 */
export function pack(project: Project, opts: PackOptions): string {
  const terms = goalTerms(opts.goal)
  // Paths as given, or a bare file name that names exactly one project file.
  const byName = (f: string) => {
    if (isProjectFile(project, f) || f.includes("/")) return f
    const same = project.files.filter((x) => x.endsWith(`/${f}`))
    return same.length === 1 ? same[0]! : f
  }
  const explicit = [...new Set([...(opts.files ?? []), ...terms.paths].map((f) => byName(relPath(project, f))))].filter((f) => isProjectFile(project, f))
  const scoped = opts.scope?.length ? select(project, opts.scope) : []
  const words = [...terms.identifiers, ...terms.words]
  const score = (f: string) => {
    const text = (readText(project, f) ?? "").toLowerCase()
    return words.reduce((n, w) => n + (f.toLowerCase().includes(w.toLowerCase()) ? 3 : 0) + (text.includes(w.toLowerCase()) ? 1 : 0), 0)
  }
  const ranked = [
    ...new Set([
      ...explicit,
      ...scoped
        .map((f) => ({ f, s: score(f), test: isTestPath(f) ? 1 : 0 }))
        // Sources before their tests at equal relevance.
        .sort((a, b) => b.s - a.s || a.test - b.test)
        .map((x) => x.f),
    ]),
  ]
  const shown = ranked.slice(0, MAX_FILES)
  const sections: Section[] = []

  if (opts.scope?.length && !scoped.length) sections.push({ text: `The scope (${opts.scope.join(", ")}) matches no existing files yet.` })

  // Symbols the goal names (or the caller asked for), with their definitions; found first so
  // large files do not repeat their lines.
  const wanted = [...new Set([...(opts.symbols ?? []), ...terms.identifiers])]
  const symbolSections: Section[] = []
  const covers: { file: string; a: number; b: number }[] = []
  // Definitions in the files the work is about come before same-named ones elsewhere.
  const searchOrder = [...new Set([...explicit, ...scoped, ...project.files])]
  for (const name of wanted) {
    if (symbolSections.length >= MAX_SYMBOLS) break
    for (const f of searchOrder) {
      const d = fileInfo(project, f)?.defs.find((x) => x.name === name)
      if (!d) continue
      const text = readText(project, f) ?? ""
      if (shown.includes(f) && text.length <= SMALL_FILE) break // shown whole below
      const end = Math.min(d.end, d.line + SYMBOL_LINES - 1)
      covers.push({ file: f, a: d.line, b: end })
      symbolSections.push({
        text: `### ${d.kind} ${name} (${f}:${d.line}-${d.end})\n${numbered(text, d.line, end)}${end < d.end ? `\n… (${d.end - end} more lines)` : ""}`,
        group: "symbols",
        omitted: (k) => `(${k} more definition(s) named in the task not shown)`,
      })
      break
    }
  }

  for (const f of shown) {
    const text = readText(project, f)
    if (text === undefined) continue
    const n = text.split(/\r?\n/).length
    let body: string
    if (text.length <= SMALL_FILE) body = `### ${f}\n${numbered(text)}`
    else {
      const defs = fileInfo(project, f)?.defs ?? []
      const parts = regions(text, words)
        .filter(([a, b]) => !covers.some((c) => c.file === f && a >= c.a && b <= c.b))
        .map(([a, b]) => numbered(text, a, b))
      body = `### ${f} (${n} lines; outline${parts.length ? " and the lines that mention the task" : ""}${covers.some((c) => c.file === f) ? "; named definitions below" : ""})\n${outline(defs) || "(no definitions found)"}${parts.length ? `\n…\n${parts.join("\n…\n")}` : ""}`
    }
    sections.push({ text: body, group: "files", omitted: (k) => `(${k} more file(s) in scope not shown; ask context_file for them)` })
  }
  if (ranked.length > shown.length)
    sections.push({ text: `Also in scope: ${ranked.slice(shown.length, shown.length + 40).join(", ")}${ranked.length > shown.length + 40 ? ", …" : ""}` })

  sections.push(...symbolSections)

  const covered = scoped.length ? testsFor(project, scoped.slice(0, 200)) : new Map<string, TestLink[]>()
  const testLines = [...covered]
    .filter(([f, ts]) => ts.length && !ts.every((t) => t.test === f))
    .map(([f, ts]) => `- ${f}: ${ts.map((t) => `${t.test} (${t.why})`).join(", ")}`)
  if (testLines.length) sections.push({ text: `### Tests that cover the scope\n${testLines.slice(0, 30).join("\n")}` })
  else if (scoped.length)
    sections.push({ text: "### Tests that cover the scope\nNone found: add tests next to the code, following the project's conventions." })

  for (const f of INSTRUCTION_FILES) {
    const text = readText(project, f)
    if (!text) continue
    const lines = text.split(/\r?\n/)
    sections.push({
      text: `### ${f} (project conventions${lines.length > CONVENTION_LINES ? `, first ${CONVENTION_LINES} of ${lines.length} lines` : ""})\n${lines.slice(0, CONVENTION_LINES).join("\n")}`,
      group: "conventions",
      omitted: (k) => `(${k} instruction file(s) not shown: ${INSTRUCTION_FILES.filter((x) => project.files.includes(x)).join(", ")})`,
    })
  }
  if (!sections.length) return ""
  sections.unshift({ text: "## Code context", required: true })
  return fitSections(sections, (opts.budgetTokens ?? 3000) * 4, "\n\n")
}
