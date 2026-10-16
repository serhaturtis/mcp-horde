# @mcp-horde/opencode

An MCP server that gives any harness (Claude Code, Codex, Cursor, OpenCode itself, …) subagents powered by [OpenCode](https://opencode.ai). Each agent can run any model OpenCode supports: DeepSeek, Kimi, GLM, Qwen, GPT, Claude, local models. The calling model picks the model and effort level per agent at runtime. Agents run in parallel, report back when they finish, and can be steered, paused, resumed and stopped while they work.

It is built on OpenCode's **v2 server API** (`/v2/session/*`, through `@opencode-ai/sdk/v2`).

## What the calling agent can do

| Capability | Tool |
| --- | --- |
| Discover models, effort variants and agent profiles | `opencode_models`, `opencode_agents` |
| Spawn an agent with its own model, effort (`variant`), profile, instructions, directory, limits and permission policy | `opencode_spawn` |
| Give an agent a custom profile (tool allow/deny list, step cap) | `opencode_spawn` `profile` |
| Run agents in parallel without collisions, each in its own git worktree and branch | `opencode_spawn` `isolation: "worktree"` |
| Get notified when agents finish | `opencode_wait` (returns each result once), or channel push (below) |
| See live what an agent is doing (current tool, streaming text, retries, cost) | `opencode_status` |
| Interact while it runs: `steer` (next step) or `queue` (after the turn). Can switch model, effort, profile, policies or limits | `opencode_message` |
| Stop immediately, or pause after the current step (tools are never killed mid-run) | `opencode_interrupt` |
| Resume an interrupted or failed agent | `opencode_resume` |
| Answer permission prompts and questions | `opencode_respond`, or the human answers them in a dialog |
| Review and merge an isolated agent's work | `opencode_worktree` (`diff`, `commit`, `merge`) |
| Read transcripts (also as MCP resources: `opencode://agents/{id}/transcript`) | `opencode_output` |
| Clean up | `opencode_dispose` |
| Watch agents live in the OpenCode TUI | `opencode_server info` prints the `opencode attach` command |

Agents are OpenCode sessions. You can address them by `name` or by `ses_…` id.

### Agent states

| State | Meaning |
| --- | --- |
| `running` | Working. This includes waiting for the human to answer a dialog. |
| `needs_input` | Blocked on a permission request (`per_…`) or a question (`que_…`) that is for the calling model. Answer it with `opencode_respond`. |
| `idle` | The turn finished. Its result comes back once through `opencode_wait`. |
| `interrupted` | Stopped by `opencode_interrupt` or by a limit; the reason is shown. Unread messages are delivered when it resumes. |
| `error` | The turn failed: a provider error, or a turn OpenCode accepted but never ran (detected after about 10 s). |

### Permissions and questions

When OpenCode needs approval (shell commands, edits outside the project, …), the agent's policy decides what happens:

- `user` (default): the **human** is asked in an MCP elicitation dialog, the way Claude Code asks about its own subagents. If the client can't show dialogs, or the dialog is dismissed, the request goes to the calling model as `needs_input`.
- `ask`: the calling model answers with `opencode_respond` (`once`, `always`, `reject`).
- `allow` / `deny`: approve or reject automatically.

Questions the agent asks follow the same idea (`user`, `ask`, `dismiss`). `dismiss` tells the agent to use its own judgment. Requests from an agent's child sessions are surfaced on the agent itself.

### Limits

Each agent can have per-turn safety limits: `max_steps`, `max_cost_usd`, `timeout_minutes`. When one is reached, the agent is interrupted and the reason is reported. The server also caps how many agents can work at once (`HORDE_OPENCODE_MAX_RUNNING`, default 8).

### Worktrees

With `isolation: "worktree"`, the agent gets a new worktree on branch `horde/<name>`, created outside the repository (under `~/.local/share/mcp-horde/worktrees`).

- **Uncommitted work:** your uncommitted and untracked changes are carried over (`include_uncommitted`, default on) as a baseline commit, so the agent sees what you see. Merges skip that baseline.
- **Dependencies:** `link` symlinks paths such as `node_modules` or `.env` from your checkout, and `setup` runs a command (e.g. `npm ci`) before the agent starts. Linked paths are never committed.
- **Commits:** the agent is told to commit on its branch.
- **Merging back:** `opencode_worktree merge` replays only the agent's own commits onto your current branch. `squash` stages them without committing. On a conflict the merge is aborted and your checkout is left unchanged.
- **Cleanup:** `opencode_dispose` keeps the worktree by default and commits leftover changes so nothing is lost. `remove` deletes the worktree but keeps the branch if it has commits; `discard` drops uncommitted changes.

### Push notifications (Claude Code channels)

With `HORDE_OPENCODE_CHANNEL=1`, the server also pushes a `<channel source="opencode">` message into the Claude Code session each time an agent settles, so Claude doesn't need to block in `opencode_wait`. Channels are a Claude Code research preview. For a custom server, start Claude Code with:

```sh
claude --dangerously-load-development-channels server:opencode
```

Requirements: claude.ai or Console auth, and on Team/Enterprise plans the org setting `channelsEnabled`. Pushes are best effort, so `opencode_wait` still returns every result once, even if a push was already delivered.

Without channels, `opencode_wait` is the way to get notified. Claude Code moves MCP calls that run longer than 2 minutes to a background task and notifies on completion. So a long `opencode_wait` (default timeout 30 min, with progress notifications that keep it alive) behaves much like a background-agent notification.

## Setup

1. Install OpenCode (`npm i -g opencode-ai@1.19.3`) and configure providers (`opencode auth login`, or a `provider` block in `opencode.json`).
2. Build: `npm install && npm run build` at the repository root.
3. Register it with your harness, for example Claude Code:

```sh
claude mcp add opencode -- node /path/to/mcp-horde/packages/opencode/dist/index.js
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "opencode": { "command": "node", "args": ["/path/to/mcp-horde/packages/opencode/dist/index.js"] }
  }
}
```

Once the package is published to npm, `"command": "npx", "args": ["-y", "@mcp-horde/opencode"]` will work too.

### Configuration (environment variables, all optional)

The model, effort, profile, directory, policies and limits are chosen by the calling model on each call. These variables only control how the server runs:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HORDE_OPENCODE_SERVER` | `shared` | `shared`: one detached `opencode serve` that outlives MCP restarts, so running agents survive them. `private`: one server per MCP process, stopped with it (even on SIGKILL). |
| `HORDE_OPENCODE_URL` | none | Attach to a server you run yourself (e.g. one whose TUI you watch). |
| `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME` | random / `opencode` | Basic auth. A password is required for non-loopback URLs unless `HORDE_OPENCODE_ALLOW_INSECURE=1`. |
| `HORDE_OPENCODE_BIN` | `opencode` | Binary used to start `opencode serve`. |
| `HORDE_OPENCODE_DIRECTORY` | current directory | Default working directory for agents. |
| `HORDE_OPENCODE_PERMISSIONS` | `user` | Default permission policy. |
| `HORDE_OPENCODE_MAX_RUNNING` | `8` | Maximum number of agents working at once (`0` = unlimited). |
| `HORDE_OPENCODE_CHANNEL` | off | Push Claude Code channel notifications. |
| `HORDE_OPENCODE_STATE_DIR` | `~/.local/state/mcp-horde/opencode` | Agent records and the shared-server record (mode 0600). |
| `HORDE_OPENCODE_WORKTREE_DIR` | `~/.local/share/mcp-horde/worktrees` | Where isolated worktrees go. |

## Example (Claude Code orchestrating DeepSeek and Kimi)

```text
opencode_models query:"deepseek"                → deepseek/deepseek-chat … effort variants: high, max
opencode_spawn  name:"api-tests" model:"deepseek/deepseek-chat" variant:"high" isolation:"worktree"
                worktree:{link:["node_modules"]} limits:{max_cost_usd:1}
                prompt:"Add integration tests for src/api/users.ts covering …"
opencode_spawn  name:"docs" model:"moonshot/kimi-k3" agent:"build" prompt:"Update docs/api.md …"
opencode_wait                                     → docs IDLE, result: "Updated docs/api.md …"
opencode_status ids:["api-tests"]                 → RUNNING, doing: bash: npm test · $0.21
opencode_message id:"api-tests" message:"Use the fixtures in test/fixtures."   (steer)
   … a dialog asks you: "api-tests" wants permission: bash npm install supertest → Allow once
opencode_wait                                     → api-tests IDLE, result: "Added 12 tests …"
opencode_worktree id:"api-tests" action:"merge"   → merged 3 commit(s) from horde/api-tests into main
opencode_dispose id:"api-tests" worktree:"remove"
```

## Known limits

These are set by OpenCode 1.19's v2 API or by MCP:

- **No native gateway models:** the v2 session runner can't run OpenCode's own gateway models (`api.type: native`, e.g. `opencode/big-pickle`). They are hidden from `opencode_models` and rejected at spawn.
- **No in-place pause:** OpenCode can't freeze a turn mid-flight. A pause ends the turn (`after_step` waits for the running tool), and resume starts a new turn with "continue".
- **Custom profiles need a fresh directory:** OpenCode loads agent files when it first opens a directory, so custom `profile`s need `isolation: "worktree"` (or a directory the server hasn't opened yet). `instructions` work everywhere.
- **Variants come from config:** effort variants exist only where the model or provider config defines them.
- **Agents can't spawn subagents yet:** the v2 runner has no subagent tool. Child sessions created other ways are handled.
- **The dashboard is the TUI:** there is no Claude-Code-style agent panel. Use `opencode_server info`, then `opencode attach`.
- **Version pinned:** tested with opencode 1.19.x; other versions trigger a warning in `opencode_status`.

## Development

```sh
npm run build
npm test            # unit tests + integration tests with a real `opencode serve` and a mock LLM
npm run test:e2e    # against a real model: HORDE_E2E_MODEL=provider/model npm run test:e2e
npm run lint        # at the repo root (Biome)
```

The integration tests drive the server over stdio the way a harness does. They cover:

- parallel agents, steering, interrupts, graceful pause, resume
- permissions and questions under every policy, including elicitation
- limits, provider errors, silent failures, attachments, child sessions
- worktrees (carry-over, link, setup, profile, diff, merge, conflicts)
- the running cap, channel pushes, resources
- restart survival, private-mode SIGKILL cleanup, attach-mode auth, adoption of outside sessions

Set `SHOW_OUTPUT=1` to print every tool call and response.
