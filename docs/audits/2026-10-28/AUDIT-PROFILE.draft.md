# AUDIT-PROFILE — mcp-horde (drafted by the 2026-10-28 audit; not yet confirmed by the owner)

## Topology
- **Services:** five MCP servers over stdio, started per Claude Code session from plugins/horde/.mcp.json: opencode (orchestration, worktrees, gate, landing), board (task graph, worker reports via a CLI), verify (checks + diff audit), context (code context, tree-sitter), ledger (model/tier statistics). Bundled as plugins/horde/servers/*.js from packages/*.
- **Infra deps:** one shared `opencode serve` backend on 127.0.0.1 (basic auth; password in ~/.local/state/mcp-horde/opencode/server.json), git, Node 20+, the project's own toolchains in worktrees.
- **External deps:** model providers through OpenCode's own config (DeepSeek in this installation); Claude Code as the MCP client and hook runner; GitHub for the plugin marketplace.

## Commands
- **Boot:** Claude Code starts the servers; by hand: `node plugins/horde/servers/opencode.js` with HORDE_OPENCODE_DIRECTORY=<repo> (private backend: HORDE_OPENCODE_SERVER=private).
- **Tear down (SAFE):** close the MCP client; a private backend stops with its server. The shared backend outlives sessions.
- **Test suites:** `npm test` (all workspaces, test files listed per package.json), `./ci.sh` (lint, typecheck, bundle check, mock check, build, tests), `./ci.sh --live` (real-model e2e, costs cents).
- **Lints/gates:** `./ci.sh`. No hosted CI.

## The user journey
1. Install: `./install.sh` from a clone, or the curl|bash --github line; restart Claude Code.
2. In a repository: /horde:setup or a committed horde.json (or detected checks).
3. horde_do {goal, done, scope} → horde_wait → READY → horde_land; FAILED → horde_tell/horde_drop; horde_investigate → REPORT.
4. Value: the change is on the branch, checked and reviewed, for cents.
5. Update: git pull (clone) or claude plugin marketplace update + plugin update (GitHub).

## Canonical truth
1. packages/*/src (the bundles are generated from them)
2. docs/DESIGN.md (design + verified facts; "open questions" are claims)
3. README.md, plugins/horde/README.md, skills

## Reporting convention
- Audit reports: docs/audits/<YYYY-MM-DD>/ (this audit: written to the scratchpad first; committed only on request)

## Safety rails
- Never touch ~/.local/state/mcp-horde or ~/.local/share/mcp-horde (live sessions in digicorp, loracraft, dsh-su, mcp-horde); never kill the shared backend or any servers/*.js process; never print server.json's password or any board token.
- Live probes use isolated HORDE_* state dirs under the scratchpad and HORDE_OPENCODE_SERVER=private.

## Known waivers
- none recorded
