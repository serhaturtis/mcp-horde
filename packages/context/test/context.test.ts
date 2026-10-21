import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { before, describe, test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  excerpt,
  find,
  importGraph,
  importSpecs,
  type Lang,
  loadSyntax,
  openProject,
  pack,
  definitions as parsedDefinitions,
  patternDefinitions,
  projectMap,
  readText,
  select,
  symbol,
  syntaxStatus,
  testsFor,
} from "../src/lib.js"

// Every test below runs on tree-sitter; "line patterns" repeats the definition tests without it.
before(() => loadSyntax())

const pkg = path.join(import.meta.dirname, "..")

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "demo", main: "dist/index.js", bin: { demo: "dist/cli.js" } }),
  "CLAUDE.md": "# Conventions\nUse named exports.\nNever use default exports.\n",
  ".gitignore": "generated/\n",
  "generated/big.ts": "export const junk = 1\n",
  "horde.json": JSON.stringify({ context: { ignore: ["fixtures/"], entrypoints: ["scripts/seed.ts"] } }),
  "fixtures/data.ts": "export const fixture = 1\n",
  "scripts/seed.ts": "import { createUser } from '../src/users/service.js'\ncreateUser('seed')\n",
  "src/index.ts": "export { createUser } from './users/service.js'\nexport * from './util'\n",
  "src/cli.ts": "import { createUser } from './users/service.js'\nconsole.log(createUser(process.argv[2] ?? 'x'))\n",
  "src/util/index.ts": "export const slug = (s: string) => s.toLowerCase()\n",
  "src/users/service.ts": [
    "import { slug } from '../util/index.js'",
    "import type { User } from './types'",
    "",
    "/** Create a user with a unique slug. */",
    "export function createUser(name: string): User {",
    "  const id = slug(name)",
    "  return { id, name }",
    "}",
    "",
    "export class UserStore {",
    "  private users = new Map<string, User>()",
    "",
    "  async save(user: User): Promise<void> {",
    "    if (this.users.has(user.id)) {",
    "      throw new Error('duplicate')",
    "    }",
    "    this.users.set(user.id, user)",
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/users/types.ts": "export interface User {\n  id: string\n  name: string\n}\n\nexport type Id = string\n",
  "src/users/service.test.ts": "import { createUser } from './service.js'\ncreateUser('a')\n",
  "test/users/types.test.ts": "import type { User } from '../../src/users/types.js'\n",
  "test/integration.test.ts": "import { UserStore } from '../src/users/service.js'\nnew UserStore()\n",
  "py/app/__init__.py": "",
  "py/app/models.py":
    'class Order:\n    """An order.\n\n    Holds lines."""\n\n    def total(self, tax: float = 0) -> float:\n        return 0\n\n\nLIMIT = 5\n',
  "py/app/api.py": "from .models import Order\nfrom . import models\nimport os\n\nasync def handler(req):\n    return Order()\n",
  "py/tests/test_models.py": "from app.models import Order\n",
  "go.mod": "module example.com/demo\n\ngo 1.22\n",
  "internal/calc/calc.go":
    "package calc\n\n// Add adds.\nfunc Add(a, b int) int {\n\treturn a + b\n}\n\ntype Calc struct{}\n\nfunc (c *Calc) Sum(xs ...int) int {\n\treturn 0\n}\n",
  "internal/calc/calc_test.go": 'package calc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {}\n',
  "cmd/demo/main.go": 'package main\n\nimport (\n\t"fmt"\n\t"example.com/demo/internal/calc"\n)\n\nfunc main() { fmt.Println(calc.Add(1, 2)) }\n',
  "rs/src/lib.rs":
    'pub mod parser;\n\n/// Entry.\npub fn run() -> u32 {\n    parser::parse("x")\n}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn it_runs() {}\n}\n',
  "rs/src/parser.rs": "use crate::lib;\n\npub struct Parser {\n    pos: usize,\n}\n\npub fn parse(s: &str) -> u32 {\n    0\n}\n",
  "java/src/main/java/com/acme/Billing.java":
    "package com.acme;\n\nimport com.acme.util.Money;\n\npublic class Billing {\n    public Money charge(int cents) {\n        return new Money(cents);\n    }\n}\n",
  "java/src/main/java/com/acme/util/Money.java": "package com.acme.util;\n\npublic record Money(int cents) {}\n",
  "java/src/test/java/com/acme/BillingTest.java": "package com.acme;\n\nclass BillingTest {}\n",
  "logo.png": "\u0000PNG",
  "packages/a/package.json": JSON.stringify({ name: "@demo/a", exports: { ".": { source: "./src/index.ts", default: "./dist/index.js" } } }),
  "packages/a/src/index.ts": "export { thing } from './thing.js'\n",
  "packages/a/src/thing.ts": "export const thing = 1\n",
  "packages/a/test/a.test.ts": "import { thing } from '@demo/a'\nimport { other } from '@demo/a/src/other'\n",
}

