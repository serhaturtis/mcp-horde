# @mcp-horde/context

An MCP server that gives agents precise code context instead of exploration. Fast, cheap models are weakest at finding their way around a large codebase and spend most of their tokens doing it; the orchestrator should not spend its own tokens doing it for them either.

There is no index to build and nothing to keep in sync: every answer comes from the current files (git's file list, so `.gitignore` applies), with small caches keyed by file content. No native dependencies.

## Tools

| Tool | What it answers |
| --- | --- |
| `context_map` | The project at a glance: directories with file counts, languages and tests; manifests, entry points (package.json `main`/`bin`/`exports` mapped back to sources, conventional names), test directories, and the project's instruction files (`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`; listed, not inlined). |
| `context_find` | `kind: "text"` lines containing the query, `"definition"` symbols whose name matches, `"reference"` whole-word uses outside definitions. Literal and smart-case, or `/regex/`. One `path:line  text` per hit. |
| `context_symbol` | A definition's signature, doc comment and extent, plus its call sites (a count and the first ones). |
| `context_file` | An excerpt with line numbers: a line range, only the named symbols' definitions, or the whole file when it fits (otherwise its outline and its head). |
| `context_imports` | Project files a file imports, or the files importing it. |
| `context_tests_for` | The tests that cover files: named after them (next to them, or in a mirrored `test/`, `tests/`, `__tests__/`, `src/test/java/…` tree, or a C# `X.Tests/…/FooTests.cs` project for `X/…/Foo.cs`), importing them (also through re-exporting `index`/`lib` files and workspace package names), Go package tests, Rust inline `#[cfg(test)]` modules. |
| `context_pack` | A budgeted context section for a worker's brief (below). |

```text
context_symbol name:"Add"
function Add (exported) — internal/calc/calc.go:4-6
  func Add(a, b int) int
  │ Add adds.
  1 use elsewhere:
    cmd/demo/main.go:8  func main() { fmt.Println(calc.Add(1, 2)) }
```

## Context packs

`context_pack { goal, scope, files?, symbols?, budget_tokens }` assembles what a worker needs to start, in priority order, trimmed to the budget with a note for whatever did not fit:

1. **The scoped files**, ranked by how much they mention the goal: whole when small, otherwise their outline plus the lines that mention the task.
2. **Definitions of symbols the goal names** (`backticked`, camelCase, PascalCase or snake_case words), wherever they are defined.
3. **The tests that cover the scope**, or a note that there are none.
4. **The project's conventions**: the first 60 lines of each instruction file.

`@mcp-horde/board` appends a pack to every brief (`board_brief`), within the brief's budget; the orchestrator does not have to call this itself.

## Languages

Definitions come from tree-sitter syntax trees for TypeScript/TSX, JavaScript, Python, Go, Rust, Java, Kotlin and C#: functions, classes, methods, interfaces, types, enums, modules, top-level variables (also names exported through `export { … }` lists and CommonJS `exports.x =`), with their exact extents, doc comments and docstrings. Code inside strings and comments defines nothing, and references and call sites skip mentions in comments and strings (string interpolations count as code). The grammars are prebuilt WebAssembly (`grammars/`, fetched by `scripts/fetch-grammars.mjs`; licenses in `grammars/NOTICE.md`), loaded once at startup in about 60 ms; no native build. If a grammar cannot load, or a file has a syntax error, line patterns cover the file or its broken part, and `context_map` says which is in use. Imports come from language-aware patterns. Import resolution covers relative TS/JS imports (including ESM `.js` specifiers for `.ts` sources and directory `index` files), `compilerOptions.paths` and `baseUrl` from the nearest `tsconfig.json`/`jsconfig.json` (comments allowed, one level of relative `extends`), workspace packages by name (an exports `source` condition, or the source twin of `main`/`types`), Python relative and absolute modules (root, `src/` and `lib/` layouts; `from pkg import mod` links `pkg/mod.py` when it exists), Go packages under the module path of the nearest `go.mod`, Rust `mod`, `use crate::…`, `super::…` and `self::…`, and Java/Kotlin classes, packages (`import a.b.*`) and static imports. C# namespaces are not mapped to files.

## Configuration

`horde.json` at the repository root:

```json
{ "context": { "ignore": ["fixtures/", "**/*.generated.ts"], "entrypoints": ["scripts/seed.ts"] } }
```

`ignore` extends `.gitignore`; `entrypoints` are always listed by `context_map`.

Paths and `paths`/`scope` filters are relative to the project root: a plain path (`src/`, `src/users`) covers that file or directory at the root only, a glob (`**/src/**`, `*.ts`) matches as globs do, and `.` means the whole project. Only the project's listed files are read: nothing outside the root (absolute paths, `..`, symlinks pointing out), no ignored files, and no directories, FIFOs or devices. Outside a git repository, or in a directory git lists nothing for (one a parent repository ignores), the files are found by walking the directory.

## Setup

```sh
claude mcp add context -- node /path/to/mcp-horde/packages/context/dist/index.js
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `HORDE_CONTEXT_DIRECTORY` | current directory | Default project directory (each tool also takes `directory`). |

## Known limits

- **Syntax, not types.** Call sites are found by name, outside comments and strings; two different functions with the same name are not told apart, and definitions generated by macros or code generation are not seen. Functions defined inside other functions are left out on purpose (local helpers).
- **References are textual.** `context_symbol` counts whole-word, case-sensitive uses of the exact name in source files, so a different symbol with the same name is counted too.
- **Large repositories:** listing stops at 50,000 files and files over 1 MB are not read; narrow searches with `paths`.
