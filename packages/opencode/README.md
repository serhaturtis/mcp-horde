# @mcp-horde/opencode

An MCP server that gives any harness (Claude Code, Codex, Cursor, OpenCode itself, …) subagents powered by [OpenCode](https://opencode.ai). Each agent can run any model OpenCode supports: DeepSeek, Kimi, GLM, Qwen, GPT, Claude, local models. The calling model picks the model and effort level per agent at runtime. Agents run in parallel, report back when they finish, and can be steered, paused, resumed and stopped while they work.

It is built on OpenCode's **v2 server API** (`/api/*`, through `@opencode-ai/sdk/v2`). The legacy API is used only for what v2 lacks (session titles and deletion, releasing a directory, the server version), from one adapter module (`src/compat.ts`); each use is best effort and goes away when v2 covers it.

## What the calling agent can do

| Capability | Tool |
| --- | --- |
| Discover models (with context size, price and effort variants) and agent profiles | `opencode_models`, `opencode_agents` |
| Spawn an agent with its own model, effort (`variant`), profile, instructions, directory, limits and permission policy | `opencode_spawn` |
| Give an agent a custom profile (tool allow/deny list, step cap) | `opencode_spawn` `profile` |
| Run agents in parallel without collisions, each in its own git worktree and branch | `opencode_spawn` `isolation: "worktree"` |
| Check an agent's work mechanically when it finishes, and send failures back to it to fix | `opencode_spawn` / `opencode_message` `gate` |
| Work a task from [`@mcp-horde/board`](../board): the board's brief as the prompt, a worktree and a gate on the task's scope, the attempt (and its worktree) recorded on the board | `opencode_spawn` `task` |
| Get notified when agents finish | `opencode_wait` (returns each result once), or channel push (below) |
| See live what an agent is doing (current tool, streaming text, retries, cost) | `opencode_status` |
| Interact while it runs: `steer` (next step) or `queue` (after the turn). Can switch model, effort, profile, policies or limits | `opencode_message` |
| Stop immediately (running tools are killed), or pause after the current step (`when: "after_step"` lets running tools finish) | `opencode_interrupt` |
| Resume an interrupted or failed agent (refused while it is still running) | `opencode_resume` |
| Answer permission prompts and questions | `opencode_respond`, or the human answers them in a dialog |
| Review and merge an isolated agent's work | `opencode_worktree` (`diff`, `commit`, `merge`) |
| Undo a bad turn: OpenCode restores the files it changed and drops it from the conversation | `opencode_revert` (`turns`, or `to: <message id>`) |
| See how full an agent's context window is (`ctx 71k/128k (55%)` in every status) and compact it | `opencode_status`, `opencode_compact` (needs an OpenCode with v2 compaction; 1.19 answers "not available yet") |
| See and remove the rules OpenCode saved from "always" answers | `opencode_permissions` |
| Read transcripts (also as MCP resources: `opencode://agents/{id}/transcript`) | `opencode_output` |
| Clean up | `opencode_dispose` |
| Watch agents live in the OpenCode TUI | `opencode_server info` prints the `opencode attach` command (it reads the password from a file, so the password never enters the model's context) |
| Stop the shared server | `opencode_server stop` (the next call starts a fresh one) |

Agents are OpenCode sessions. You can address them by `name` or by `ses_…` id. A session started elsewhere (for example in the OpenCode TUI) is listed by `opencode_status include_untracked:true` and adopted when you pass its id; adopted sessions get the cautious `ask` policy, so this server never auto-approves a human's session. A subagent's id resolves to its root agent.

### Agent states

| State | Meaning |
| --- | --- |
| `running` | Working. This includes waiting for the human to answer a dialog. |
| `needs_input` | Blocked on a permission request (`per_…`) or a question (`que_…`) that is for the calling model. Answer it with `opencode_respond`. |
| `idle` | The turn finished. Its result comes back once through `opencode_wait`. |
| `interrupted` | Stopped by `opencode_interrupt` or by a limit; the reason is shown. Unread messages are delivered when it resumes. |
| `error` | The turn failed: a provider error, or a turn OpenCode accepted but never ran (detected after 30 s, or 60 s for an agent's first turn). |

### Permissions and questions

When OpenCode needs approval (shell commands, edits outside the project, …), the agent's policy decides what happens:

- `user` (default): the **human** is asked in an MCP elicitation dialog, the way Claude Code asks about its own subagents. If the client can't show form dialogs, the dialog is dismissed, fails, or goes unanswered for `HORDE_OPENCODE_DIALOG_TIMEOUT` seconds, the request goes to the calling model as `needs_input` (and `opencode_respond` can still answer while a dialog is open).
- `ask`: the calling model answers with `opencode_respond` (`once`, `always`, `reject`).
- `allow` / `deny`: approve or reject automatically.

Questions the agent asks follow the same idea (`user`, `ask`, `dismiss`). `dismiss` tells the agent to use its own judgment. Requests from an agent's child sessions are surfaced on the agent itself.

### Gates

With `gate: true` (or settings), an agent's work is checked when it finishes a turn, using [`@mcp-horde/verify`](../verify): the project's tests, typecheck and lint (from `horde.json`, or detected from `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`), plus an audit of the agent's diff for out-of-scope edits, deleted or skipped tests, suppressions, new dependencies and secrets.

- **Failures go back to the agent first.** The compact verdict is sent to it as a new instruction ("fix these; do not skip or weaken tests"), up to `max_rounds` (default 2). Only the outcome is news: `opencode_wait` reports the agent when its gate has passed or run out of rounds, never in between.
- **What you see** is one line on a pass (`gate: ✓ PASS (round 2/2) · 3.1s`), or the final verdict on a failure: failing tests with their assertion and location, blocking audit findings, exact counts.
- **The audit** covers the agent's own work: in a worktree, everything after the carried-over baseline (or after the last merge). Outside a worktree the audit is off by default, because the human's edits in the same directory would be audited too; the checks still run. `allowed` restricts the scope (`["src/auth/**", "test/auth/**"]`).
- **Related tests only,** by default: test checks run just the tests that cover the agent's changes when every change is covered and the runner takes test paths, otherwise the full suite (the verdict says which). `gate: {related_only: false}` always runs everything. Run the full suite after merging.
- **Interplay:** a gate only runs after a clean finish (not after an interrupt or an error, which are reported as they are). A new `opencode_message` starts counting rounds again and cancels a gate in flight; `opencode_interrupt` stops it. An agent that needs input during a fix round surfaces immediately. An unchanged tree is not re-checked.

```text
opencode_spawn name:"auth" prompt:"Add rate limiting to src/auth/login.ts …" isolation:"worktree"
               gate:{allowed:["src/auth/**","test/auth/**"]}
opencode_wait  → auth IDLE · gate: ✓ PASS (round 2/2) · 4.2s
```

### Board commands

Workers briefed by [`@mcp-horde/board`](../board) report through a CLI they run with `bash`. Those exact commands are approved automatically, whatever the agent's permission policy, so reporting never waits on a human. Only a command that is this installation's board CLI with plain arguments qualifies: anything chained onto it (`;`, `&&`, pipes, redirects, `$(…)`, backticks) goes through the normal policy.

### Limits

Each agent can have per-turn safety limits: `max_steps`, `max_cost_usd`, `timeout_minutes`. When one is reached, the agent is interrupted and the reason is reported. Costs include the agent's subagents. OpenCode 1.19's v2 runner reports every step as free, so costs are computed from the model's pricing in the catalog (a model without pricing costs $0 and `max_cost_usd` cannot trip). Setting limits with `opencode_message` changes only the limits you pass.

Limits are enforced by an MCP server process. With a shared server, an agent keeps working after every MCP process exits, and its limits are only checked again when one starts (it catches up at startup).

The server also caps how many agents can work at once (`HORDE_OPENCODE_MAX_RUNNING`, default 8).

### Several MCP sessions

With the shared server, several harness sessions (each with its own MCP process) see the same OpenCode server. Each agent belongs to the MCP process that spawned or adopted it: only that process answers its dialogs, applies its policies and limits, and reports its results. Another session can't drive it while the owner is alive; when the owner exits, the next process that touches the agent takes it over.

### Worktrees

With `isolation: "worktree"`, the agent gets a new worktree on branch `horde/<name>`, created outside the repository (under `~/.local/share/mcp-horde/worktrees`).

- **Uncommitted work:** your uncommitted and untracked changes are carried over (`include_uncommitted`, default on) as a baseline commit, so the agent sees what you see. Merges skip that baseline.
- **Dependencies:** `link` symlinks untracked paths such as `node_modules` or `.env` from your checkout (relative paths only; on Windows, files that can't be symlinked are copied), and `setup` runs a command (e.g. `npm ci`) before the agent starts. Linked paths are never committed. `submodules: true` initializes submodules in the worktree. Long setups report progress and can be cancelled.
- **Commits:** the agent is told to commit on its branch.
- **Merging back:** `opencode_worktree merge` replays only the agent's own commits onto your current branch; a later merge only brings commits made since. `squash` stages them without committing (it needs a clean index). The merge is refused on a detached HEAD, while a merge, rebase or cherry-pick is in progress, or when the agent made merge commits. On a conflict the merge is aborted and your checkout is left unchanged.
- **Cleanup:** `opencode_dispose` keeps the worktree by default and commits leftover changes so nothing is lost. `remove` deletes the worktree but keeps the branch if it has commits; `discard` drops uncommitted changes.

### Push notifications (Claude Code channels)

With `HORDE_OPENCODE_CHANNEL=1`, the server also pushes a `<channel source="opencode">` message into the Claude Code session each time an agent settles, so Claude doesn't need to block in `opencode_wait`. Channels are a Claude Code research preview. For a custom server, start Claude Code with:

```sh
claude --dangerously-load-development-channels server:opencode
```

Requirements: claude.ai or Console auth, and on Team/Enterprise plans the org setting `channelsEnabled`. Pushes are best effort, so `opencode_wait` still returns every result once, even if a push was already delivered.

Without channels, `opencode_wait` is the way to get notified. Claude Code moves MCP calls that run longer than 2 minutes to a background task and notifies on completion. So a long `opencode_wait` (default timeout 30 min in Claude Code, with progress notifications that keep it alive) behaves much like a background-agent notification. Other clients get a 50 s default, below the usual 60 s client timeout. When a wait times out, it still returns whatever news it has.

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
| `HORDE_OPENCODE_DIRECTORY` | current directory | Default working directory for agents; relative `directory` arguments resolve against it. |
| `HORDE_OPENCODE_PERMISSIONS` | `user` | Default permission policy. |
| `HORDE_OPENCODE_MAX_RUNNING` | `8` | Maximum number of agents working at once (`0` = unlimited). |
| `HORDE_OPENCODE_CHANNEL` | off | Push Claude Code channel notifications (`1`/`true`/`yes`/`on`, any case). |
| `HORDE_OPENCODE_DIALOG_TIMEOUT` | `600` | Seconds a permission or question dialog waits for the human before the request goes to the calling model. |
| `HORDE_OPENCODE_STATE_DIR` | `~/.local/state/mcp-horde/opencode` | One record per agent (`agents/<id>.json`), the shared-server record and its password file (all mode 0600). |
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
- **Version pinned:** tested with opencode 1.19.x; other versions trigger a warning in `opencode_status`. A shared server started by a different `opencode` binary is reused with a warning; `opencode_server stop` replaces it.
- **No step costs from OpenCode:** the v2 runner reports $0 per step, so costs are estimated from catalog pricing (see Limits).

## Development

```sh
npm run build
npm test            # unit tests, integration tests with a real `opencode serve` and a mock LLM, and a smoke test of dist/
npm run test:e2e    # against real models: HORDE_E2E_MODEL=free (OpenCode's free models, no account) or provider/model
npm run lint        # at the repo root (Biome)
```

The integration tests drive the server over stdio the way a harness does. They cover:

- parallel agents, steering, interrupts, graceful pause, resume
- permissions and questions under every policy, including elicitation
- limits, provider errors, silent failures, attachments, child sessions
- worktrees (carry-over, link, setup, profile, diff, merge, conflicts)
- gates: pass on the first try, a failure fixed by the agent from the verdict, giving up after `max_rounds`, round reset on a new message
- the running cap (including concurrent spawns), dialog timeouts, server stop and restart, channel pushes, resources
- cost and time limits, limit merging, queued delivery, spawn rollback, name reuse
- restart survival, private-mode SIGKILL cleanup, attach-mode auth, adoption of outside sessions
- the compiled package (`dist/index.js` with the private-mode supervisor)

Set `SHOW_OUTPUT=1` to print every tool call and response.
