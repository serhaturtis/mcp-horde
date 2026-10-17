/** Cut long text at the end, saying how much was dropped. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 20))}… [+${text.length - max + 20} chars]`
}

/** Keep the end of long text (for logs and transcripts the latest part matters most). */
export function truncateHead(text: string, max: number): string {
  if (text.length <= max) return text
  return `[… ${text.length - max} earlier chars omitted …]\n${text.slice(text.length - max)}`
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

export function indent(text: string, by = "    "): string {
  return text
    .split("\n")
    .map((l) => `${by}${l}`)
    .join("\n")
}

export function formatUsd(n: number): string {
  if (n === 0) return "$0"
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`
}

export function formatTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  return s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)}s` : `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`
}

/** A rough token count for budgeting (about 4 characters per token for code and English). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export interface Section {
  text: string
  /** Shown instead of a section that does not fit at all, e.g. "+3 more failures". */
  omitted?: string
  /** A section that must stay, even if only truncated. */
  required?: boolean
}

/**
 * Fit sections, in priority order, into `maxChars`. Sections are kept whole
 * while they fit; the first one that does not fit is truncated if it is
 * required (or there is room for a useful part of it), and the rest are
 * replaced by their `omitted` notes. Notes are always kept so counts survive.
 */
export function fitSections(sections: Section[], maxChars: number, separator = "\n"): string {
  const kept: string[] = []
  const notes: string[] = []
  const length = (parts: string[]) => parts.reduce((n, p) => n + p.length, 0) + Math.max(0, parts.length - 1) * separator.length
  // Room left for one more kept section, after what is kept and the notes collected so far.
  const room = () => maxChars - length([...kept, ...notes]) - (kept.length + notes.length ? separator.length : 0)
  for (const s of sections) {
    const r = room()
    if (s.text.length <= r) kept.push(s.text)
    else if ((s.required || r >= 200) && r > 40) kept.push(truncate(s.text, r))
    else if (s.omitted) notes.push(s.omitted)
  }
  return [...kept, ...notes].join(separator)
}
