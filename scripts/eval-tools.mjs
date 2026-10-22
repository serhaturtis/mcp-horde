#!/usr/bin/env node
// Saves the real definitions of the horde's six main tools for the plugin's eval suite. The
// mocked tools there carry whatever this file says, and their descriptions are part of what the
// suite measures, so it has to match the bundled server.
//
//   node scripts/eval-tools.mjs           write plugins/horde/evals/mocks/opencode/_tools.json
//   node scripts/eval-tools.mjs --check   fail if it no longer matches the bundled server
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const file = path.join(root, "plugins", "horde", "evals", "mocks", "opencode", "_tools.json")
const names = ["horde_do", "horde_investigate", "horde_wait", "horde_tell", "horde_land", "horde_drop"]

// A throwaway state directory: listing tools must not write to the real one.
const state = fs.mkdtempSync(path.join(os.tmpdir(), "horde-eval-tools-"))
const client = new Client({ name: "eval-tools", version: "0" })
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "plugins", "horde", "servers", "opencode.js")],
      env: { ...process.env, XDG_STATE_HOME: state },
      cwd: root,
    }),
  )
  const { tools } = await client.listTools()
  const text = `${JSON.stringify({ tools: names.map((n) => tools.find((t) => t.name === n) ?? n) }, null, 2)}\n`
  const missing = names.filter((n) => !tools.some((t) => t.name === n))
  if (missing.length) throw new Error(`the bundled server has no ${missing.join(", ")}`)
  if (process.argv.includes("--check")) {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text) {
      console.error(`${path.relative(root, file)} is out of date: run node scripts/eval-tools.mjs and commit the result`)
      process.exitCode = 1
    } else console.log("eval tool definitions are up to date")
  } else {
    fs.writeFileSync(file, text)
    console.log(`${path.relative(root, file)}  ${names.length} tools`)
  }
} finally {
  await client.close()
  fs.rmSync(state, { recursive: true, force: true })
}
