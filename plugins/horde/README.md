# horde (Claude Code plugin)

Bundles the horde for Claude Code:

- **MCP servers:** `opencode` (workers), `board` (tasks, briefs, reports), `verify` (checks and audits) and `context` (code search and the code context in briefs). They ship in `servers/` as self-contained bundles and start with `node`: no npm install, no build step.
- **Skill `/horde:horde`:** the procedure Claude follows: plan small tasks with observable acceptance criteria and scopes, spawn a worker per task (briefed from the board, in a worktree, behind a gate), read the gate verdict and the worker's report (checked against its diff) instead of its transcript, then merge and accept, or fail and escalate to a stronger tier.

```text
/plugin marketplace add serhaturtis/mcp-horde
/plugin install horde@mcp-horde
```

## Configuration

Optional, in the repository's `horde.json`: the worker models per tier, cheapest first, and the running limit (default 8):

```json
{
  "tiers": [{ "model": "deepseek/deepseek-v4-flash", "variant": "high" }, "moonshot/kimi-k3"],
  "opencode": { "maxRunning": 4 },
  "verify": { "checks": { "test": "npm test" } }
}
```

To see the board from a terminal while the horde works: `node <plugin dir>/servers/cli.js status` in the repository (add a task id for one task in full).

## Requirements

- Node.js 20 or newer.
- [OpenCode](https://opencode.ai) on your `PATH` (`opencode --version`; tested with 1.19.3), with the providers you want workers to use (`opencode auth login`). Set `HORDE_OPENCODE_BIN` in the server's environment if it lives elsewhere.

## From a clone instead

The same servers, from a checkout of this repository (useful while changing them):

```sh
git clone https://github.com/serhaturtis/mcp-horde && cd mcp-horde
claude mcp add opencode -- node "$PWD/plugins/horde/servers/opencode.js"
claude mcp add board    -- node "$PWD/plugins/horde/servers/board.js"
claude mcp add verify   -- node "$PWD/plugins/horde/servers/verify.js"
claude mcp add context  -- node "$PWD/plugins/horde/servers/context.js"
```

Copy `skills/horde/SKILL.md` into your project's `.claude/skills/horde/` for the procedure.

The bundles are generated from `packages/*` by `npm run bundle` (esbuild); CI fails when they do not match the sources. Do not edit them by hand.
