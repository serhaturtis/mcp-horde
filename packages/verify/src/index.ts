#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { loadSyntax } from "@mcp-horde/context"
import { git, packageVersion, recordLifecycle, truncateHead } from "@mcp-horde/core"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { audit, diffBase } from "./audit.js"
import { checkScripts, detectChecks, loadSettings, loadSettingsAt } from "./detect.js"
import { defaultStateDir, gate } from "./gate.js"
import { logDirFor, logFileFor } from "./run.js"

const VERSION = packageVersion(import.meta.url)
recordLifecycle("verify", VERSION)

process.on("unhandledRejection", (err) => {
  process.stderr.write(`[mcp-horde/verify] unhandled rejection: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
})

const DEFAULT_DIR = path.resolve(process.env.HORDE_VERIFY_DIRECTORY || process.cwd())
const STATE_DIR = defaultStateDir()

type Extra = {
  signal: AbortSignal
  _meta?: { progressToken?: string | number }
  sendNotification: (n: { method: "notifications/progress"; params: Record<string, unknown> }) => Promise<void>
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] })
const fail = (err: unknown): CallToolResult => ({
  content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
})

/** Progress notifications keep long check runs alive in clients with idle timeouts. */
function progress(extra: Extra) {
  const token = extra._meta?.progressToken
  if (token === undefined) return undefined
  let n = 0
  return (message: string) => {
    void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++n, message } }).catch(() => undefined)
  }
}

const dir = (d?: string) => (d ? path.resolve(DEFAULT_DIR, d) : DEFAULT_DIR)

export const INSTRUCTIONS = `verify: mechanical judgement of code changes, with compact verdicts.
- verify_gate is the one to use: it runs the project's checks (tests, typecheck, lint) and, given a base commit, audits the diff for out-of-scope edits, deleted or skipped tests, suppressions, new dependencies, secrets and binaries. PASS means the checks passed and nothing blocking was found.
- The verdict is short on purpose: failing tests with their assertion and location, exact counts. Read a full log with verify_logs only when the verdict is not enough.
- Checks come from horde.json ("verify.checks") or are detected from package.json, pyproject.toml, Cargo.toml, go.mod or a Makefile; verify_detect shows which.
- related (gate, with base) or related_to (run) runs only the tests that cover the changed files, when every change is covered and the runner takes paths; the verdict says which.
- An unchanged tree is not re-run: the cached verdict comes back instantly (pass fresh: true to force a run).`

const server = new McpServer({ name: "verify", version: VERSION }, { instructions: INSTRUCTIONS })

const tool = <S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  run: (args: z.infer<z.ZodObject<S>>, extra: Extra) => Promise<string>,
  annotations: { readOnlyHint?: boolean } = {},
) => {
  server.registerTool(name, { description, inputSchema: shape, annotations: { openWorldHint: false, ...annotations } }, (async (
    args: z.infer<z.ZodObject<S>>,
    extra: Extra,
  ) => {
    try {
      return ok(await run(args, extra))
    } catch (err) {
      return fail(err)
    }
  }) as never)
}

const directory = z.string().optional().describe("Project directory (default: the server's directory). Relative paths resolve against it.")
const budget = z.number().int().min(300).max(50_000).optional().describe("Maximum characters of output (default 1500).")

tool(
  "verify_detect",
  "Show the checks verify would run in a directory and where each comes from (horde.json or a manifest), plus the audit settings.",
  { directory },
  async (a) => {
    const d = dir(a.directory)
    const settings = loadSettings(d)
    const checks = await detectChecks(d, settings)
    const lines = checks.length
      ? checks.map((c) => `${c.name} (${c.kind}): ${c.command}${c.cwd !== d ? `  [in ${path.relative(d, c.cwd) || "."}]` : ""}  ← ${c.source}`)
      : ["no checks found: add verify.checks to horde.json"]
    lines.push(
      `audit blocks on: ${settings.audit.block.join(", ") || "nothing"}; warns on: ${settings.audit.warn.join(", ") || "nothing"}${settings.audit.allowed.length ? `; allowed: ${settings.audit.allowed.join(", ")}` : ""}`,
      `timeout per check: ${settings.timeoutMs / 1000}s${settings.configFile ? ` (from ${settings.configFile})` : ""}`,
    )
    return lines.join("\n")
  },
  { readOnlyHint: true },
)

tool(
  "verify_gate",
  "Judge the work in a directory: run its checks and (with base) audit the diff from base to the working tree. Returns PASS or FAIL with the blocking failures and findings, within a character budget.",
  {
    directory,
    base: z.string().optional().describe("Commit or ref the work started from (e.g. the branch point). Without it, only the checks run."),
    checks: z.array(z.string()).optional().describe("Run only these checks (names from verify_detect)."),
    allowed: z
      .array(z.string())
      .optional()
      .describe(
        'Scope: globs (repo-relative) every changed file must match, e.g. ["src/auth/**", "test/auth/**"]; narrows horde.json\'s verify.audit.allowed.',
      ),
    audit: z.boolean().optional().describe("Set false to skip the audit even with a base."),
    fresh: z.boolean().optional().describe("Run again even if this exact tree was already judged."),
    related: z
      .boolean()
      .optional()
      .describe("With base: run only the tests related to the changed files when that is safe (the full suite otherwise); other checks run as usual."),
    budget_chars: budget,
  },
  async (a, extra) => {
    const v = await gate(dir(a.directory), {
      base: a.base,
      checks: a.checks,
      allowed: a.allowed,
      audit: a.audit,
      fresh: a.fresh,
      related: a.related,
      budgetChars: a.budget_chars,
      signal: extra.signal,
      onProgress: progress(extra),
      stateDir: STATE_DIR,
    })
    return v.text
  },
)

tool(
  "verify_run",
  "Run checks without auditing (e.g. after integrating several branches). Same compact output as verify_gate.",
  {
    directory,
    checks: z.array(z.string()).optional(),
    related_to: z
      .array(z.string())
      .optional()
      .describe("Changed files (repository-relative): run only the tests related to them when that is safe, the full suite otherwise."),
    fresh: z.boolean().optional(),
    budget_chars: budget,
  },
  async (a, extra) => {
    const v = await gate(dir(a.directory), {
      checks: a.checks,
      relatedTo: a.related_to,
      audit: false,
      fresh: a.fresh,
      budgetChars: a.budget_chars,
      signal: extra.signal,
      onProgress: progress(extra),
      stateDir: STATE_DIR,
    })
    return v.text
  },
)

tool(
  "verify_audit",
  "Audit the diff from base to the working tree without running checks: scope, test tampering, suppressions, dependencies, secrets, binaries, merge commits. One line per finding.",
  {
    directory,
    base: z.string().describe("Commit or ref the work started from."),
    allowed: z.array(z.string()).optional().describe("Scope globs (repo-relative); with horde.json's verify.audit.allowed, a file must match both."),
  },
  async (a) => {
    const d = dir(a.directory)
    // The rules as they were at base, like verify_gate: the work under audit cannot change them.
    const settings = await loadSettingsAt(d, await diffBase(await git(d, "rev-parse", "--show-toplevel"), a.base))
    const r = await audit(d, {
      base: a.base,
      allowed: settings.audit.allowed,
      scopes: [a.allowed ?? []],
      block: settings.audit.block,
      warn: settings.audit.warn,
      ruleScripts: checkScripts(await detectChecks(d, settings)),
      generated: settings.audit.generated,
    })
    const head = `${r.files.length} file${r.files.length === 1 ? "" : "s"} changed, ${r.commits} commit${r.commits === 1 ? "" : "s"} since ${r.base.slice(0, 8)}`
    if (!r.findings.length) return `${head}; no findings.`
    return [
      head,
      ...r.findings.map((f) => `${f.severity === "block" ? "✗" : "!"} ${f.category}: ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""} ` : ""}${f.text}`),
    ].join("\n")
  },
  { readOnlyHint: true },
)

tool(
  "verify_logs",
  "The full output of a check's latest run in a directory (the end of it when long). Use when a verdict's excerpt is not enough.",
  {
    directory,
    check: z.string().describe("Check name, as shown in the verdict."),
    max_chars: z.number().int().min(500).max(200_000).optional().describe("Characters to return from the end of the log (default 6000)."),
  },
  async (a) => {
    const file = logFileFor(logDirFor(path.join(STATE_DIR, "logs"), dir(a.directory)), a.check)
    if (!fs.existsSync(file)) throw new Error(`no log for "${a.check}" in ${dir(a.directory)} yet; run verify_gate or verify_run first`)
    return truncateHead(fs.readFileSync(file, "utf8"), a.max_chars ?? 6000)
  },
  { readOnlyHint: true },
)

process.stdin.on("close", () => process.exit(0))
// Grammars for code context (briefs, related tests); without them line patterns answer.
await loadSyntax()
await server.connect(new StdioServerTransport())
