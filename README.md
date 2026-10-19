# mcp-horde

A collection of [MCP](https://modelcontextprotocol.io) servers for agentic coding. Each server is its own package under `packages/` and can be used with any MCP-capable harness: Claude Code, OpenCode, Codex, Cursor and others.

| Package | What it does |
| --- | --- |
| [`@mcp-horde/opencode`](packages/opencode) | Subagents for any harness, powered by [OpenCode](https://opencode.ai) on any model (DeepSeek, Kimi, GLM, Qwen, GPT, local, …): parallel runs, isolated worktrees, steering, pause/resume, limits, completion notifications, and permission prompts routed to the human. |
| [`@mcp-horde/board`](packages/board) | A shared task board for the orchestrator and its workers: task graph with dependencies, worker briefs, structured reports, findings, project memory and file locks. Workers use it through a CLI their runtime approves automatically. |
| [`@mcp-horde/verify`](packages/verify) | Mechanical verdicts on code changes: runs a project's tests, typecheck and lint, audits the diff for scope violations, test tampering, suppressions, new dependencies and secrets, and answers PASS or FAIL in a few hundred characters. |
| [`@mcp-horde/context`](packages/context) | Precise code context instead of exploration: a project map, definitions with call sites, imports, the tests that cover a file, and budgeted context packs that `board` puts in worker briefs. TypeScript/JavaScript, Python, Go, Rust, Java, Kotlin and C#, no native dependencies. |
| [`@mcp-horde/ledger`](packages/ledger) | Learns which worker model to start each task on from the board's history: pass rates, gate rounds and cost per accepted task by model, kind of work and area, and starting-tier suggestions that skip what similar work proved to fail. |
| [`@mcp-horde/core`](packages/core) | Internal building blocks shared by the servers: atomic state files, cross-process locks, process-tree control, git helpers, `horde.json` loading, and compact rendering. |

## Claude Code plugin

[`plugins/horde`](plugins/horde) bundles the servers with the orchestration skill (`/horde:horde`), the procedure Claude follows to plan, brief, gate, review and merge workers' tasks:

```text
/plugin marketplace add serhaturtis/mcp-horde
/plugin install horde@mcp-horde
```

The plugin carries its servers as self-contained bundles (`plugins/horde/servers/`), so installing it is all it takes: no npm install, no build. It needs Node.js 20+ and [OpenCode](https://opencode.ai) on your `PATH`. The packages are not published to npm; see [`plugins/horde/README.md`](plugins/horde/README.md).

## Design

[`docs/DESIGN.md`](docs/DESIGN.md) describes the whole horde: how the servers fit around `opencode`, what was verified against OpenCode 1.19, what is still planned, and the build order.

## Development

```sh
npm install          # installs every workspace
npm run build        # builds every package
npm run typecheck
npm run lint         # Biome
npm test
```

Requirements: Node.js 20 or newer. After changing a server, `npm run bundle` regenerates the plugin's bundles (CI checks they match the sources).

## License

[MIT](LICENSE)

### Adding a server

1. Create `packages/<name>/` with its own `package.json` (name `@mcp-horde/<name>`, a `bin` entry, and `build`/`typecheck`/`test` scripts) and a `tsconfig.json` that extends `../../tsconfig.base.json`.
2. Add a row to the table above.
