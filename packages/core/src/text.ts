/** Cut long text at the end, saying how much was dropped. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  // The marker counts against max; what it reports is exactly what was dropped.
  let keep = Math.max(0, max - 16)
  for (;;) {
    const marker = `… [+${text.length - keep} chars]`
    if (keep + marker.length <= max || keep === 0) return `${text.slice(0, keep)}${marker}`
    keep = Math.max(0, max - marker.length)
  }
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
  /**
   * Shown instead of sections that do not fit. A function gets the number of
   * sections dropped in this section's `group`, so one note can say "+37 more".
   */
  omitted?: string | ((dropped: number) => string)
  /** Sections sharing a group share one omission note (default: each its own). */
  group?: string
  /** A section that must stay, even if only truncated. */
  required?: boolean
}

/**
 * Fit sections, in priority order, into `maxChars`. Sections are kept whole
 * while they fit; one that does not fit is truncated if it is required (or a
 * useful part of it fits), otherwise dropped and counted into its group's
 * note. Notes come last and always survive, so counts are never lost.
 */
export function fitSections(sections: Section[], maxChars: number, separator = "\n"): string {
  const kept: { section: Section; text: string }[] = []
  const dropped = new Map<string, { count: number; note: (n: number) => string }>()
  const render = () => [...kept.map((k) => k.text), ...[...dropped.values()].map((d) => d.note(d.count))].join(separator)
  const drop = (s: Section) => {
    if (!s.omitted) return
    const key = s.group ?? `\0${s.text}`
    const d = dropped.get(key)
    if (d) d.count++
    else dropped.set(key, { count: 1, note: typeof s.omitted === "function" ? s.omitted : () => s.omitted as string })
  }
  for (const s of sections) {
    kept.push({ section: s, text: s.text })
    if (render().length <= maxChars) continue
    kept.pop()
    const room = maxChars - render().length - (kept.length || dropped.size ? separator.length : 0)
    if ((s.required || room >= 200) && room > 40) {
      kept.push({ section: s, text: truncate(s.text, room) })
      if (render().length <= maxChars) continue
      kept.pop()
    }
    drop(s)
  }
  // A grown note can push the total over: shorten the latest optional section to fit, and
  // give it back only when too little of it would be left.
  while (render().length > maxChars) {
    const i = kept.findLastIndex((k) => !k.section.required)
    if (i < 0) break
    const k = kept[i]!
    const shorter = k.text.length - (render().length - maxChars)
    if (shorter > 40 && shorter < k.text.length) k.text = truncate(k.section.text, shorter)
    else drop(kept.splice(i, 1)[0]!.section)
  }
  return render()
}
