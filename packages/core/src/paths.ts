/** Test files by the common conventions (JS/TS, Python, Go, Rust, Java/Kotlin, C#), on forward-slash paths. */
export const isTestPath = (p: string) =>
  /(^|\/)(__tests__|tests?|spec)\//.test(p) ||
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) ||
  /(^|\/)test_[^/]+\.py$/.test(p) ||
  /(^|\/)tests\.py$/.test(p) ||
  /_test\.(go|py)$/.test(p) ||
  /(^|\/)tests\/[^/]+\.rs$/.test(p) ||
  /[^/]Tests?\.(java|kt|cs)$/.test(p) ||
  /\.Tests?\//.test(p)

/** `{a,b}` alternatives (nested too) expanded into plain globs; an unbalanced brace stays literal. */
function expandBraces(glob: string): string[] {
  let depth = 0
  let open = -1
  const commas: number[] = []
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === "{" && depth++ === 0) open = i
    else if (c === "," && depth === 1) commas.push(i)
    else if (c === "}" && depth > 0 && --depth === 0) {
      // "{a}" has no alternatives: literal, like the shell.
      if (!commas.length) return expandBraces(glob.slice(i + 1)).map((rest) => glob.slice(0, i + 1) + rest)
      const pre = glob.slice(0, open)
      const bounds = [open, ...commas, i]
      return bounds.slice(1).flatMap((end, k) => expandBraces(pre + glob.slice(bounds[k]! + 1, end) + glob.slice(i + 1)))
    }
  }
  return [glob]
}

/**
 * Minimal gitignore-style globs: `**`, `*`, `?`, `[abc]`/`[a-z]`/`[!a]` classes and `{a,b}`
 * alternatives; a trailing `/` means the whole directory; no slash matches at any depth.
 */
export function globMatcher(globs: string[]): (p: string) => boolean {
  const res = globs.flatMap(expandBraces).map((g) => {
    let pat = g.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "")
    if (pat.endsWith("/")) pat += "**"
    const anyDepth = !pat.includes("/")
    let re = ""
    for (let i = 0; i < pat.length; i++) {
      const c = pat[i]!
      if (c === "*" && pat[i + 1] === "*") {
        re += pat[i + 2] === "/" ? "(?:.*/)?" : ".*"
        i += pat[i + 2] === "/" ? 2 : 1
      } else if (c === "*") re += "[^/]*"
      else if (c === "?") re += "[^/]"
      else if (c === "[" && pat.indexOf("]", i + 2) > i) {
        // A class never matches "/", like a single path character.
        const end = pat.indexOf("]", i + 2)
        let body = pat.slice(i + 1, end)
        const negate = body[0] === "!" || body[0] === "^"
        if (negate) body = body.slice(1)
        re += `[${negate ? "^/" : ""}${body.replace(/[\\\]^]/g, "\\$&")}]`
        i = end
      } else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    }
    // A directory pattern also covers everything below it.
    return new RegExp(`^${anyDepth ? "(?:.*/)?" : ""}${re}(?:/.*)?$`)
  })
  return (p) => res.some((r) => r.test(p))
}