function fixture(files = FILES): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "horde-ctx-"))
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
    fs.writeFileSync(path.join(dir, f), text)
  }
  execFileSync("git", ["init", "-q"], { cwd: dir })
  return dir
}

const root = fixture()
const project = () => openProject(root)

describe("files", () => {
  test("git listing honours .gitignore and horde.json context.ignore; untracked files count", () => {
    const p = project()
    assert.ok(p.files.includes("src/users/service.ts"))
    assert.ok(!p.files.includes("generated/big.ts"), "gitignored")
    assert.ok(!p.files.includes("fixtures/data.ts"), "context.ignore")
    assert.deepEqual(p.settings.entrypoints, ["scripts/seed.ts"])
  })
})

for (const [mode, definitions] of [
  ["tree-sitter", parsedDefinitions],
  ["line patterns", patternDefinitions],
] as const)
  describe(`definitions (${mode})`, () => {
    test("TypeScript: functions, classes, methods, interfaces, types, with docs and block ends", () => {
      const d = definitions(FILES["src/users/service.ts"]!, "ts")
      const by = (n: string) => d.find((x) => x.name === n)!
      assert.deepEqual(
        d.map((x) => `${x.kind}:${x.name}`),
        ["function:createUser", "class:UserStore", "method:save"],
      )
      assert.equal(by("createUser").doc, "Create a user with a unique slug.")
      assert.equal(by("createUser").signature, "export function createUser(name: string): User")
      assert.deepEqual([by("createUser").line, by("createUser").end], [5, 8])
      assert.deepEqual([by("UserStore").line, by("UserStore").end], [10, 19])
      assert.deepEqual([by("save").line, by("save").end], [13, 18])
      assert.ok(by("createUser").exported && !by("save").exported)
      const t = definitions(FILES["src/users/types.ts"]!, "ts")
      assert.deepEqual(
        t.map((x) => `${x.kind}:${x.name}:${x.line}-${x.end}`),
        ["interface:User:1-4", "type:Id:6-6"],
      )
      assert.deepEqual(
        definitions(FILES["src/util/index.ts"]!, "ts").map((x) => x.name),
        ["slug"],
      )
      const cjs = definitions("exports.add = (a, b) => a + b\nmodule.exports.sub = function (a, b) {\n  return a - b\n}\n", "js")
      assert.deepEqual(
        cjs.map((x) => `${x.kind}:${x.name}:${x.line}-${x.end}:${x.exported}`),
        ["variable:add:1-1:true", "variable:sub:2-4:true"],
        "CommonJS exports",
      )
      // Allman braces (C#) still span the block.
      assert.deepEqual(
        definitions("public class Shop\n{\n    public int Total() { return 0; }\n}\n", "cs").map((x) => `${x.name}:${x.line}-${x.end}`),
        ["Shop:1-4", "Total:3-3"],
      )
    })

    test("Python, Go, Rust, Java", () => {
      const py = definitions(FILES["py/app/models.py"]!, "py")
      assert.deepEqual(
        py.map((x) => `${x.kind}:${x.name}:${x.line}-${x.end}`),
        ["class:Order:1-7", `${mode === "tree-sitter" ? "method" : "function"}:total:6-7`, "variable:LIMIT:10-10"],
      )
      assert.equal(py[0]!.doc, "An order.\n\nHolds lines.")
      assert.equal(definitions(FILES["py/app/api.py"]!, "py")[0]!.signature, "async def handler(req):")
      const go = definitions(FILES["internal/calc/calc.go"]!, "go")
      assert.deepEqual(
        go.map((x) => `${x.kind}:${x.name}`),
        ["function:Add", "class:Calc", "method:Sum"],
      )
      assert.equal(go[0]!.doc, "Add adds.")
      assert.ok(go[0]!.exported)
      const rs = definitions(FILES["rs/src/parser.rs"]!, "rs")
      assert.deepEqual(
        rs.map((x) => `${x.kind}:${x.name}:${x.line}-${x.end}`),
        ["class:Parser:3-5", "function:parse:7-9"],
      )
      assert.equal(definitions(FILES["rs/src/lib.rs"]!, "rs")[0]!.doc, "Entry.")
      const java = definitions(FILES["java/src/main/java/com/acme/Billing.java"]!, "java")
      assert.deepEqual(
        java.map((x) => `${x.kind}:${x.name}`),
        ["class:Billing", "method:charge"],
        "`return new Money(...)` is not a definition",
      )
    })
  })

