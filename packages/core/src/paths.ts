/** Test files by the common conventions (JS/TS, Python, Go, Rust, Java/Kotlin, C#), on forward-slash paths. */
export const isTestPath = (p: string) =>
  /(^|\/)(__tests__|tests?|spec)\//.test(p) ||
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) ||
  /(^|\/)test_[^/]+\.py$/.test(p) ||
  /_test\.(go|py)$/.test(p) ||
  /(^|\/)tests\/[^/]+\.rs$/.test(p) ||
  /[^/]Tests?\.(java|kt|cs)$/.test(p) ||
  /\.Tests?\//.test(p)

/** Minimal gitignore-style globs: `**`, `*`, `?`; a trailing `/` means the whole directory; no slash matches at any depth. */
export function globMatcher(globs: string[]): (p: string) => boolean {
  const res = globs.map((g) => {
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
      else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    }
    // A directory pattern also covers everything below it.
    return new RegExp(`^${anyDepth ? "(?:.*/)?" : ""}${re}(?:/.*)?$`)
  })
  return (p) => res.some((r) => r.test(p))
}
