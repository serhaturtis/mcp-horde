# horde (Claude Code plugin)

Bundles the horde for Claude Code:

- **MCP servers:** `opencode` (workers), `board` (tasks, briefs, reports), `verify` (checks and audits), `context` (code search and the code context in briefs) and `ledger` (which model to start each task on, learned from past attempts). They ship in `servers/` as self-contained bundles and start with `node`: no npm install, no build step.
- **Delegating is three calls:** `horde_do { goal, done, scope }` starts a worker in its own worktree; `horde_wait` returns its outcome once the project's checks and a review of each `done` criterion are through (READY, NEEDS YOU or FAILED, each naming the next call); `horde_land` puts the work on your branch after checking it on top of that branch (with `message`, as one commit that your commit-msg hook has judged). `horde_tell` and `horde_drop` handle the rest. `horde_investigate { question, want, focus }` does the same for work that changes nothing (audits, reviews, bug hunts): the worker answers with findings citing file:line, the citations are checked, and `horde_wait` returns them as a REPORT.
- **Skill `/horde:horde`:** the judgement calls around those tools: how to write a goal and done-criteria a cheap model can meet, when to split work, when to escalate to a stronger tier or do it yourself.
- **Hooks** (`hooks/delegate.mjs`): at session start, and at the start of each subagent that can edit, a paragraph in the agent's context on what the horde does and what work it suits. Once per prompt, when an agent has edited four files by hand without delegating, a note next to that edit says a separate piece of the remaining work could go to a worker.
- **Evals** (`evals/`): requests that should and should not be delegated, graded on whether `horde_do` was called; see [`evals/README.md`](evals/README.md).

## What a worker can do

A worker is an OpenCode session running as you: its edit tools are confined to the task's scope, but OpenCode does not prompt for shell commands by default, so it can run anything you can, and the audit and the checks judge the result rather than preventing it. It works in its own worktree, yet it can reach your checkout and your files. Set OpenCode's `permission` rules (an `opencode.json` in the repository with `"permission": { "bash": "ask" }`) or run the horde under a sandbox when that is not acceptable.

To install it for every project, run `./install.sh` in a clone of this repository, or without one:

```sh
curl -fsSL https://raw.githubusercontent.com/serhaturtis/mcp-horde/master/install.sh | bash -s -- --github
```

It checks Node.js and OpenCode, adds the marketplace and installs the plugin at user scope; `--default-model deepseek/deepseek-flash` also writes the user-level `horde.json` below. Or from inside Claude Code: `/plugin marketplace add serhaturtis/mcp-horde`, then `/plugin install horde@mcp-horde`.

## Delegating by default

Agents with the plugin hand sizeable, describable work to the horde on their own and keep small work (see the evals). To make delegation your project's explicit default, add a line to its `CLAUDE.md`, which Claude Code treats as your own instruction rather than a plugin's:

```markdown
Hand changes that touch several files, or several independent pieces, to the horde (`horde_do`), and review what comes back.
```

## Configuration

Optional, in the repository's `horde.json`: the worker models per tier, cheapest first, the running limit (default 8), and standing house rules every worker brief includes:

```json
{
  "tiers": [{ "model": "deepseek/deepseek-v4-flash", "variant": "high" }, "moonshotai/kimi-k3"],
  "opencode": { "maxRunning": 4 },
  "verify": { "checks": { "test": "npm test" } },
  "workers": { "brief": ["docs/lane_brief.md"] }
}
```

Checks take `cwd`, `env`, `"when": "land"` (only before landing), `slots` and `exclusive`, and see `HORDE_TASK` and `HORDE_WORKTREE` when they run for a task; the setup skill (`/horde:setup`) writes `horde.json` for a repository and has a full example. `workers.brief` lists repository-relative files (house rules) that every worker brief includes in full under `## House rules (<path>)`, right after its scope; each file is capped at 300 lines, and a listed file that does not exist is named in the brief rather than failing it. `workers.land` is a command run while a task lands, after its commits are rebased onto your branch and before the checks, for files that must be regenerated on the new base; its changes are committed on top and land with the task.

To use the same worker defaults in every repository, put `tiers` and `opencode` in `$XDG_CONFIG_HOME/mcp-horde/horde.json` (`~/.config/mcp-horde/horde.json` when `XDG_CONFIG_HOME` is unset). They apply only where the repository's `horde.json` does not set that key, and every other key is ignored. This makes `deepseek/deepseek-flash` the default worker model everywhere:

```json
{ "tiers": ["deepseek/deepseek-flash"] }
```

