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
let generation = 0

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
      generation++
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
    generation++
  })()
  return loading
}

/** Bumped whenever loadSyntax finishes: results computed before then may come from line patterns. */
export function syntaxGeneration(): number {
  return generation
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
      // Not inside a definition the tree did find: a function's body holds local helpers (left
      // out on purpose), and Kotlin's recovery wraps whole members whose patterns would repeat.
      const within = defs.filter((d) => d.end > d.line && (lang === "kt" || d.kind === "function" || d.kind === "method" || d.kind === "variable"))
      for (const d of patternDefinitions(text, lang)) {
        if (have.has(d.line) || !broken.some(([a, b]) => d.line >= a && d.line <= b) || within.some((w) => d.line > w.line && d.line <= w.end)) continue
        defs.push(d)
        if (d.end > d.line && (d.kind === "function" || d.kind === "method")) within.push(d)
      }
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
/** Other text that is not code: regular expression literals and JSX text. */
const LITERAL = /^(regex|jsx_text)$/
const HOLE = /substitution|interpolation/

/** Comment and string spans in preorder (outer before inner), so the last one containing an offset is innermost. */
function noncode(root: Node): Span[] {
  const out: Span[] = []
  const walk = (n: Node, inString: boolean) => {
    for (const c of n.namedChildren) {
      if (!c) continue
      if (COMMENT.test(c.type) || LITERAL.test(c.type)) out.push({ start: c.startIndex, end: c.endIndex, code: false })
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
    // `export { a }` names local a; `export { a } from "./x"` re-exports another module's.
    for (const c of root.namedChildren)
      if (c?.type === "export_statement" && !c.childForFieldName("declaration") && !c.childForFieldName("source"))
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
  /** The enclosing container's node type (class_declaration, trait_item, interface_declaration…). */
  parent?: string
}

function walk(node: Node, ctx: Ctx, scope: Scope) {
  for (const c of node.namedChildren) {
    if (!c || COMMENT.test(c.type) || STRING.test(c.type)) continue
    const found = classify(c, ctx, scope)
    for (const f of found) emit(f, ctx)
    const container = found.find((f) => f.container)
    // A Rust impl block is no definition, but its functions are methods.
    if (container || c.type === "impl_item") {
      walk(c, ctx, { inClass: true, exported: container?.exported ?? scope.exported, topLevel: false, parent: c.type })
      continue
    }
    if (FUNCTION_LIKE.test(c.type)) continue
    // Anonymous classes (Java `new I() { … }`, Kotlin `object : I { … }`) are values, not members.
    if ((ctx.lang === "java" || ctx.lang === "kt") && /^(object_creation_expression|object_literal)$/.test(c.type)) continue
    // Declarations wrapped in export statements, decorators, blocks… stay at the same level;
    // so do Python's module-level definitions under `if` and `try`.
    const transparent = TRANSPARENT.test(c.type) || (ctx.lang === "py" && PY_TRANSPARENT.test(c.type))
    walk(c, ctx, { ...scope, topLevel: scope.topLevel && transparent })
  }
}

const PY_TRANSPARENT = /^(if_statement|elif_clause|else_clause|try_statement|except_clause|except_group_clause|finally_clause|block)$/

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
  // The doc comment is above everything that belongs to the definition: its decorators and
  // attributes (inside the node, or siblings before it) and an export wrapper.
  let top = f.span
  while (top.parent && /^(export_statement|ambient_declaration)$/.test(top.parent.type)) top = top.parent
  let docRow = Math.min(row, top.startPosition.row)
  for (let prev = top.previousNamedSibling; prev && /^(decorator|attribute_item|attribute_list)$/.test(prev.type); prev = prev.previousNamedSibling)
    docRow = Math.min(docRow, prev.startPosition.row)
  ctx.out.push({
    name: f.name,
    kind: f.kind,
    line: row + 1,
    end: Math.max(row, f.span.endPosition.row) + 1,
    signature: signatureOf(lines, row),
    doc: lang === "py" ? docstringBelow(lines, row) : docAbove(lines, docRow, lang),
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
      return classifyJava(n, scope)
    case "kt":
      return classifyKt(n, scope)
    case "cs":
      return classifyCs(n, scope)
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
    case "function_signature": {
      // `declare function`, .d.ts files, overloads. Overloads followed by their implementation
      // are that one function, defined there.
      const name = nameOf(n)?.text
      for (let sib = (n.parent?.type === "export_statement" ? n.parent : n).nextNamedSibling; sib; sib = sib.nextNamedSibling) {
        if (COMMENT.test(sib.type)) continue
        const d = sib.type === "export_statement" ? sib.childForFieldName("declaration") : sib
        if (d?.type === "function_signature" && nameOf(d)?.text === name) continue
        if (d?.type === "function_declaration" && nameOf(d)?.text === name) return []
        break
      }
      return named("function")
    }
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
      // Methods of classes; an object literal's methods are values, not definitions.
      return scope.inClass && n.parent?.type === "class_body" ? named("method") : []
    case "public_field_definition":
    case "field_definition": {
      // Class fields holding functions (`onClick = () => …`) are methods.
      const value = n.childForFieldName("value")?.type
      if (!scope.inClass || !value || !/^(arrow_function|function_expression|function|generator_function)$/.test(value)) return []
      return def(n, "method", false, false, n.childForFieldName("name") ?? n.childForFieldName("property") ?? undefined)
    }
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
      if (!scope.topLevel || !left) return []
      // `a = …`, and each name of `a, b = …` / `(a, b) = …`.
      const ids =
        left.type === "identifier" ? [left] : /^(pattern_list|tuple_pattern)$/.test(left.type) ? left.namedChildren.filter((c) => c?.type === "identifier") : []
      return ids.flatMap((id) => (id ? def(n, "variable", !id.text.startsWith("_"), false, id) : []))
    }
    case "type_alias_statement": {
      // PEP 695: `type X = …`
      const left = n.childForFieldName("left")
      const id = left?.type === "identifier" ? left : left?.namedChildren.find((c) => c?.type === "identifier")
      return id ? def(n, "type", visible(id.text), false, id) : []
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
  // Exported: plain `pub` (not pub(crate), pub(super), pub(in …)), in a module that is itself exported.
  const pub = scope.exported && n.namedChildren.some((c) => c?.type === "visibility_modifier" && c.text === "pub")
  switch (n.type) {
    case "function_item":
    case "function_signature_item":
      // A trait's functions are as visible as the trait.
      // Functions of impls and traits are methods; a `mod { … }`'s are functions.
      return def(n, scope.parent === "impl_item" || scope.parent === "trait_item" ? "method" : "function", scope.parent === "trait_item" ? scope.exported : pub)
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

function classifyJava(n: Node, scope: Scope): Found[] {
  const mods = n.namedChildren.find((c) => c?.type === "modifiers")?.text ?? ""
  // Interface members are public unless they say otherwise; anything is only as visible as its container.
  const inInterface = scope.parent === "interface_declaration" || scope.parent === "annotation_type_declaration"
  const pub = scope.exported && (/\bpublic\b/.test(mods) || (inInterface && !/\bprivate\b/.test(mods)))
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
  const visible = scope.exported && !/\b(private|internal)\b/.test(mods)
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
      // `val a = …`, or each name of `val (a, b) = …`.
      const multi = n.namedChildren.find((c) => c?.type === "multi_variable_declaration")
      const decls = multi ? multi.namedChildren.filter((c) => c?.type === "variable_declaration") : [n.descendantsOfType("variable_declaration")[0]]
      return decls.flatMap((d) => {
        const id = d?.namedChildren.find((c) => c?.type === "identifier")
        return id ? def(n, "variable", visible, false, id) : []
      })
    }
  }
  return []
}

function classifyCs(n: Node, scope: Scope): Found[] {
  const mods = n.namedChildren.filter((c) => c?.type === "modifier").map((c) => c!.text)
  // Interface members are public unless they say otherwise; anything is only as visible as its container.
  const pub = scope.exported && (mods.includes("public") || (scope.parent === "interface_declaration" && !mods.includes("private")))
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
