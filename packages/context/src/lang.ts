/**
 * Language knowledge for v1: definitions and imports by line-oriented regexes,
 * block extents by braces or indentation. Approximate on purpose (no parser, no
 * native dependencies); good enough to point a worker at the right lines.
 */

export type Lang = "ts" | "js" | "py" | "go" | "rs" | "java" | "kt" | "cs"

const EXT: Record<string, Lang> = {
  ts: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  py: "py",
  go: "go",
  rs: "rs",
  java: "java",
  kt: "kt",
  kts: "kt",
  cs: "cs",
  // Components hold their imports in a <script> block the TS regexes already read.
  vue: "ts",
  svelte: "ts",
  astro: "ts",
}

export const LANG_NAMES: Record<Lang, string> = {
  ts: "TypeScript",
  js: "JavaScript",
  py: "Python",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  cs: "C#",
}

export function langOf(file: string): Lang | undefined {
  const m = /\.([A-Za-z]+)$/.exec(file)
  return m ? EXT[m[1]!.toLowerCase()] : undefined
}

export type DefKind = "function" | "class" | "interface" | "type" | "enum" | "variable" | "method" | "module"

export interface Definition {
  name: string
  kind: DefKind
  /** 1-based line of the definition. */
  line: number
  /** 1-based last line of its block (equal to `line` when unknown). */
  end: number
  /** The definition's first line(s), trimmed: the signature. */
  signature: string
  /** Doc comment or docstring, without comment markers. */
  doc?: string
  exported: boolean
}

const ID = "[A-Za-z_$][\\w$]*"
const KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "new",
  "else",
  "do",
  "try",
  "with",
  "typeof",
  "await",
  "super",
  "this",
  "constructor",
  "throw",
  "delete",
  "void",
  "yield",
  "using",
  "lock",
  "foreach",
  "sizeof",
  "when",
])

type Rule = { re: RegExp; kind: DefKind }

const JS_RULES: Rule[] = [
  { re: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${ID})`), kind: "function" },
  { re: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?class\\s+(${ID})`), kind: "class" },
  { re: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?interface\\s+(${ID})`), kind: "interface" },
  { re: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?type\\s+(${ID})\\s*(?:<[^=]*>)?\\s*=`), kind: "type" },
  { re: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const\\s+)?enum\\s+(${ID})`), kind: "enum" },
  { re: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?namespace\\s+(${ID})`), kind: "module" },
  { re: new RegExp(`^(?:export\\s+)?(?:declare\\s+)?(?:const|let|var)\\s+(${ID})\\s*[=:]`), kind: "variable" },
  // CommonJS: exports.name = …, module.exports.name = …
  { re: new RegExp(`^(?:module\\.)?exports\\.(${ID})\\s*=`), kind: "variable" },
  // Methods in classes and object literals: indented `name(...) {` / `async name(...): T {`.
  {
    re: new RegExp(
      `^\\s+(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\\s+)*\\*?(${ID})\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)?\\s*(?::[^={]+)?\\{?\\s*$`,
    ),
    kind: "method",
  },
]

