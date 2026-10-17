# horde (Claude Code plugin)

Bundles the horde for Claude Code:

- **MCP servers:** `opencode` (workers), `board` (tasks, briefs, reports) and `verify` (checks and audits), started with `npx`.
- **Skill `/horde:horde`:** the procedure Claude follows: plan small tasks with observable acceptance criteria and scopes, brief each worker from the board, spawn it in a worktree with a gate, read the gate verdict and the worker's report instead of its transcript, then merge and accept, or fail and escalate to a stronger tier.

```text
/plugin install horde --marketplace serhaturtis/mcp-horde
```

## Before the packages are on npm

The plugin's servers run with `npx -y @mcp-horde/<name>`, which needs the packages to be published (milestone M5 in [`docs/DESIGN.md`](../../docs/DESIGN.md)). With a local checkout, build it and register the servers yourself; the skill works the same:

```sh
git clone https://github.com/serhaturtis/mcp-horde && cd mcp-horde && npm install && npm run build
claude mcp add opencode -- node "$PWD/packages/opencode/dist/index.js"
claude mcp add board    -- node "$PWD/packages/board/dist/index.js"
claude mcp add verify   -- node "$PWD/packages/verify/dist/index.js"
```

Then install the plugin for the skill (its own `npx` servers will fail to start until publishing; disable them with `/mcp` if they get in the way), or copy `skills/horde/SKILL.md` into your project's `.claude/skills/horde/`.
