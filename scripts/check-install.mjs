// Does node_modules match package-lock.json? Every installed package (node_modules/.package-lock.json)
// must be in the lock at the same version, and every lock entry that is neither optional nor a
// workspace link must be installed. ci.sh runs `npm ci` when this fails, so the bundle check and
// the tests never judge a drifted install.
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), "utf8")).packages ?? {}
let lock
let installed
try {
  lock = read("package-lock.json")
  installed = read("node_modules/.package-lock.json")
} catch (err) {
  console.error(`install check: ${err.message}`)
  process.exit(1)
}
const problems = []
for (const [name, entry] of Object.entries(installed)) {
  if (!name) continue
  if (!(name in lock)) problems.push(`${name} is installed but not in package-lock.json`)
  else if (lock[name].version !== entry.version) problems.push(`${name}: installed ${entry.version}, lock says ${lock[name].version}`)
}
for (const [name, entry] of Object.entries(lock)) {
  if (!name || entry.link || entry.optional || !name.startsWith("node_modules/")) continue
  if (!(name in installed)) problems.push(`${name}@${entry.version} is in package-lock.json but not installed`)
}
if (problems.length) {
  console.error(
    `node_modules does not match package-lock.json:\n  ${problems.slice(0, 20).join("\n  ")}${problems.length > 20 ? `\n  … ${problems.length - 20} more` : ""}`,
  )
  process.exit(1)
}
console.log("node_modules matches package-lock.json")