const RULES: Record<Lang, Rule[]> = {
  ts: JS_RULES,
  js: JS_RULES,
  py: [
    { re: new RegExp(`^\\s*(?:async\\s+)?def\\s+(${ID})`), kind: "function" },
    { re: new RegExp(`^\\s*class\\s+(${ID})`), kind: "class" },
    { re: new RegExp(`^(${ID})\\s*(?::[^=]+)?=(?!=)`), kind: "variable" },
  ],
  go: [
    { re: new RegExp(`^func\\s+\\([^)]*\\)\\s*(${ID})`), kind: "method" },
    { re: new RegExp(`^func\\s+(${ID})`), kind: "function" },
    { re: new RegExp(`^type\\s+(${ID})\\s+(?:struct|interface)`), kind: "class" },
    { re: new RegExp(`^type\\s+(${ID})`), kind: "type" },
    { re: new RegExp(`^(?:var|const)\\s+(${ID})`), kind: "variable" },
  ],
  rs: [
    { re: new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:const\\s+)?(?:async\\s+)?(?:unsafe\\s+)?(?:extern\\s+"[^"]*"\\s+)?fn\\s+(${ID})`), kind: "function" },
    { re: new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:struct|union)\\s+(${ID})`), kind: "class" },
    { re: new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?enum\\s+(${ID})`), kind: "enum" },
    { re: new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:unsafe\\s+)?trait\\s+(${ID})`), kind: "interface" },
    { re: new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?type\\s+(${ID})`), kind: "type" },
    { re: new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?mod\\s+(${ID})\\s*\\{`), kind: "module" },
    { re: new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:const|static)\\s+(?:mut\\s+)?(${ID})\\s*:`), kind: "variable" },
  ],
  java: [
    { re: new RegExp(`^\\s*(?:(?:public|private|protected|static|final|abstract|sealed|non-sealed|strictfp)\\s+)*(?:class|record)\\s+(${ID})`), kind: "class" },
    { re: new RegExp(`^\\s*(?:(?:public|private|protected|static|abstract|sealed)\\s+)*(?:interface|@interface)\\s+(${ID})`), kind: "interface" },
    { re: new RegExp(`^\\s*(?:(?:public|private|protected|static)\\s+)*enum\\s+(${ID})`), kind: "enum" },
    {
      re: new RegExp(
        `^\\s*(?:@\\w+(?:\\([^)]*\\))?\\s+)*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default)\\s+)*(?:<[^>]+>\\s+)?[\\w$.<>\\[\\],? ]+?\\s+(${ID})\\s*\\((?:[^;]*$|[^)]*\\)\\s*\\{.*$)`,
      ),
      kind: "method",
    },
  ],
  kt: [
    {
      re: new RegExp(`^\\s*(?:(?:public|private|protected|internal|open|abstract|sealed|data|inline|value|enum|annotation)\\s+)*class\\s+(${ID})`),
      kind: "class",
    },
    { re: new RegExp(`^\\s*(?:(?:public|private|protected|internal|sealed|fun)\\s+)*interface\\s+(${ID})`), kind: "interface" },
    { re: new RegExp(`^\\s*(?:(?:public|private|protected|internal|data|companion)\\s+)*object\\s+(${ID})`), kind: "class" },
    {
      re: new RegExp(
        `^\\s*(?:(?:public|private|protected|internal|open|override|abstract|suspend|inline|operator|infix|tailrec|external)\\s+)*fun\\s+(?:<[^>]+>\\s+)?(?:[\\w.<>]+\\.)?(${ID})`,
      ),
      kind: "function",
    },
    { re: new RegExp(`^\\s*(?:(?:public|private|internal)\\s+)?typealias\\s+(${ID})`), kind: "type" },
    { re: new RegExp(`^(?:(?:public|private|internal|const)\\s+)*(?:val|var)\\s+(${ID})`), kind: "variable" },
  ],
  cs: [
    {
      re: new RegExp(
        `^\\s*(?:\\[[^\\]]*\\]\\s*)*(?:(?:public|private|protected|internal|static|sealed|abstract|partial|readonly|file)\\s+)*(?:class|struct|record(?:\\s+(?:class|struct))?)\\s+(${ID})`,
      ),
      kind: "class",
    },
    { re: new RegExp(`^\\s*(?:(?:public|private|protected|internal|partial)\\s+)*interface\\s+(${ID})`), kind: "interface" },
    { re: new RegExp(`^\\s*(?:(?:public|private|protected|internal)\\s+)*enum\\s+(${ID})`), kind: "enum" },
    { re: /^\s*namespace\s+([\w.]+)/, kind: "module" },
    {
      re: new RegExp(
        `^\\s*(?:\\[[^\\]]*\\]\\s*)*(?:(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|extern|unsafe|new|partial)\\s+)+[\\w<>\\[\\],.?]+\\s+(${ID})\\s*(?:<[^>]*>)?\\s*\\((?:[^;]*$|[^)]*\\)\\s*\\{.*$)`,
      ),
      kind: "method",
    },
  ],
}

const isExported = (lang: Lang, line: string, name: string) => {
  switch (lang) {
    case "ts":
    case "js":
      return /^\s*(export\b|(module\.)?exports\.)/.test(line)
    case "py":
      return !/^\s/.test(line) && !name.startsWith("_")
    case "go":
      return /^[A-Z]/.test(name)
    case "rs":
      return /^\s*pub\b/.test(line)
    case "java":
    case "cs":
      return /\bpublic\b/.test(line)
    case "kt":
      return !/\b(private|internal)\b/.test(line)
  }
}

/** Blank out string and comment contents so braces inside them do not count. */
function codeOnly(line: string, state: { block: boolean }): string {
  let out = ""
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (state.block) {
      if (c === "*" && line[i + 1] === "/") {
        state.block = false
        i++
      }
      continue
    }
    if (c === "/" && line[i + 1] === "/") break
    if (c === "/" && line[i + 1] === "*") {
      state.block = true
      i++
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c
      i++
      while (i < line.length && line[i] !== q) i += line[i] === "\\" ? 2 : 1
      out += "_"
      continue
    }
    out += c
  }
  return out
}

