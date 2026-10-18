import fs from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import zlib from "node:zlib"
import { Language, type Node, Parser } from "web-tree-sitter"
import { type Definition, type DefKind, docAbove, docstringBelow, type Lang, patternDefinitions, signatureOf } from "./lang.js"

/**
 * Definitions from tree-sitter syntax trees (WebAssembly grammars, loaded once per process
 * by loadSyntax), and where a file's comments and strings are, so references inside them
 * are not counted. Until the grammars are loaded, or for a language whose grammar failed to
 * load, the line patterns in lang.ts answer instead.
 */

type Grammar = "typescript" | "tsx" | "javascript" | "python" | "go" | "rust" | "java" | "kotlin" | "c_sharp"

const GRAMMAR: Record<Lang, Grammar> = { ts: "typescript", js: "javascript", py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", cs: "c_sharp" }

const languages = new Map<Grammar, Language>()
let parser: Parser | undefined
let loading: Promise<void> | undefined
let status = "line patterns (tree-sitter not loaded)"

/**
 * Where the grammars are: next to a bundled server (the plugin's servers/grammars), or the
 * package's own grammars/ directory when running from source or dist.
 */
function grammarDirs(): string[] {
  return [new URL("./grammars/", import.meta.url), new URL("../grammars/", import.meta.url)].map((u) => fileURLToPath(u))
}

function readGz(name: string): Uint8Array | undefined {
  for (const dir of grammarDirs()) {
    const file = `${dir}${name}.gz`
    if (fs.existsSync(file)) return zlib.gunzipSync(fs.readFileSync(file))
  }
  return undefined
}

function runtimeWasm(): Uint8Array {
  const bundled = readGz("web-tree-sitter.wasm")
  if (bundled) return bundled
  return fs.readFileSync(createRequire(import.meta.url).resolve("web-tree-sitter/web-tree-sitter.wasm"))
}

/** Load the tree-sitter runtime and every grammar. Idempotent; never throws (falls back to patterns). */
export function loadSyntax(): Promise<void> {
  loading ??= (async () => {
    try {
      await Parser.init({ wasmBinary: runtimeWasm() } as never)
      parser = new Parser()
    } catch (err) {
      status = `line patterns (tree-sitter failed to start: ${(err as Error).message})`
      return
    }
    const failed: string[] = []
    for (const g of [...new Set<Grammar>([...Object.values(GRAMMAR), "tsx"])]) {
      try {
        const wasm = readGz(`tree-sitter-${g}.wasm`)
        if (!wasm) throw new Error("not found")
        languages.set(g, await Language.load(wasm))
      } catch {
        failed.push(g)
      }
    }
    status = failed.length ? `tree-sitter, except ${failed.join(", ")} (line patterns)` : "tree-sitter"
  })()
  return loading
}

/** How definitions are found right now, for the project map. */
export function syntaxStatus(): string {
  return status
}

/** A file's definitions and the spans (UTF-16 offsets) that are not code. */
export interface Parsed {
  defs: Definition[]
  /** Comment and string spans, innermost last, with code holes inside strings (interpolations). */
  spans: Span[]
}

interface Span {
  start: number
  end: number
  code: boolean
}

/** Parse a file with its grammar, or undefined when none is loaded for it. */
export function parse(text: string, lang: Lang, file?: string): Parsed | undefined {
  const grammar = lang === "ts" && file && /\.tsx$/i.test(file) ? "tsx" : GRAMMAR[lang]
  const language = languages.get(grammar)
  if (!parser || !language) return undefined
  parser.setLanguage(language)
  const tree = parser.parse(text)
  if (!tree) return undefined
  try {
    const lines = text.split(/\r?\n/)
    const root = tree.rootNode
    const defs = collect(root, lang, lines)
    // Error recovery can swallow definitions: the patterns cover the broken regions.
    if (root.hasError) {
      const broken = errorRows(root)
      const have = new Set(defs.map((d) => d.line))
      for (const d of patternDefinitions(text, lang)) if (!have.has(d.line) && broken.some(([a, b]) => d.line >= a && d.line <= b)) defs.push(d)
      defs.sort((a, b) => a.line - b.line)
    }
    return { defs, spans: noncode(root) }
  } finally {
    tree.delete()
  }
}

/** Definitions in a file: from its syntax tree when its grammar is loaded, else from line patterns. */
export function definitions(text: string, lang: Lang, file?: string): Definition[] {
  return parse(text, lang, file)?.defs ?? patternDefinitions(text, lang)
}

/** Whether `offset` is in code: not inside a comment or string (string interpolations are code). */
export function isCode(spans: Span[], offset: number): boolean {
  let code = true
  for (const s of spans) {
    if (s.start > offset) break
    if (offset < s.end) code = s.code
  }
  return code
}

function errorRows(root: Node): [number, number][] {
  const out: [number, number][] = []
  const walk = (n: Node) => {
    if (n.type === "ERROR" || n.isMissing) {
      out.push([n.startPosition.row + 1, n.endPosition.row + 1])
      return
    }
    if (n.hasError) for (const c of n.namedChildren) if (c) walk(c)
  }
  walk(root)
  return out
}

const COMMENT = /comment/
const STRING = /string|char_literal|character_literal|rune_literal/
const HOLE = /substitution|interpolation/

/** Comment and string spans in preorder (outer before inner), so the last one containing an offset is innermost. */
function noncode(root: Node): Span[] {
  const out: Span[] = []
  const walk = (n: Node, inString: boolean) => {
    for (const c of n.namedChildren) {
      if (!c) continue
      if (COMMENT.test(c.type)) out.push({ start: c.startIndex, end: c.endIndex, code: false })
      else if (STRING.test(c.type) && !inString) {
        out.push({ start: c.startIndex, end: c.endIndex, code: false })
        walk(c, true)
      } else if (inString && HOLE.test(c.type)) {
        out.push({ start: c.startIndex, end: c.endIndex, code: true })
        walk(c, false)
      } else walk(c, inString)
    }
  }
  walk(root, false)
  return out
}

// ------------------------------------------------------------------------- definitions

/** Bodies the walk does not enter: what is defined inside a function is local to it. */
const FUNCTION_LIKE = /function|method|lambda|closure|constructor|arrow|func_literal|accessor/

interface Ctx {
  lang: Lang
  lines: string[]
  out: Definition[]
  /** Names listed in `export { … }` clauses (TS/JS). */
  exportList: Set<string>
}

interface Found {
  kind: DefKind
  name: string
  nameNode?: Node
  /** The node whose rows the definition spans. */
  span: Node
  exported: boolean
  /** Walk into it for members (classes, modules, impls…). */
  container?: boolean
}

function collect(root: Node, lang: Lang, lines: string[]): Definition[] {
  const ctx: Ctx = { lang, lines, out: [], exportList: new Set() }
  if (lang === "ts" || lang === "js") {
    for (const c of root.namedChildren)
      if (c?.type === "export_statement" && !c.childForFieldName("declaration"))
        for (const s of c.descendantsOfType("export_specifier")) {
          const local = s?.childForFieldName("name") ?? s?.namedChildren[0]
          if (local) ctx.exportList.add(local.text)
        }
  }
  walk(root, ctx, { inClass: false, exported: true, topLevel: true })
  return ctx.out
}

interface Scope {
  inClass: boolean
  /** Whether the enclosing container is visible outside its file. */
  exported: boolean
  topLevel: boolean
}

function walk(node: Node, ctx: Ctx, scope: Scope) {
  for (const c of node.namedChildren) {
    if (!c || COMMENT.test(c.type) || STRING.test(c.type)) continue
    const found = classify(c, ctx, scope)
    for (const f of found) emit(f, ctx)
    const container = found.find((f) => f.container)
    // A Rust impl block is no definition, but its functions are methods.
    if (container || c.type === "impl_item") {
      walk(c, ctx, { inClass: true, exported: container?.exported ?? true, topLevel: false })
      continue
    }
    if (FUNCTION_LIKE.test(c.type)) continue
    // Declarations wrapped in export statements, decorators, blocks… stay at the same level.
    walk(c, ctx, { ...scope, topLevel: scope.topLevel && TRANSPARENT.test(c.type) })
  }
}

/** Wrappers that keep their contents at the top level of the file. */
const TRANSPARENT =
  /^(export_statement|ambient_declaration|decorated_definition|expression_statement|lexical_declaration|variable_declaration|var_declaration|const_declaration|var_spec_list|attribute_item)$/

function emit(f: Found, ctx: Ctx) {
  const { lines, lang } = ctx
  const start = f.span.startPosition.row
  // The definition's line is the one naming it, unless the node starts on a plain line above
  // (annotations and decorators above it are not the signature).
  let row = f.nameNode?.startPosition.row ?? start
  if (row > start && !/^\s*(@|\[|#\[)/.test(lines[start] ?? "")) row = start
  ctx.out.push({
    name: f.name,
    kind: f.kind,
    line: row + 1,
    end: Math.max(row, f.span.endPosition.row) + 1,
    signature: signatureOf(lines, row),
    doc: lang === "py" ? docstringBelow(lines, row) : docAbove(lines, row, lang),
    exported: f.exported,
  })
}

const nameOf = (n: Node): Node | undefined =>
  n.childForFieldName("name") ??
  n.namedChildren.find((c) => !!c && /^(identifier|type_identifier|field_identifier|property_identifier|simple_identifier)$/.test(c.type)) ??
  undefined

function def(n: Node, kind: DefKind, exported: boolean, container = false, nameNode = nameOf(n)): Found[] {
  if (!nameNode) return []
  return [{ kind, name: nameNode.text.replace(/^["']|["']$/g, ""), nameNode, span: n, exported, container }]
}

function classify(n: Node, ctx: Ctx, scope: Scope): Found[] {
  switch (ctx.lang) {
    case "ts":
    case "js":
      return classifyJs(n, ctx, scope)
    case "py":
      return classifyPy(n, scope)
    case "go":
      return classifyGo(n, scope)
    case "rs":
      return classifyRs(n, scope)
    case "java":
      return classifyJava(n)
    case "kt":
      return classifyKt(n, scope)
    case "cs":
      return classifyCs(n)
  }
}

function classifyJs(n: Node, ctx: Ctx, scope: Scope): Found[] {
  const exported = (name?: string) => n.parent?.type === "export_statement" || (scope.topLevel && !!name && ctx.exportList.has(name))
  const named = (kind: DefKind, container = false) => {
    const name = nameOf(n)
    // Exported means exported from the module: a class's methods are not, themselves.
    return def(n, kind, exported(name?.text), container, name)
  }
  switch (n.type) {
    case "function_declaration":
    case "generator_function_declaration":
      return named("function")
    case "class_declaration":
    case "abstract_class_declaration":
      return named("class", true)
    case "interface_declaration":
      return named("interface")
    case "type_alias_declaration":
      return named("type")
    case "enum_declaration":
      return named("enum")
    case "internal_module":
    case "module":
      return named("module", true)
    case "method_definition":
    case "abstract_method_signature":
      return named("method")
    case "variable_declarator": {
      const name = n.childForFieldName("name")
      if (!scope.topLevel || name?.type !== "identifier") return []
      const decl = n.parent
      return def(n, "variable", decl?.parent?.type === "export_statement" || ctx.exportList.has(name.text), false, name)
    }
    case "assignment_expression": {
      // CommonJS: exports.name = …, module.exports.name = …
      const left = n.childForFieldName("left")
      if (!scope.topLevel || left?.type !== "member_expression") return []
      const object = left.childForFieldName("object")?.text
      const prop = left.childForFieldName("property")
      if ((object !== "exports" && object !== "module.exports") || !prop) return []
      return def(n, "variable", true, false, prop)
    }
  }
  return []
}

function classifyPy(n: Node, scope: Scope): Found[] {
  const visible = (name?: string) => !!name && !name.startsWith("_") && (scope.topLevel || scope.exported)
  switch (n.type) {
    case "function_definition": {
      const name = nameOf(n)
      return def(n, scope.inClass ? "method" : "function", scope.topLevel && visible(name?.text), false, name)
    }
    case "class_definition": {
      const name = nameOf(n)
      return def(n, "class", visible(name?.text), true, name)
    }
    case "assignment": {
      const left = n.childForFieldName("left")
      if (!scope.topLevel || left?.type !== "identifier") return []
      return def(n, "variable", !left.text.startsWith("_"), false, left)
    }
  }
  return []
}

const capital = (s: string) => /^[A-Z]/.test(s)

function classifyGo(n: Node, scope: Scope): Found[] {
  switch (n.type) {
    case "function_declaration":
    case "method_declaration": {
      const name = nameOf(n)
      return def(n, n.type === "method_declaration" ? "method" : "function", !!name && capital(name.text), false, name)
    }
    case "type_spec":
    case "type_alias": {
      const name = nameOf(n)
      const t = n.childForFieldName("type")?.type
      const kind: DefKind = t === "struct_type" ? "class" : t === "interface_type" ? "interface" : "type"
      return def(n, kind, !!name && capital(name.text), false, name)
    }
    case "var_spec":
    case "const_spec":
      if (!scope.topLevel) return []
      return n.namedChildren.filter((c): c is Node => c?.type === "identifier").flatMap((id) => def(n, "variable", capital(id.text), false, id))
  }
  return []
}

function classifyRs(n: Node, scope: Scope): Found[] {
  const pub = n.namedChildren.some((c) => c?.type === "visibility_modifier" && c.text.startsWith("pub"))
  switch (n.type) {
    case "function_item":
    case "function_signature_item":
      return def(n, scope.inClass ? "method" : "function", pub || (scope.inClass && scope.exported && n.type === "function_signature_item"))
    case "struct_item":
    case "union_item":
      return def(n, "class", pub)
    case "enum_item":
      return def(n, "enum", pub)
    case "trait_item":
      return def(n, "interface", pub, true)
    case "type_item":
      return def(n, "type", pub)
    case "mod_item":
      // `mod name;` declares a file module: an import, not a definition here.
      return n.childForFieldName("body") ? def(n, "module", pub, true) : []
    case "const_item":
    case "static_item":
      return def(n, "variable", pub)
    case "macro_definition":
      return def(n, "function", n.previousNamedSibling?.text.includes("macro_export") ?? false)
  }
  return []
}

function classifyJava(n: Node): Found[] {
  const pub = /\bpublic\b/.test(n.namedChildren.find((c) => c?.type === "modifiers")?.text ?? "")
  switch (n.type) {
    case "class_declaration":
    case "record_declaration":
      return def(n, "class", pub, true)
    case "interface_declaration":
    case "annotation_type_declaration":
      return def(n, "interface", pub, true)
    case "enum_declaration":
      return def(n, "enum", pub, true)
    case "method_declaration":
    case "constructor_declaration":
      return def(n, "method", pub)
  }
  return []
}

function classifyKt(n: Node, scope: Scope): Found[] {
  const mods = n.namedChildren.find((c) => c?.type === "modifiers")?.text ?? ""
  const visible = !/\b(private|internal)\b/.test(mods)
  switch (n.type) {
    case "class_declaration": {
      const kind: DefKind = n.children.some((c) => c?.type === "interface") ? "interface" : /\benum\b/.test(mods) ? "enum" : "class"
      return def(n, kind, visible, true)
    }
    case "object_declaration":
      return def(n, "class", visible, true)
    case "function_declaration":
      return def(n, scope.inClass ? "method" : "function", visible)
    case "type_alias":
      return def(n, "type", visible)
    case "property_declaration": {
      if (!scope.topLevel) return []
      const id = n.descendantsOfType("variable_declaration")[0]?.namedChildren.find((c) => c?.type === "identifier")
      return id ? def(n, "variable", visible, false, id) : []
    }
  }
  return []
}

function classifyCs(n: Node): Found[] {
  const pub = n.namedChildren.some((c) => c?.type === "modifier" && c.text === "public")
  switch (n.type) {
    case "class_declaration":
    case "struct_declaration":
    case "record_declaration":
    case "record_struct_declaration":
      return def(n, "class", pub, true)
    case "interface_declaration":
      return def(n, "interface", pub, true)
    case "enum_declaration":
      return def(n, "enum", pub)
    case "namespace_declaration":
    case "file_scoped_namespace_declaration":
      return def(n, "module", true, true)
    case "method_declaration":
    case "constructor_declaration":
      return def(n, "method", pub)
    case "delegate_declaration":
      return def(n, "type", pub)
  }
  return []
}