describe("imports and tests", () => {
  test("specifiers and resolution: TS ESM .js → .ts, directory index, Python relative, Go module, Rust mod, Java packages", () => {
    assert.deepEqual(importSpecs(FILES["src/index.ts"]!, "ts"), ["./users/service.js", "./util"])
    assert.deepEqual(
      importSpecs(FILES["py/app/api.py"]!, "py"),
      [".models", ".models", "os"].filter((v, i, a) => a.indexOf(v) === i),
    )
    const g = importGraph(project())
    assert.deepEqual(g.out.get("src/index.ts"), ["src/users/service.ts", "src/util/index.ts"])
    assert.deepEqual(g.out.get("src/users/service.ts"), ["src/util/index.ts", "src/users/types.ts"])
    assert.deepEqual(g.out.get("py/app/api.py"), ["py/app/models.py"])
    assert.deepEqual(g.out.get("cmd/demo/main.go"), ["internal/calc/calc.go"])
    assert.deepEqual(g.out.get("rs/src/lib.rs"), ["rs/src/parser.rs"])
    assert.deepEqual(g.out.get("java/src/main/java/com/acme/Billing.java"), ["java/src/main/java/com/acme/util/Money.java"])
    assert.deepEqual(g.in.get("src/users/service.ts")?.sort(), [
      "scripts/seed.ts",
      "src/cli.ts",
      "src/index.ts",
      "src/users/service.test.ts",
      "test/integration.test.ts",
    ])
  })

  test("tests for files: naming, mirrors, importers, Go packages, Rust inline tests", () => {
    const r = testsFor(project(), [
      "src/users/service.ts",
      "src/users/types.ts",
      "py/app/models.py",
      "internal/calc/calc.go",
      "rs/src/lib.rs",
      "java/src/main/java/com/acme/Billing.java",
      "src/util/index.ts",
      "src/users/service.test.ts",
    ])
    const of = (f: string) => r.get(f)!.map((t) => `${t.test} (${t.why})`)
    assert.deepEqual(of("src/users/service.ts"), ["src/users/service.test.ts (naming)", "test/integration.test.ts (imports it)"])
    assert.deepEqual(of("src/users/types.ts"), ["test/users/types.test.ts (imports it)"], "a generic stem is matched by imports only")
    assert.deepEqual(of("py/app/models.py"), ["py/tests/test_models.py (mirror)"])
    assert.deepEqual(of("internal/calc/calc.go"), ["internal/calc/calc_test.go (naming)"])
    assert.deepEqual(of("rs/src/lib.rs"), ["rs/src/lib.rs (inline tests)"])
    assert.deepEqual(of("java/src/main/java/com/acme/Billing.java"), ["java/src/test/java/com/acme/BillingTest.java (mirror)"])
    assert.deepEqual(of("src/util/index.ts"), [], "a generic name does not match unrelated tests")
    assert.deepEqual(of("src/users/service.test.ts"), ["src/users/service.test.ts (is a test)"])
    // Indirect importers count only when asked for: service.ts imports util/index.ts.
    assert.deepEqual(of("src/util/index.ts"), [])
    assert.deepEqual(
      testsFor(project(), ["src/util/index.ts"], { transitive: true })
        .get("src/util/index.ts")!
        .map((t) => `${t.test} (${t.why})`)
        .sort(),
      ["src/users/service.test.ts (imports it via src/users/service.ts)", "test/integration.test.ts (imports it via src/users/service.ts)"],
    )
    // Monorepo workspaces: imported by package name, through the package's re-exporting entry.
    assert.deepEqual(
      testsFor(project(), ["packages/a/src/thing.ts"])
        .get("packages/a/src/thing.ts")!
        .map((t) => `${t.test} (${t.why})`),
      ["packages/a/test/a.test.ts (imports it via packages/a/src/index.ts)"],
    )
  })
})

