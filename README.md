# mcp-horde

A collection of [MCP](https://modelcontextprotocol.io) servers for agentic coding. Each server is its own package under `packages/` and can be used with any MCP-capable harness: Claude Code, OpenCode, Codex, Cursor and others.

| Package | What it does |
| --- | --- |
| [`@mcp-horde/opencode`](packages/opencode) | Subagents for any harness, powered by [OpenCode](https://opencode.ai) on any model (DeepSeek, Kimi, GLM, Qwen, GPT, local, …): parallel runs, isolated worktrees, steering, pause/resume, limits, completion notifications, and permission prompts routed to the human. |
| [`@mcp-horde/core`](packages/core) | Internal building blocks shared by the servers: atomic state files, cross-process locks, process-tree control, git helpers, `horde.json` loading, and compact rendering. |

## Design

[`docs/DESIGN.md`](docs/DESIGN.md) describes the whole horde: the servers that are planned (`verify`, `board`, `context`, a Claude Code playbook plugin), how they fit around `opencode`, what was verified against OpenCode 1.19, and the build order.

## Development

```sh
npm install          # installs every workspace
npm run build        # builds every package
npm run typecheck
npm run lint         # Biome
npm test
```

Requirements: Node.js 20 or newer.

### Adding a server

1. Create `packages/<name>/` with its own `package.json` (name `@mcp-horde/<name>`, a `bin` entry, and `build`/`typecheck`/`test` scripts) and a `tsconfig.json` that extends `../../tsconfig.base.json`.
2. Add a row to the table above.
