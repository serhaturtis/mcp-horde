#!/usr/bin/env node
// Fetches the tree-sitter grammars @mcp-horde/context parses with, as prebuilt WebAssembly
// from the grammars' npm packages, into packages/context/grammars/ (gzipped, with their
// licenses). The grammar packages themselves are never installed: they build native
// bindings on install, and only their .wasm is needed.
//
//   node scripts/fetch-grammars.mjs     after changing GRAMMARS below; commit the result
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import zlib from "node:zlib"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const out = path.join(root, "packages", "context", "grammars")

// package@version → the .wasm files it ships (named as the context package loads them).
const GRAMMARS = {
  "tree-sitter-typescript@0.23.2": ["tree-sitter-typescript.wasm", "tree-sitter-tsx.wasm"],
  "tree-sitter-javascript@0.25.0": ["tree-sitter-javascript.wasm"],
  "tree-sitter-python@0.25.0": ["tree-sitter-python.wasm"],
  "tree-sitter-go@0.25.0": ["tree-sitter-go.wasm"],
  "tree-sitter-rust@0.24.0": ["tree-sitter-rust.wasm"],
  "tree-sitter-java@0.23.5": ["tree-sitter-java.wasm"],
  "tree-sitter-c-sharp@0.23.5": ["tree-sitter-c_sharp.wasm"],
  "@tree-sitter-grammars/tree-sitter-kotlin@1.1.0": ["tree-sitter-kotlin.wasm"],
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "horde-grammars-"))
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
const notices = []
for (const [spec, files] of Object.entries(GRAMMARS)) {
  const dir = fs.mkdtempSync(path.join(tmp, "pkg-"))
  const tgz = execFileSync("npm", ["pack", spec, "--silent", "--pack-destination", dir], { encoding: "utf8", shell: process.platform === "win32" }).trim()
  execFileSync("tar", ["-xzf", path.join(dir, tgz.split("\n").pop()), "-C", dir])
  const pkg = path.join(dir, "package")
  for (const f of files) {
    fs.writeFileSync(path.join(out, `${f}.gz`), zlib.gzipSync(fs.readFileSync(path.join(pkg, f)), { level: 9 }))
    console.log(`${spec}: ${f}`)
  }
  const license = fs.readdirSync(pkg).find((f) => /^licen[cs]e/i.test(f))
  notices.push(
    `## ${spec}\n\n${license ? fs.readFileSync(path.join(pkg, license), "utf8").trim() : `License: ${JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).license}`}\n`,
  )
}
fs.writeFileSync(
  path.join(out, "NOTICE.md"),
  `# Grammars\n\nPrebuilt tree-sitter grammars, fetched by scripts/fetch-grammars.mjs from these npm packages (gzipped; otherwise unchanged).\n\n${notices.join("\n")}`,
)
fs.rmSync(tmp, { recursive: true, force: true })