To follow the horde from a terminal: `node <plugin dir>/servers/cli.js watch` in the repository shows the board live (tasks, their agents' state and gate verdicts, costs, locks, recent events); `status` prints it once (add a task id for one task in full).

### Environment variables

Set these in the shell before starting Claude Code; the plugin's MCP servers inherit that environment.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HORDE_OPENCODE_SERVER` | `shared` | `shared`: one detached `opencode serve` that outlives MCP restarts. `private`: one server per MCP process, stopped with it. |
| `HORDE_OPENCODE_BIN` | `opencode` | Binary used to start `opencode serve`. |
| `HORDE_OPENCODE_URL` | none | Attach to a server you run yourself instead of starting one. |
| `HORDE_OPENCODE_PERMISSIONS` | `user` | What a permission request does: `user` asks you, `ask` gives it to the calling model, `allow` and `deny` decide automatically. |
| `HORDE_OPENCODE_MAX_RUNNING` | `horde.json` `opencode.maxRunning`, else 8 | Maximum number of workers running at once (`0` = unlimited). |
| `HORDE_OPENCODE_CHANNEL` | off | Push Claude Code channel notifications when a worker settles (`1`/`true`/`yes`/`on`). |
| `HORDE_OPENCODE_DIALOG_TIMEOUT` | `600` | Seconds a permission or question dialog waits for you before it goes to the calling model. |
| `HORDE_OPENCODE_STATE_DIR` | `~/.local/state/mcp-horde/opencode` | Agent records, the shared-server record and its password file. |
| `HORDE_OPENCODE_WORKTREE_DIR` | `~/.local/share/mcp-horde/worktrees` | Where task worktrees go. |
| `HORDE_SCOPE` | on | On Linux with a systemd user manager, run the backends and every check, setup and land command in their own transient scopes (`horde-opencode-*`, `horde-check-*`); `off` disables it, and missing systemd support skips it silently. |
| `HORDE_MEMORY_HIGH` | none | `MemoryHigh=` for those scopes, e.g. `32G` (digits with an optional `K`/`M`/`G`/`T` suffix) or a percentage; unset adds no property. |
| `HORDE_BOARD_STATE_DIR` | `~/.local/state/mcp-horde/board` | Where boards (task history, findings, memory) are stored. |
| `HORDE_VERIFY_STATE_DIR` | `~/.local/state/mcp-horde/verify` | Where check logs are kept. |

systemd-oomd kills the largest cgroup when memory runs short. Without scopes the horde's backends, builds and tests share the Claude Code session's terminal scope, so their page cache can make that the victim; the scopes keep them separate, and `MemoryHigh` lets the kernel reclaim a build's page cache first.

## Requirements

- Node.js 20 or newer.
- [OpenCode](https://opencode.ai) on your `PATH` (OpenCode 2: `opencode --version`; tested with 2.1.1), with the providers you want workers to use (`opencode auth login`). Set `HORDE_OPENCODE_BIN` in the server's environment if it lives elsewhere.

## Removing it

Each task cleans up after itself: landing or dropping it removes its worktree, branch, OpenCode session and check logs. A task whose server stopped midway is still listed by `opencode_status`, and `horde_drop` removes it. What stays is small and kept on purpose: the task history the ledger learns from.

**`/horde:remove`** in Claude Code takes the horde out of a repository, the reverse of `/horde:setup`: it shows what will go, asks once, then removes the horde's state for that repository and, with your go-ahead, `horde.json` and the delegation line in `CLAUDE.md`. To start a repository over, run `/horde:remove`, then `/horde:setup`.

Underneath it is the CLI, which you can also run yourself. To remove everything the horde keeps for one repository — its worktrees, its `horde/*` branches (listed with the commits they hold that are not on the current branch), its board (task history, findings and memory), and its check logs and locks — run this from a checkout or worktree of it:

```sh
node <plugin dir>/servers/cli.js remove [--repo <dir>] [--yes]
```

Without `--yes` it prints what would be removed and changes nothing. With `--yes` it removes those and nothing else: `horde.json`, other tracked files and your uncommitted changes stay, as do OpenCode's own session history and user-level config. `horde.json` is yours: `git rm horde.json` to drop the configuration.

To remove the horde entirely:

```sh
claude plugin uninstall horde@mcp-horde --scope user
claude plugin marketplace remove mcp-horde
rm -rf ~/.local/state/mcp-horde ~/.local/share/mcp-horde ~/.config/mcp-horde   # history and logs, worktrees, your defaults
```

The last three live under `$XDG_STATE_HOME`, `$XDG_DATA_HOME` and `$XDG_CONFIG_HOME` when those are set.

## From a clone instead

The same servers, from a checkout of this repository (useful while changing them):

```sh
git clone https://github.com/serhaturtis/mcp-horde && cd mcp-horde
claude mcp add opencode -- node "$PWD/plugins/horde/servers/opencode.js"
claude mcp add board    -- node "$PWD/plugins/horde/servers/board.js"
claude mcp add verify   -- node "$PWD/plugins/horde/servers/verify.js"
claude mcp add context  -- node "$PWD/plugins/horde/servers/context.js"
claude mcp add ledger   -- node "$PWD/plugins/horde/servers/ledger.js"
```

This path registers the five servers but installs no hooks, so none of the notes above appear in your agents' context. To load the whole plugin from the checkout instead, hooks included, start Claude Code with `claude --plugin-dir plugins/horde`.

Copy `skills/horde`, `skills/setup` and `skills/remove` into your project's `.claude/skills/` for the procedure and the repository setup.

The bundles are generated from `packages/*` by `npm run bundle` (esbuild); `./ci.sh` fails when they do not match the sources. Do not edit them by hand.
