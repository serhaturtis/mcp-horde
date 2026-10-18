import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { definitions, excerpt, find, importGraph, importSpecs, openProject, pack, projectMap, symbol, testsFor } from "../src/lib.js"

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

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "horde-ctx-"))
  for (const [f, text] of Object.entries(FILES)) {
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

describe("definitions", () => {
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
      ["class:Order:1-7", "function:total:6-7", "variable:LIMIT:10-10"],
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
      /^src\/users\/service\.ts \(lines 5-6 of 20\)\n5 {2}export function createUser[\s\S]*6 {2} {2}const id/,
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
    assert.match(small, /more file\(s\) in scope not shown/)
    const outside = pack(p, { goal: "Document `Order` totals", scope: ["docs/**"] })
    assert.match(outside, /matches no existing files yet/)
    assert.match(outside, /### class Order \(py\/app\/models\.py:1-7\)/)
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
