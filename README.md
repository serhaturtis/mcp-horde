# mcp-horde

A collection of [MCP](https://modelcontextprotocol.io) servers for agentic coding. Each server is its own package under `packages/` and can be used with any MCP-capable harness: Claude Code, OpenCode, Codex, Cursor and others.

| Package | What it does |
| --- | --- |
| [`@mcp-horde/opencode`](packages/opencode) | Subagents for any harness, powered by [OpenCode](https://opencode.ai) on any model (DeepSeek, Kimi, GLM, Qwen, GPT, local, …): parallel runs, isolated worktrees, steering, pause/resume, limits, completion notifications, and permission prompts routed to the human. |
| [`@mcp-horde/board`](packages/board) | A shared task board for the orchestrator and its workers: task graph with dependencies, worker briefs, structured reports, findings, project memory and file locks. Workers use it through a CLI their runtime approves automatically. |
| [`@mcp-horde/verify`](packages/verify) | Mechanical verdicts on code changes: runs a project's tests, typecheck and lint, audits the diff for scope violations, test tampering, suppressions, new dependencies and secrets, and answers PASS or FAIL in a few hundred characters. |
| [`@mcp-horde/context`](packages/context) | Precise code context instead of exploration: a project map, definitions with call sites, imports, the tests that cover a file, and budgeted context packs that `board` puts in worker briefs. TypeScript/JavaScript, Python, Go, Rust, Java, Kotlin and C#, no native dependencies. |
| [`@mcp-horde/ledger`](packages/ledger) | Learns which worker model to start each task on from the board's history: pass rates, gate rounds and cost per accepted task by model, kind of work and area, and starting-tier suggestions that skip what similar work proved to fail. |
| [`@mcp-horde/review`](packages/review) | Checks a worker's change against its task's acceptance criteria: a model answers each criterion with cited diff lines, and every citation is verified, so an unfounded "met" cannot pass. Run by `opencode`'s `review_task`. |
| [`@mcp-horde/core`](packages/core) | Internal building blocks shared by the servers: atomic state files, cross-process locks, process-tree control, git helpers, `horde.json` loading, and compact rendering. |

## Delegating in three calls

```text
horde_do   { goal, done, scope }  → t-4f1a working · deepseek/deepseek-flash · worktree horde/t-4f1a
horde_wait { ids: ["t-4f1a"] }    → t-4f1a READY · checks ✓ · review: 3 of 3 criteria met · changed 3 files (+86 −2) · $0.03
horde_land { id: "t-4f1a" }       → landed t-4f1a on main: 2 commits · checks ✓ on main's tip before updating it
```

A worker model gets its own worktree, the project's dependencies and code context; when it finishes, the project's checks run and a reviewer judges each `done` criterion against the diff, and failures go back to the worker. Landing re-runs the checks on top of your branch first, so it never breaks it. `horde_tell` answers a worker's question or permission request, asks for changes, switches its model or widens its scope; `horde_drop` gives up on a task. Every answer names the calls that make sense next. See [`packages/opencode`](packages/opencode#the-simple-path) and the design in [`docs/DESIGN.md`](docs/DESIGN.md) §4.9.

## Claude Code plugin

[`plugins/horde`](plugins/horde) bundles the servers with the orchestration skill (`/horde:horde`), the judgement calls for delegating well (writing goals, splitting work, escalating):

To have it in every project, run the installer. It checks Node.js and OpenCode, adds the marketplace, installs the plugin at user scope, and is safe to run again:

```sh
./install.sh                                          # from a clone; Claude Code reads the plugin in place, so git pull updates it
./install.sh --default-model deepseek/deepseek-flash  # also make that the default worker model in every repository
curl -fsSL https://raw.githubusercontent.com/serhaturtis/mcp-horde/master/install.sh | bash -s -- --github   # without a clone
claude plugin marketplace update mcp-horde && claude plugin update horde@mcp-horde                               # update an install made without a clone, then restart Claude Code
```

Or from inside Claude Code: `/plugin marketplace add serhaturtis/mcp-horde`, then `/plugin install horde@mcp-horde`.

The plugin carries its servers as self-contained bundles (`plugins/horde/servers/`), so installing it is all it takes: no npm install, no build. It needs Node.js 20+ and [OpenCode](https://opencode.ai) on your `PATH`. The packages are not published to npm; see [`plugins/horde/README.md`](plugins/horde/README.md).

Outcomes arrive when you ask for them: `horde_do` returns as soon as a worker starts, and a `horde_wait` that takes longer than two minutes moves to the background in Claude Code and comes back as a task notification while you keep working. If the agent stops, or you send the next prompt, before it has read them, the plugin's hooks name the finished tasks, with a ready `horde_wait` call, and the ids still working. Push delivery is opt-in: set `HORDE_OPENCODE_CHANNEL=1` and start Claude Code with `claude --dangerously-load-development-channels plugin:horde@mcp-horde` to get a `<channel>` message when a worker settles (channels are a research preview, interactive sessions only, with a warning at each start).

## Design

[`docs/DESIGN.md`](docs/DESIGN.md) describes the whole horde: how the servers fit around `opencode`, what was verified against OpenCode 2.1, what is still planned, and the build order.

[`docs/research/`](docs/research/README.md) is the reference for further MCP work: how Claude Code and other hosts put tools, server instructions, skills and hooks in front of a model, what the MCP specification says as of 2026-07-28, what vendors and papers have measured about tool selection and delegation, and what that means for the horde. Every claim carries its source.

## Development

```sh
npm install          # installs every workspace
npm run build        # builds every package
npm run typecheck
npm run lint         # Biome
npm test
./ci.sh              # all of the above plus the bundle check (--install: from a clean install first)
                     # (--live: real-model e2e run, --latest: against OpenCode's latest release)
```

Requirements: Node.js 20 or newer, and Git 2.34 or newer (worktree sync replays every commit). After changing a server, `npm run bundle` regenerates the plugin's bundles (`./ci.sh` checks they match the sources).

## License

[MIT](LICENSE)

### Adding a server

1. Create `packages/<name>/` with its own `package.json` (name `@mcp-horde/<name>`, a `bin` entry, and `build`/`typecheck`/`test` scripts) and a `tsconfig.json` that extends `../../tsconfig.base.json`.
2. Add a row to the table above.
