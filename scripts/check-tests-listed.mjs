// Every test file must be named by a script of its package, so a new file cannot sit unrun
// (packages list their test files by hand; packages/opencode/test/support-fixes.test.ts sat
// unlisted for ten days). e2e files count when test:e2e names them.
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const missing = []
for (const pkg of fs.readdirSync(path.join(root, "packages"))) {
  const dir = path.join(root, "packages", pkg)
  const testDir = path.join(dir, "test")
  if (!fs.existsSync(testDir)) continue
  const scripts = Object.values(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).scripts ?? {}).join("\n")
  for (const f of fs.readdirSync(testDir)) {
    if (!/\.test\.(ts|mjs|js)$/.test(f)) continue
    if (!scripts.includes(`test/${f}`)) missing.push(`packages/${pkg}/test/${f}`)
  }
}
const hookScripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts ?? {}
if (!Object.values(hookScripts).join("\n").includes("plugins/horde/hooks/*.test.mjs")) missing.push("plugins/horde/hooks/*.test.mjs (root pretest)")
if (missing.length) {
  console.error(`test files no script runs:\n  ${missing.join("\n  ")}`)
  process.exit(1)
}
console.log("every test file is named by a script")
