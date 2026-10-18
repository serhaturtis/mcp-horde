import path from "node:path"
import { fitSections, isTestPath, type Section } from "@mcp-horde/core"
import { type Project, readText } from "./files.js"
import { LANG_NAMES, type Lang, langOf } from "./lang.js"

const MANIFESTS =
  /(^|\/)(package\.json|pyproject\.toml|setup\.py|setup\.cfg|requirements[^/]*\.txt|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|[^/]+\.csproj|[^/]+\.sln|Makefile|justfile|deno\.jsonc?|tsconfig\.json|horde\.json)$/
export const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md", "CONTRIBUTING.md", ".github/copilot-instructions.md", ".cursorrules"]
const ENTRY =
  /(^|\/)(src\/)?(index|main|app|server|cli|lib|mod)\.(ts|tsx|js|mjs|py|go|rs)$|(^|\/)(__main__|manage|wsgi|asgi)\.py$|(^|\/)cmd\/[^/]+\/main\.go$|(^|\/)Program\.cs$/

/** Entry points: package.json main/bin/exports targets, conventional names, and horde.json's list. */
export function entryPoints(project: Project): string[] {
  const out = new Set<string>(project.settings.entrypoints)
  for (const pj of project.files.filter((f) => /(^|\/)package\.json$/.test(f))) {
    let data: Record<string, unknown>
    try {
      data = JSON.parse(readText(project, pj) ?? "{}")
    } catch {
      continue
    }
    const dir = path.posix.dirname(pj)
    const targets: string[] = []
    const collect = (v: unknown) => {
      if (typeof v === "string") targets.push(v)
      else if (v && typeof v === "object") for (const x of Object.values(v)) collect(x)
    }
    collect(data.main)
    collect(data.bin)
    collect(data.exports)
    for (const t of targets) {
      const rel = path.posix.normalize(path.posix.join(dir, t))
      // Point at sources when the target is a build output that has a source twin.
      const src = rel.replace(/^(.*?)(dist|build|lib)\//, "$1src/").replace(/\.(m|c)?js$/, ".ts")
      if (!langOf(rel)) continue
      if (project.files.includes(src)) out.add(src)
      else if (project.files.includes(rel)) out.add(rel)
    }
  }
  for (const f of project.files) if (ENTRY.test(f) && f.split("/").length <= 4 && !isTestPath(f)) out.add(f)
  return [...out].slice(0, 30)
}

interface DirStat {
  files: number
  tests: number
  langs: Map<Lang, number>
}

/**
 * A map of the project: directories (to `depth`) with file counts, languages and test
 * counts; manifests, entry points, test directories and instruction files. Instruction
 * files are listed, not inlined.
 */
export function projectMap(project: Project, opts: { depth?: number; budgetChars?: number } = {}): string {
  const depth = opts.depth ?? 2
  const dirs = new Map<string, DirStat>()
  const langs = new Map<Lang, number>()
  for (const f of project.files) {
    const parts = f.split("/")
    const lang = langOf(f)
    if (lang) langs.set(lang, (langs.get(lang) ?? 0) + 1)
    for (let d = 1; d <= Math.min(depth, parts.length - 1); d++) {
      const key = parts.slice(0, d).join("/")
      const s = dirs.get(key) ?? { files: 0, tests: 0, langs: new Map() }
      s.files++
      if (isTestPath(f)) s.tests++
      if (lang) s.langs.set(lang, (s.langs.get(lang) ?? 0) + 1)
      dirs.set(key, s)
    }
  }
  const langList = (m: Map<Lang, number>) =>
    [...m]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([l, n]) => `${LANG_NAMES[l]} ${n}`)
      .join(", ")
  const rootFiles = project.files.filter((f) => !f.includes("/"))
  const tree = [...dirs]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([d, s]) => {
      const level = d.split("/").length - 1
      const extra = [langList(s.langs), s.tests && `${s.tests} test${s.tests === 1 ? "" : "s"}`].filter(Boolean).join(" · ")
      return `${"  ".repeat(level)}${path.posix.basename(d)}/  ${s.files} file${s.files === 1 ? "" : "s"}${extra ? ` (${extra})` : ""}`
    })
  const testDirs = [...dirs.keys()].filter((d) => /(^|\/)(__tests__|tests?|spec)$/.test(d))
  const instructions = INSTRUCTION_FILES.filter((f) => project.files.includes(f))
  const sections: Section[] = [
    {
      text: `${path.basename(project.root)}: ${project.files.length}${project.capped ? "+" : ""} files${langs.size ? ` · ${langList(langs)}` : ""}`,
      required: true,
    },
    { text: instructions.length ? `Project instructions (read these): ${instructions.join(", ")}` : "" },
    {
      text: `Manifests: ${
        project.files
          .filter((f) => MANIFESTS.test(f) && f.split("/").length <= 3)
          .slice(0, 20)
          .join(", ") || "none"
      }`,
    },
    { text: `Entry points: ${entryPoints(project).join(", ") || "none found"}` },
    { text: testDirs.length ? `Test directories: ${testDirs.join(", ")}` : "" },
    { text: rootFiles.length ? `Root files: ${rootFiles.slice(0, 40).join(", ")}${rootFiles.length > 40 ? ` (+${rootFiles.length - 40})` : ""}` : "" },
    { text: tree.length ? "Directories:" : "" },
    ...tree.map((t) => ({ text: t, group: "tree", omitted: (n: number) => `… ${n} more directories (raise budget_chars or lower depth)` })),
  ].filter((s) => s.text)
  return fitSections(sections, opts.budgetChars ?? 4000)
}
