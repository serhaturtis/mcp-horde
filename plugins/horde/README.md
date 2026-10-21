# horde (Claude Code plugin)

Bundles the horde for Claude Code:

- **MCP servers:** `opencode` (workers), `board` (tasks, briefs, reports), `verify` (checks and audits), `context` (code search and the code context in briefs) and `ledger` (which model to start each task on, learned from past attempts). They ship in `servers/` as self-contained bundles and start with `node`: no npm install, no build step.
- **Delegating is three calls:** `horde_do { goal, done, scope }` starts a worker in its own worktree; `horde_wait` returns its outcome once the project's checks and a review of each `done` criterion are through (READY, NEEDS YOU or FAILED, each naming the next call); `horde_land` puts the work on your branch after checking it on top of that branch. `horde_tell` and `horde_drop` handle the rest.
- **Skill `/horde:horde`:** the judgement calls around those tools: how to write a goal and done-criteria a cheap model can meet, when to split work, when to escalate to a stronger tier or do it yourself.
- **Hooks** (`hooks/delegate.mjs`): at session start, and at the start of each subagent that can edit, a paragraph in the agent's context on what the horde does and what work it suits. Once per prompt, when an agent has edited four files by hand without delegating, a note next to that edit says a separate piece of the remaining work could go to a worker.
- **Evals** (`evals/`): requests that should and should not be delegated, graded on whether `horde_do` was called; see [`evals/README.md`](evals/README.md).

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

Optional, in the repository's `horde.json`: the worker models per tier, cheapest first, and the running limit (default 8):

```json
{
  "tiers": [{ "model": "deepseek/deepseek-v4-flash", "variant": "high" }, "moonshot/kimi-k3"],
  "opencode": { "maxRunning": 4 },
  "verify": { "checks": { "test": "npm test" } }
}
```

To use the same worker defaults in every repository, put `tiers` and `opencode` in `$XDG_CONFIG_HOME/mcp-horde/horde.json` (`~/.config/mcp-horde/horde.json` when `XDG_CONFIG_HOME` is unset). They apply only where the repository's `horde.json` does not set that key, and every other key is ignored. This makes `deepseek/deepseek-flash` the default worker model everywhere:

```json
{ "tiers": ["deepseek/deepseek-flash"] }
```

To follow the horde from a terminal: `node <plugin dir>/servers/cli.js watch` in the repository shows the board live (tasks, their agents' state and gate verdicts, costs, locks, recent events); `status` prints it once (add a task id for one task in full).

## Requirements

- Node.js 20 or newer.
- [OpenCode](https://opencode.ai) on your `PATH` (OpenCode 2: `opencode --version`; tested with 2.1.1), with the providers you want workers to use (`opencode auth login`). Set `HORDE_OPENCODE_BIN` in the server's environment if it lives elsewhere.

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

The bundles are generated from `packages/*` by `npm run bundle` (esbuild); `./ci.sh` fails when they do not match the sources. Do not edit them by hand.