describe("syntax trees: what line patterns get wrong", () => {
  test("definitions follow the grammar, not the line shape", () => {
    assert.equal(syntaxStatus(), "tree-sitter")
    const names = (text: string, lang: Lang, file?: string) =>
      parsedDefinitions(text, lang, file).map((d) => `${d.kind}:${d.name}:${d.line}-${d.end}:${d.exported}`)
    // Code inside a string or comment defines nothing; a call at the start of a line is no method.
    assert.deepEqual(names("const tpl = `\nfunction fake() {}\n`\n/*\nclass Ghost {}\n*/\nexport function real() {\n  unwrap(\n    x,\n  )\n}\n", "ts"), [
      "variable:tpl:1-3:false",
      "function:real:7-11:true",
    ])
    // Names exported through an export list; a signature spread over lines.
    assert.deepEqual(names("function a() {}\nconst b = 1\nexport { a, b as c }\nexport async function\nlate(x: number) {}\n", "ts"), [
      "function:a:1-1:true",
      "variable:b:2-2:true",
      "function:late:4-5:true",
    ])
    assert.deepEqual(names("export const App = () => <div>{1}</div>\n", "ts", "src/App.tsx"), ["variable:App:1-1:true"], "TSX parses with its own grammar")
    // Grouped Go constants, Rust impl methods, Kotlin interfaces and objects, C# records.
    assert.deepEqual(names("package p\n\nconst (\n\tA = 1\n\tb = 2\n)\n", "go"), ["variable:A:4-4:true", "variable:b:5-5:false"])
    assert.deepEqual(names("struct S;\nimpl S {\n    pub fn m(&self) {}\n}\n", "rs"), ["class:S:1-1:false", "method:m:3-3:true"])
    assert.deepEqual(names("interface Shape {\n    fun area(): Double\n}\n\nobject Registry\n", "kt"), [
      "interface:Shape:1-3:true",
      "method:area:2-2:true",
      "class:Registry:5-5:true",
    ])
    assert.deepEqual(names("public record Point(int X, int Y);\n", "cs"), ["class:Point:1-1:true"])
    // A syntax error does not lose the definitions around it: the patterns cover the broken part.
    assert.ok(names("export function ok() {}\nfunction broken( {\n", "ts").some((d) => d.startsWith("function:ok:")))
  })

  test("references skip comments and strings but not interpolations", () => {
    const dir = fixture({
      "lib.ts": "export function price(n: number) {\n  return n\n}\n",
      "use.ts":
        "import { price } from './lib.js'\n// price is computed here\nconst label = 'price'\nconst total = price(2)\nconst msg = `cost: $" +
        "{price(3)}`\n/* price */ const x = 1\n",
      "app.py": 'def total():\n    """Uses total."""\n    return 1\n\nprint(f"{total()} total")\n# total\n',
    })
    const p = openProject(dir)
    assert.deepEqual(
      find(p, "price", { kind: "reference", paths: ["use.ts"] }).hits.map((h) => h.line),
      [1, 4, 5],
    )
    assert.deepEqual(
      find(p, "total", { kind: "reference", paths: ["app.py"] }).hits.map((h) => h.line),
      [5],
    )
    assert.equal(symbol(p, "price")[0]!.callCount, 3)
    // Text search is literal: dots and spaces mean themselves.
    assert.equal(find(p, "n: number").total, 1)
    assert.equal(find(p, "lib.js").total, 1)
    assert.equal(find(p, "lib?js").total, 0)
  })
})

describe("search", () => {
  test("find text, definitions and references; symbol with call sites; excerpts", () => {
    const p = project()
    const text = find(p, "createuser")
    assert.ok(text.total >= 6, "smart case: lower-case query is case-insensitive")
    assert.equal(find(p, "CreateUser").total, 0, "capitals make it case-sensitive")
    assert.deepEqual(
      find(p, "createUser", { kind: "definition" }).hits.map((h) => `${h.file}:${h.line}`),
      ["src/users/service.ts:5"],
    )
    const refs = find(p, "createUser", { kind: "reference", paths: ["src/"] }).hits.map((h) => `${h.file}:${h.line}`)
    assert.ok(!refs.includes("src/users/service.ts:5"), "the definition is not a reference")
    assert.ok(refs.includes("src/cli.ts:2"))
    assert.equal(find(p, "/User(Store)?\\b/", { paths: ["test/"] }).total, 3)

    const [s] = symbol(p, "createUser")
    assert.equal(s!.file, "src/users/service.ts")
    assert.ok(s!.callCount >= 6)
    assert.ok(s!.calls.some((c) => c.file === "scripts/seed.ts" && c.line === 2))

    assert.match(
      excerpt(p, "src/users/service.ts", { lines: "5-6" }),
      /^src\/users\/service\.ts \(lines 5-6 of 19\)\n5 {2}export function createUser[\s\S]*6 {2} {2}const id/,
    )
    const save = excerpt(p, "src/users/service.ts", { symbols: ["save", "nope"] })
    assert.match(save, /src\/users\/service\.ts:13-18 method save\n13 {2} {2}async save/)
    assert.match(save, /not defined in src\/users\/service\.ts: nope \(it defines: createUser, UserStore, save\)/)
    assert.match(excerpt(p, "src/users/service.ts", { budgetChars: 300 }), /too long to show whole: outline/)
    assert.throws(() => excerpt(p, "logo.png"), /binary/)
    assert.throws(() => excerpt(p, "missing.ts"), /no file missing\.ts/)
  })
})