/** The last line of the block starting at `start` (0-based index), by braces or indentation. */
export function blockEnd(lines: string[], start: number, lang: Lang): number {
  if (lang === "py" && !/^\s*(async\s+def|def|class)\b/.test(lines[start]!)) {
    // A statement: it ends where its brackets close.
    let open = 0
    for (let i = start; i < lines.length && i - start < 200; i++) {
      open += (lines[i]!.match(/[([{]/g)?.length ?? 0) - (lines[i]!.match(/[)\]}]/g)?.length ?? 0)
      if (open <= 0) return i
    }
    return start
  }
  if (lang === "py") {
    const indent = /^\s*/.exec(lines[start]!)![0].length
    let end = start
    // The signature may span lines until the one ending with ':'.
    let i = start
    while (i < lines.length && !/:\s*(#.*)?$/.test(lines[i]!) && i - start < 10) i++
    end = i
    for (i = i + 1; i < lines.length; i++) {
      const l = lines[i]!
      if (!l.trim()) continue
      if (/^\s*/.exec(l)![0].length <= indent) break
      end = i
    }
    return end
  }
  const state = { block: false }
  let depth = 0
  let opened = false
  for (let i = start; i < lines.length && i - start < 5000; i++) {
    const code = codeOnly(lines[i]!, state)
    for (const c of code) {
      if (c === "{") {
        depth++
        opened = true
      } else if (c === "}") depth--
    }
    if (opened && depth <= 0) return i
    // No block: a declaration ending in `;` (`type X = …;`), or one line (`const a = 1`).
    if (!opened && /;\s*$/.test(code)) return i
    // TS/JS without semicolons: a complete first line is the whole declaration. (Not for
    // C#/Java, where the brace often opens on the next line.)
    if (!opened && i === start && (lang === "ts" || lang === "js") && code.trim() && !/(=>|[=(,[{+\-*/?:&|<.])\s*$/.test(code)) return i
    if (!opened && i - start >= 2) return start
  }
  return start
}

export function docAbove(lines: string[], i: number, lang: Lang): string | undefined {
  const out: string[] = []
  let j = i - 1
  // Skip decorators and attributes (C#'s `[Attr]` lines too).
  const attr = lang === "cs" ? /^\s*(@\w|#\[|\[)/ : /^\s*(@\w|#\[)/
  while (j >= 0 && attr.test(lines[j]!)) j--
  if (lang === "py") return undefined
  if (j >= 0 && /\*\/\s*$/.test(lines[j]!)) {
    while (j >= 0) {
      const l = lines[j]!
      out.unshift(l)
      if (/\/\*/.test(l)) break
      j--
    }
    return clean(out.map((l) => l.replace(/^\s*(\/\*\*?|\*\/|\*)\s?/, "").replace(/\*\/\s*$/, "")))
  }
  while (j >= 0 && /^\s*(\/\/\/?|--)/.test(lines[j]!)) out.unshift(lines[j--]!.replace(/^\s*\/\/\/?\s?/, ""))
  return clean(out)
}

export function docstringBelow(lines: string[], i: number): string | undefined {
  let j = i + 1
  while (j < lines.length && j - i < 10 && !/:\s*(#.*)?$/.test(lines[j - 1]!)) j++
  const first = lines[j]?.trim()
  if (!first || !/^[rRuU]?("""|''')/.test(first)) return undefined
  const q = first.includes('"""') ? '"""' : "'''"
  const body = first.replace(/^[rRuU]?("""|''')/, "")
  if (body.includes(q)) return clean([body.slice(0, body.indexOf(q))])
  const out = [body]
  for (let k = j + 1; k < lines.length && k - j < 40; k++) {
    const l = lines[k]!
    if (l.includes(q)) {
      out.push(l.slice(0, l.indexOf(q)))
      break
    }
    out.push(l)
  }
  return clean(out)
}

const clean = (ls: string[]) => {
  const text = ls
    .map((l) => l.trim())
    .join("\n")
    .trim()
  return text ? text.split("\n").slice(0, 8).join("\n") : undefined
}

/** How much of a line a signature looks at. */
const SIGNATURE_LINE = 1000

export function signatureOf(lines: string[], i: number): string {
  // Lines are cut first: a minified file's one line is hundreds of KB, and the signature, a
  // slice of what is built here, would keep a copy of it alive for every definition on it.
  const line = (j: number) => lines[j]!.slice(0, SIGNATURE_LINE).trim()
  const out = [line(i)]
  // Parameters spanning lines: continue until the parentheses balance (at most 6 lines).
  let open = (out[0]!.match(/\(/g)?.length ?? 0) - (out[0]!.match(/\)/g)?.length ?? 0)
  for (let j = i + 1; open > 0 && j < lines.length && j - i < 6; j++) {
    const l = line(j)
    out.push(l)
    open += (l.match(/\(/g)?.length ?? 0) - (l.match(/\)/g)?.length ?? 0)
  }
  let sig = out.join(" ").replace(/\s+/g, " ")
  sig = sig.replace(/\s*\{\s*$/, "").replace(/\s*=>\s*\{?\s*$/, " =>")
  return sig.length > 240 ? `${sig.slice(0, 239)}…` : sig
}

/** Definitions in a file, in order, from line patterns (the fallback when no grammar is loaded; see syntax.ts). */
export function patternDefinitions(text: string, lang: Lang): Definition[] {
  const lines = text.split(/\r?\n/)
  const rules = RULES[lang]
  const out: Definition[] = []
  const state = { block: false }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    // Skip lines inside block comments.
    const inComment = state.block
    codeOnly(line, state)
    if (inComment || /^\s*(\/\/|#|\*)/.test(line)) continue
    for (const r of rules) {
      const m = r.re.exec(line)
      if (!m) continue
      const name = m[1]!
      if (KEYWORDS.has(name)) break
      // A method rule only fires inside a class-ish block for JS (indented) and needs a body.
      if (r.kind === "method" && (lang === "ts" || lang === "js") && !/\)\s*(?::[^={]+)?\{\s*$/.test(line) && !/\(\s*$/.test(line)) break
      if (r.kind === "method" && /^\s*(return|new|throw|else|case|yield|await)\b|[=]\s*new\s/.test(line)) break
      const end = blockEnd(lines, i, lang)
      out.push({
        name,
        kind: r.kind,
        line: i + 1,
        end: end + 1,
        signature: signatureOf(lines, i),
        doc: lang === "py" ? docstringBelow(lines, i) : docAbove(lines, i, lang),
        exported: isExported(lang, line, name),
      })
      break
    }
  }
  return out
}

/**
 * Import specifiers as written in the file (resolution is in graph.ts). With `submodules`,
 * Python's `from pkg import a` also yields `pkg.a`, in case `a` is a module of package `pkg`
 * (the resolver keeps it only when such a file exists).
 */
export function importSpecs(text: string, lang: Lang, opts: { submodules?: boolean } = {}): string[] {
  const out: string[] = []
  const add = (s: string | undefined) => {
    if (s) out.push(s)
  }
  switch (lang) {
    case "ts":
    case "js": {
      for (const m of text.matchAll(/(?:^|[;\n}])\s*(?:import|export)\s+(?:type\s+)?(?:[\w$*{}\s,]+?\s+from\s+)?["']([^"'\n]+)["']/g)) add(m[1])
      for (const m of text.matchAll(/\b(?:require|import)\s*\(\s*["']([^"'\n]+)["']\s*\)/g)) add(m[1])
      break
    }
    case "py": {
      // `from x import a, b`, `from x import (\n a,\n b,\n)` and backslash continuations.
      for (const m of text.matchAll(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]*(?:\(([^)]*)\)|((?:[^\n#\\]|\\\r?\n)+))/gm)) {
        const mod = m[1]!
        const names = (m[2] ?? m[3] ?? "")
          .replace(/#[^\n]*/g, "")
          .split(/[,\\\n]/)
          .map((n) => n.trim().split(/\s+/)[0]!)
          .filter((n) => /^\w+$/.test(n))
        // `from . import a, b` names modules; `from .x import a` names x (and a, when x.a is a submodule).
        if (/^\.+$/.test(mod)) {
          add(mod) // the package itself: its __init__.py runs before any module it defines
          for (const n of names) add(`${mod}${n}`)
        } else {
          add(mod)
          if (opts.submodules) for (const n of names) add(`${mod}.${n}`)
        }
      }
      for (const m of text.matchAll(/^\s*import\s+([\w., ]+)/gm)) for (const n of m[1]!.split(",")) add(n.trim().split(/\s+/)[0])
      break
    }
    case "go": {
      for (const m of text.matchAll(/^import\s+(?:\w+\s+)?"([^"]+)"/gm)) add(m[1])
      for (const block of text.matchAll(/^import\s*\(([\s\S]*?)\)/gm)) for (const m of block[1]!.matchAll(/"([^"]+)"/g)) add(m[1])
      break
    }
    case "rs": {
      for (const m of text.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm)) add(`mod:${m[1]}`)
      for (const m of text.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+((?:crate|super|self)(?:::\w+)+)/gm)) add(m[1])
      break
    }
    case "java":
    case "kt": {
      // `import a.b.C`, `import a.b.*` (a package), `import static a.b.C.m` (a member of C).
      for (const m of text.matchAll(/^\s*import\s+(?:static\s+)?([\w.]*\w(?:\.\*)?)/gm)) add(m[1])
      break
    }
    case "cs": {
      for (const m of text.matchAll(/^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm)) add(m[1])
      break
    }
  }
  return [...new Set(out)]
}
