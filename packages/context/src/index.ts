#!/usr/bin/env node
import path from "node:path"
import { packageVersion, truncate } from "@mcp-horde/core"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { openProject, relPath } from "./files.js"
import { importGraph, testsFor } from "./graph.js"
import { projectMap } from "./map.js"
import { pack } from "./pack.js"
import { excerpt, find, symbol } from "./search.js"
import { loadSyntax } from "./syntax.js"

const VERSION = packageVersion(import.meta.url)

process.on("unhandledRejection", (err) => {
  process.stderr.write(`[mcp-horde/context] unhandled rejection: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
})

const DEFAULT_DIR = path.resolve(process.env.HORDE_CONTEXT_DIRECTORY || process.cwd())

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] })
const fail = (err: unknown): CallToolResult => ({
  content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
})

export const INSTRUCTIONS = `context: precise code context instead of exploration (no index to build; answers come from the current files).
- context_map first in an unfamiliar project: layout, languages, manifests, entry points, test directories, instruction files.
- context_find (text, definition or reference) and context_symbol (definition, doc, call sites) instead of reading files to look for something.
- context_file shows exact lines, or just the named symbols' definitions.
- context_tests_for: which tests cover given files (run those first).
- context_pack: a budgeted context section for a worker's brief (scoped files, named symbols, covering tests, conventions).
Definitions come from tree-sitter syntax trees (TS/JS, Python, Go, Rust, Java, Kotlin, C#), and references skip comments and strings; imports come from language-aware patterns.`

const server = new McpServer({ name: "context", version: VERSION }, { instructions: INSTRUCTIONS })

const directory = z.string().optional().describe("Project directory (default: the server's). Paths in answers are relative to it.")
const strings = z.array(z.string())

const tool = <S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  run: (args: z.infer<z.ZodObject<S>> & { directory?: string }) => string,
) => {
  server.registerTool(name, { description, inputSchema: { directory, ...shape }, annotations: { readOnlyHint: true, openWorldHint: false } }, (async (
    args: z.infer<z.ZodObject<S>> & { directory?: string },
  ) => {
    try {
      return ok(run(args))
    } catch (err) {
      return fail(err)
    }
  }) as never)
}

const project = (d?: string) => openProject(d ? path.resolve(DEFAULT_DIR, d) : DEFAULT_DIR)

tool(
  "context_map",
  "The project at a glance: directories with file counts, languages and tests; manifests, entry points, test directories, and the project's instruction files (CLAUDE.md, AGENTS.md, CONTRIBUTING.md; listed, not inlined).",
  {
    depth: z.number().int().min(1).max(6).optional().describe("Directory levels to show (default 2)."),
    budget_chars: z.number().int().min(500).max(50_000).optional(),
  },
  (a) => projectMap(project(a.directory), { depth: a.depth, budgetChars: a.budget_chars }),
)

tool(
  "context_find",
  'Search the project. kind "text" (default): lines containing the query; "definition": functions, classes, types… whose name matches; "reference": whole-word uses outside definitions. Literal and smart-case unless written as /regex/. Answers `path:line  text`.',
  {
    query: z.string().min(1),
    kind: z.enum(["text", "definition", "reference"]).optional(),
    paths: strings.optional().describe("Only these files, directories or globs."),
    limit: z.number().int().min(1).max(500).optional().describe("Max hits (default 50)."),
  },
  (a) => {
    const p = project(a.directory)
    const { hits, total } = find(p, a.query, { kind: a.kind, paths: a.paths, limit: a.limit })
    if (!hits.length) return `No ${a.kind ?? "text"} matches for ${JSON.stringify(a.query)} in ${p.files.length} files.`
    const lines = hits.map((h) => `${h.file}:${h.line}  ${h.text}`)
    return `${lines.join("\n")}${total > hits.length ? `\n… ${total - hits.length} more (narrow with paths, or raise limit)` : ""}`
  },
)

tool(
  "context_symbol",
  "A symbol's definition (signature, doc comment, where its block starts and ends) and its call sites: a count plus the first ones with one line each.",
  {
    name: z.string().min(1),
    path: z.string().optional().describe("Only definitions in this file or directory."),
    calls: z.number().int().min(0).max(100).optional().describe("Call sites to list (default 10)."),
  },
  (a) => {
    const p = project(a.directory)
    const found = symbol(p, a.name, { path: a.path, calls: a.calls })
    if (!found.length) {
      const near = find(p, a.name, { kind: "definition", limit: 8 }).hits
      return `No definition of ${a.name}.${near.length ? ` Similar: ${near.map((h) => `${h.file}:${h.line}`).join(", ")}` : ""}`
    }
    return found
      .map((s) =>
        [
          `${s.def.kind} ${s.def.name}${s.def.exported ? " (exported)" : ""} — ${s.file}:${s.def.line}-${s.def.end}`,
          `  ${s.def.signature}`,
          s.def.doc
            ?.split("\n")
            .map((l) => `  │ ${l}`)
            .join("\n"),
          `  ${s.callCount} use${s.callCount === 1 ? "" : "s"} elsewhere${s.calls.length ? ":" : ""}`,
          ...s.calls.map((c) => `    ${c.file}:${c.line}  ${truncate(c.text, 120)}`),
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n\n")
  },
)

tool(
  "context_file",
  'An excerpt with line numbers: lines ("10-40"), only the named symbols\' definitions, or the whole file when it fits (otherwise its outline and its first lines).',
  {
    path: z.string().min(1),
    lines: z.string().optional().describe('"a-b", 1-based inclusive.'),
    symbols: strings.optional(),
    budget_chars: z.number().int().min(500).max(100_000).optional().describe("Default 12000."),
  },
  (a) => excerpt(project(a.directory), a.path, { lines: a.lines, symbols: a.symbols, budgetChars: a.budget_chars }),
)

tool(
  "context_imports",
  'Project files this file imports (direction "out", default) or the files importing it ("in"). Packages outside the project are not listed.',
  { path: z.string().min(1), direction: z.enum(["in", "out"]).optional() },
  (a) => {
    const p = project(a.directory)
    const rel = relPath(p, a.path)
    if (!p.files.includes(rel)) throw new Error(`no file ${rel} in ${p.root}`)
    const g = importGraph(p)
    const list = (a.direction === "in" ? g.in : g.out).get(rel) ?? []
    return list.length ? list.join("\n") : `${rel} ${a.direction === "in" ? "is imported by no project file" : "imports no project files"}.`
  },
)

tool(
  "context_tests_for",
  "The test files that cover the given files: tests named after them (next to them or in a mirrored test directory), tests that import them, Go package tests and Rust inline tests.",
  { files: strings.min(1) },
  (a) => {
    const p = project(a.directory)
    const res = testsFor(
      p,
      a.files.map((f) => relPath(p, f)),
    )
    return [...res].map(([f, ts]) => `${f}: ${ts.length ? ts.map((t) => `${t.test} (${t.why})`).join(", ") : "no tests found"}`).join("\n")
  },
)

tool(
  "context_pack",
  "A context section for a worker's brief, within a token budget: the scoped files (whole when small, outline plus the lines that mention the task when large), definitions of symbols the goal names, the tests covering the scope, and the project's instruction files.",
  {
    goal: z.string().min(1).describe("The task; identifiers and paths in it select symbols and regions."),
    scope: strings.optional().describe("Paths or globs the work is confined to."),
    files: strings.optional(),
    symbols: strings.optional(),
    budget_tokens: z.number().int().min(200).max(50_000).optional().describe("Default 3000."),
  },
  (a) =>
    pack(project(a.directory), {
      goal: a.goal,
      scope: a.scope,
      files: a.files,
      symbols: a.symbols,
      budgetTokens: a.budget_tokens,
    }) || "Nothing relevant found: no scope, files or named symbols matched.",
)

// Grammars for code context (briefs, related tests); without them line patterns answer.
await loadSyntax()
await server.connect(new StdioServerTransport())