describe("map and pack", () => {
  test("the map lists instructions, manifests, entry points (sources for build targets), test directories", () => {
    const m = projectMap(project())
    assert.match(m, /files · TypeScript \d+/)
    assert.match(m, /Project instructions \(read these\): CLAUDE\.md/)
    assert.match(m, /Manifests: .*go\.mod/)
    assert.match(m, /Manifests: .*package\.json/)
    assert.match(m, /Entry points: scripts\/seed\.ts, src\/index\.ts, src\/cli\.ts/)
    assert.match(m, /Test directories: .*py\/tests/)
    assert.match(m, /Directories:\n[\s\S]*\n {2}users\/ {2}\d+ files/)
    assert.match(projectMap(project(), { budgetChars: 400 }), /more directories/)
  })

  test("a pack holds scoped files, named symbols, covering tests and conventions, within budget", () => {
    const p = project()
    const out = pack(p, { goal: "Make `createUser` reject empty names; keep slug() as is.", scope: ["src/users/**"], budgetTokens: 3000 })
    assert.match(out, /^## Code context/)
    assert.match(out, /### src\/users\/service\.ts\n 1 {2}import \{ slug \}/)
    assert.match(
      out,
      /### Tests that cover the scope\n- src\/users\/service\.ts: src\/users\/service\.test\.ts \(naming\), test\/integration\.test\.ts \(imports it\)/,
    )
    assert.match(out, /### CLAUDE\.md \(project conventions\)\n# Conventions/)
    const small = pack(p, { goal: "Make createUser reject empty names", scope: ["src/users/**"], budgetTokens: 200 })
    assert.ok(small.length <= 800, `${small.length} chars`)
    // A tight budget shortens or leaves out files, and says so either way.
    assert.match(small, /more file\(s\) in scope not shown|… \[\+\d+ chars\]/)
    const outside = pack(p, { goal: "Document `Order` totals", scope: ["docs/**"] })
    assert.match(outside, /matches no existing files yet/)
    const long = fixture({ "CLAUDE.md": `${Array.from({ length: 70 }, (_, i) => `rule ${i + 1}`).join("\n")}\n`, "a.ts": "export const a = 1\n" })
    const cut = pack(openProject(long), { goal: "Change a", scope: ["a.ts"] })
    assert.match(cut, /### CLAUDE\.md \(project conventions, first 60 of 70 lines; read the rest before changing code\)\nrule 1\n/)
    assert.doesNotMatch(cut, /rule 61/)
    assert.match(outside, /### class Order \(py\/app\/models\.py:1-7\)/)
  })
})

describe("paths and files", () => {
  // Symlinks and FIFOs need POSIX (Windows checkouts get symlinks as plain files).
  test("readText reads only the project's regular files inside its root", { skip: process.platform === "win32" }, () => {
    const dir = fixture({ "a.ts": "export const a = 1\n", "sub/x.ts": "" })
    fs.symlinkSync("/etc/passwd", path.join(dir, "passwd"))
    fs.symlinkSync("a.ts", path.join(dir, "inside.ts"))
    execFileSync("mkfifo", [path.join(dir, "pipe.ts")])
    const p = openProject(dir, { fresh: true })
    assert.ok(p.files.includes("passwd"), "git lists the symlink")
    assert.equal(readText(p, "passwd"), undefined, "a symlink leaving the root")
    assert.equal(readText(p, "inside.ts"), "export const a = 1\n", "a symlink inside the root")
    assert.throws(() => excerpt(p, "passwd"), /passwd links outside/)
    assert.throws(() => excerpt(p, "../etc/passwd"), /outside/)
    assert.throws(() => excerpt(p, "/etc/passwd"), /outside/)
    assert.equal(readText(p, "/etc/passwd"), undefined)
    assert.equal(readText(p, "../a.ts"), undefined)
    // Listed but not regular files (a submodule's gitlink is a directory; FIFOs would block).
    const odd = { ...p, files: [...p.files, "sub", "pipe.ts"].sort() }
    assert.equal(readText(odd, "sub"), undefined)
    assert.equal(readText(odd, "pipe.ts"), undefined)
    assert.throws(() => excerpt(odd, "pipe.ts"), /not a regular file/)
    assert.equal(readText(p, "unlisted.ts"), undefined)
  })

  test("openProject: a missing root is an error; a directory git lists nothing in is walked", () => {
    assert.throws(() => openProject(path.join(os.tmpdir(), "horde-ctx-missing-dir")), /no project directory/)
    // A directory its parent repository ignores.
    const parent = fixture({ ".gitignore": "ignored/\n", "ignored/app/main.py": "def main():\n    pass\n", "ignored/CLAUDE.md": "# Rules\n" })
    const p = openProject(path.join(parent, "ignored"))
    assert.deepEqual(p.files, ["CLAUDE.md", "app/main.py"])
    // Instruction files the project ignores are not read into packs.
    const dir = fixture({ ".gitignore": "CLAUDE.md\n", "CLAUDE.md": "# Secret rules\n", "a.ts": "export const a = 1\n" })
    assert.doesNotMatch(pack(openProject(dir), { goal: "change `a`", scope: ["a.ts"] }), /Secret rules/)
  })

  test("select: the root, and plain paths anchored at the root", () => {
    const dir = fixture({ "src/a.ts": "", "packages/x/src/b.ts": "", "srcs/c.ts": "" })
    const p = openProject(dir)
    for (const all of [".", "./", ""]) assert.deepEqual(select(p, [all]), p.files, JSON.stringify(all))
    assert.deepEqual(select(p, ["src/"]), ["src/a.ts"])
    assert.deepEqual(select(p, ["src"]), ["src/a.ts"])
    assert.deepEqual(select(p, ["**/src/**"]), ["packages/x/src/b.ts", "src/a.ts"])
    assert.deepEqual(select(p, ["src/a.ts"]), ["src/a.ts"])
  })

  test("excerpt: line ranges past the end are errors; a final newline is no extra line", () => {
    const dir = fixture({ "a.ts": "one\ntwo\n" })
    const p = openProject(dir)
    assert.match(excerpt(p, "a.ts", { lines: "2-9" }), /^a\.ts \(lines 2-2 of 2\)\n2 {2}two$/)
    assert.throws(() => excerpt(p, "a.ts", { lines: "3-4" }), /a\.ts has 2 lines; line 3 is past its end/)
    assert.throws(() => excerpt(p, "a.ts", { lines: "0-1" }), /1 <= a <= b/)
    assert.throws(() => excerpt(p, "a.ts", { lines: "2-1" }), /1 <= a <= b/)
  })
})

describe("search details", () => {
  test("regex queries: ^ and $ mean line start and end", () => {
    const dir = fixture({ "a.ts": "const x = 1\nexport const y = 2\n" })
    const p = openProject(dir)
    assert.deepEqual(
      find(p, "/^export/").hits.map((h) => h.line),
      [2],
    )
    assert.deepEqual(
      find(p, "/= 1$/").hits.map((h) => h.line),
      [1],
    )
  })

  test("call sites: the exact name, case-sensitive; references only in source files", () => {
    const dir = fixture({
      "lib.ts": "export function slug(s: string) {\n  return s\n}\n",
      "use.ts": "import { slug } from './lib.js'\nslug('a')\nconst Slug = 1\nSLUG()\n",
      "README.md": "Call slug() to make one.\n",
    })
    const p = openProject(dir)
    const [s] = symbol(p, "slug")
    assert.deepEqual(
      s!.calls.map((c) => `${c.file}:${c.line}`),
      ["use.ts:1", "use.ts:2"],
    )
    assert.ok(!find(p, "slug", { kind: "reference" }).hits.some((h) => h.file === "README.md"))
    assert.ok(
      find(p, "slug").hits.some((h) => h.file === "README.md"),
      "text search covers every file",
    )
  })

  test("regular expressions and JSX text are not code", () => {
    const dir = fixture({
      "lib.ts": "export function price() {}\n",
      "view.tsx": "import { price } from './lib.js'\nconst re = /price/\nexport const V = () => <p>price {price()}</p>\n",
    })
    const p = openProject(dir)
    assert.deepEqual(
      find(p, "price", { kind: "reference", paths: ["view.tsx"] }).hits.map((h) => h.line),
      [1, 3],
    )
    assert.equal(find(p, "/price/", { kind: "reference", paths: ["view.tsx"] }).total, 2)
  })
})

describe("definitions: details", () => {
  const names = (text: string, lang: Lang, file?: string) => parsedDefinitions(text, lang, file).map((d) => `${d.kind}:${d.name}:${d.exported}`)

  test("TypeScript: declared functions and overloads, re-exports, object literals, class fields", () => {
    assert.deepEqual(names("declare function f(): void\nexport function g(a: string): void\nexport function g(a: any) {}\n", "ts"), [
      "function:f:false",
      "function:g:true",
    ])
    assert.deepEqual(names('declare module "m" {\n  function h(): void\n}\n', "ts"), ["module:m:false", "function:h:false"])
    assert.deepEqual(names('function a() {}\nexport { a } from "./x"\n', "ts"), ["function:a:false"], "a re-export names another module's a")
    assert.deepEqual(names("export const o = {\n  m() {\n    return 1\n  },\n}\n", "ts"), ["variable:o:true"], "object literal methods are values")
    assert.deepEqual(names("class C {\n  onClick = () => 1\n  n = 1\n  run() {}\n}\n", "ts"), ["class:C:false", "method:onClick:false", "method:run:false"])
    assert.deepEqual(names("class C {\n  f = function () {}\n}\n", "js"), ["class:C:false", "method:f:false"])
  })

  test("doc comments above multi-line decorators and C# attributes", () => {
    const ts = parsedDefinitions(
      "/** The app. */\n@Component({\n  a: 1,\n})\nexport class App {\n  /** Runs. */\n  @Input({\n    x: 1,\n  })\n  run() {}\n}\n",
      "ts",
    )
    assert.deepEqual(
      ts.map((d) => `${d.name}:${d.doc}`),
      ["App:The app.", "run:Runs."],
    )
    const cs = parsedDefinitions('/// <summary>A shop.</summary>\n[Serializable]\n[Obsolete(\n  "old")]\npublic class Shop {}\n', "cs")
    assert.equal(cs[0]!.doc, "<summary>A shop.</summary>")
  })

  test("exported flags follow the language's visibility rules", () => {
    assert.deepEqual(names("mod inner {\n    pub fn f() {}\n}\npub mod open {\n    pub fn g() {}\n    pub(crate) fn h() {}\n}\n", "rs"), [
      "module:inner:false",
      "function:f:false",
      "module:open:true",
      "function:g:true",
      "function:h:false",
    ])
    assert.deepEqual(names("pub trait T {\n    fn a(&self);\n    fn b(&self) {}\n}\ntrait U {\n    fn c(&self);\n}\n", "rs"), [
      "interface:T:true",
      "method:a:true",
      "method:b:true",
      "interface:U:false",
      "method:c:false",
    ])
    assert.deepEqual(names("public interface Shape {\n    double area();\n}\nclass Hidden {\n    public void m() {}\n}\n", "java"), [
      "interface:Shape:true",
      "method:area:true",
      "class:Hidden:false",
      "method:m:false",
    ])
    assert.deepEqual(names("public interface IShape\n{\n    double Area();\n}\n", "cs"), ["interface:IShape:true", "method:Area:true"])
    assert.deepEqual(names("private class P {\n    fun m() {}\n}\n", "kt"), ["class:P:false", "method:m:false"])
    assert.deepEqual(
      names("try:\n    import fast\n    def run():\n        pass\nexcept ImportError:\n    LIMIT = 1\nif DEBUG:\n    class Dbg:\n        pass\n", "py"),
      ["function:run:true", "variable:LIMIT:true", "class:Dbg:true"],
    )
  })

  test("Python type aliases and tuple targets, Kotlin destructuring, Java anonymous classes", () => {
    assert.deepEqual(names("type Id = int\na, b = 1, 2\n(c, _d) = 3, 4\n", "py"), [
      "type:Id:true",
      "variable:a:true",
      "variable:b:true",
      "variable:c:true",
      "variable:_d:false",
    ])
    assert.deepEqual(names("val (a, b) = pair\nval o = object : Runnable {\n    override fun run() {}\n}\n", "kt"), [
      "variable:a:true",
      "variable:b:true",
      "variable:o:true",
    ])
    assert.deepEqual(
      names("public class A {\n    Runnable r = new Runnable() {\n        public void run() {}\n    };\n    public void own() {}\n}\n", "java"),
      ["class:A:true", "method:own:true"],
    )
  })
})

describe("import resolution details", () => {
  test("Python submodules and parenthesized imports; Java wildcard and static imports; Rust super", () => {
    const dir = fixture({
      "pkg/__init__.py": "",
      "pkg/mod.py": "X = 1\n",
      "pkg/other.py": "Y = 1\n",
      "pkg/third.py": "Z = 1\n",
      "app.py": "from pkg import mod, X\nfrom pkg import (\n    other,  # the other one\n    third,\n)\n",
      "src/com/a/util/Money.java": "package com.a.util;\npublic class Money {}\n",
      "src/com/a/util/Rate.java": "package com.a.util;\npublic class Rate {}\n",
      "src/com/a/Calc.java": "package com.a;\npublic class Calc { public static int add(int a, int b) { return a + b; } }\n",
      "src/com/a/App.java": "package com.a;\nimport com.a.util.*;\nimport static com.a.Calc.add;\nclass App {}\n",
      "rs/src/a/b.rs": "use super::c::f;\nuse self::d::g;\n",
      "rs/src/a/c.rs": "pub fn f() {}\n",
      "rs/src/a/b/d.rs": "pub fn g() {}\n",
    })
    const g = importGraph(openProject(dir))
    assert.deepEqual(g.out.get("app.py")?.sort(), ["pkg/__init__.py", "pkg/mod.py", "pkg/other.py", "pkg/third.py"])
    assert.deepEqual(importSpecs("from . import (\n    a,\n    b,\n)\n", "py"), [".a", ".b"])
    assert.deepEqual(g.out.get("src/com/a/App.java")?.sort(), ["src/com/a/Calc.java", "src/com/a/util/Money.java", "src/com/a/util/Rate.java"])
    assert.deepEqual(g.out.get("rs/src/a/b.rs"), ["rs/src/a/c.rs", "rs/src/a/b/d.rs"])
  })

  test("Go: the nearest go.mod; TypeScript: tsconfig paths and baseUrl", () => {
    const dir = fixture({
      "go.mod": "module example.com/root\n",
      "tools/go.mod": "module example.com/tools\n",
      "tools/lint/lint.go": "package lint\n",
      "tools/cmd/main.go": 'package main\n\nimport "example.com/tools/lint"\n',
      "tsconfig.base.json": '{\n  // shared\n  "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["lib/*"], }, },\n}\n',
      "web/tsconfig.json": '{ "extends": "../tsconfig.base.json", /* web */ "compilerOptions": { "strict": true } }\n',
      "web/app.ts": "import { x } from '@lib/x'\nimport { y } from 'shared/y'\n",
      "lib/x.ts": "export const x = 1\n",
      "shared/y.ts": "export const y = 1\n",
      "app/tsconfig.json": '{ "compilerOptions": { "paths": { "~/*": ["./src/*"], "$schema-like": ["https://example.com//x"] } } }\n',
      "app/src/z.ts": "export const z = 1\n",
      "app/src/main.ts": "import { z } from '~/z'\n",
    })
    const p = openProject(dir)
    const g = importGraph(p)
    assert.deepEqual(g.out.get("tools/cmd/main.go"), ["tools/lint/lint.go"])
    assert.deepEqual(g.out.get("web/app.ts"), ["lib/x.ts", "shared/y.ts"])
    assert.deepEqual(g.out.get("app/src/main.ts"), ["app/src/z.ts"])
    // A fresh listing of the same files reuses the graph; a changed import builds it again.
    assert.equal(importGraph(openProject(dir, { fresh: true })), g)
    fs.writeFileSync(path.join(dir, "app/src/main.ts"), "export const main = 1\n")
    const g2 = importGraph(openProject(dir, { fresh: true }))
    assert.notEqual(g2, g)
    assert.deepEqual(g2.out.get("app/src/main.ts"), [])
  })

  test("C# tests mirror the project they test", () => {
    const dir = fixture({
      "src/Shop/Billing/Invoice.cs": "namespace Shop.Billing;\npublic class Invoice {}\n",
      "tests/Shop.Tests/Billing/InvoiceTests.cs": "public class InvoiceTests {}\n",
      "Shop.Test/InvoiceTest.cs": "public class InvoiceTest {}\n",
    })
    const r = testsFor(openProject(dir), ["src/Shop/Billing/Invoice.cs"])
    assert.deepEqual(
      r
        .get("src/Shop/Billing/Invoice.cs")!
        .map((t) => `${t.test} (${t.why})`)
        .sort(),
      ["Shop.Test/InvoiceTest.cs (mirror)", "tests/Shop.Tests/Billing/InvoiceTests.cs (mirror)"],
    )
  })

  test("pack: bare file names in the goal; named symbols defined in the scope first", () => {
    const dir = fixture({
      "a/render.ts": "export function draw() {\n  return 'a'\n}\n",
      "b/render.ts": "export function draw() {\n  return 'b'\n}\n",
      "b/only.ts": "export const only = 1\n",
    })
    const p = openProject(dir)
    assert.match(pack(p, { goal: "Fix only.ts please" }), /### b\/only\.ts\n/)
    const out = pack(p, { goal: "Fix `draw`", scope: ["b/**"], files: [] })
    assert.match(out, /### b\/render\.ts\n/)
    assert.doesNotMatch(out, /a\/render\.ts/)
  })
})

describe("MCP server", () => {
  test("tools over stdio", async () => {
    const client = new Client({ name: "test", version: "0" })
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--conditions=source", "--import", "tsx", path.join(pkg, "src/index.ts")],
        cwd: pkg,
        env: { ...(process.env as Record<string, string>), HORDE_CONTEXT_DIRECTORY: root },
        stderr: "inherit",
      }),
    )
    try {
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
        const text = res.content.map((c) => c.text).join("\n")
        if (res.isError) throw new Error(text)
        return text
      }
      assert.match(await call("context_map"), /Project instructions/)
      assert.match(await call("context_find", { query: "Order", kind: "definition" }), /^py\/app\/models\.py:1 {2}class Order:/)
      assert.match(
        await call("context_symbol", { name: "Add" }),
        /function Add \(exported\) — internal\/calc\/calc\.go:4-6\n {2}func Add\(a, b int\) int\n {2}│ Add adds\.\n {2}1 use elsewhere:\n {4}cmd\/demo\/main\.go:8/,
      )
      assert.match(await call("context_symbol", { name: "creatUser" }), /No definition of creatUser/)
      assert.match(await call("context_file", { path: "src/users/types.ts", symbols: ["Id"] }), /6 {2}export type Id = string/)
      assert.equal(await call("context_imports", { path: "src/users/types.ts", direction: "in" }), "src/users/service.ts\ntest/users/types.test.ts")
      assert.match(await call("context_tests_for", { files: ["src/util/index.ts"] }), /src\/util\/index\.ts: no tests found/)
      assert.match(await call("context_pack", { goal: "x", scope: ["internal/**"] }), /calc_test\.go \(naming\)/)
      await assert.rejects(call("context_imports", { path: "nope.ts" }), /no file nope\.ts/)
    } finally {
      await client.close()
    }
  })
})
