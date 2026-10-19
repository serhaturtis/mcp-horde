# @mcp-horde/ledger

Learns which worker model to start a task on, from what the board already records about every attempt: the task's kind of work and scope, the model that worked it, its gate rounds, its cost, and whether it was accepted or failed. Read-only over the boards, except when you ask it to apply its tier suggestions.

| Tool | What it does |
| --- | --- |
| `ledger_suggest` | The tier a task should start on: the cheapest one that similar work has not shown to fail, with the evidence. For the board's untried open tasks (default), given ids, or a draft not planned yet. `apply: true` raises the tier of untried tasks to the suggestion; it never lowers a tier. |
| `ledger_stats` | Accepted/attempts, mean gate rounds and cost per accepted task, grouped by model (default), tier, kind of work, area or repository; optionally over every repository and a recent window. Flags a model whose last 10 attempts pass clearly less often than its history (a provider update, a harder area). |

```text
ledger_suggest apply:true
  t-3fa2 "Refactor the scheduler": tier 1 (moonshot/kimi-k3) → set: similar refactor work in src/core failed on
  tier 0 (deepseek/deepseek-v4-flash): 0 of 3 similar attempts passed; on tier 1 (moonshot/kimi-k3) 3 of 3 similar attempts passed
  t-9c01 "Add tests for the parser": tier 0 stands (no evidence against the cheaper tiers)

ledger_stats
  By model, myapp:
  deepseek/deepseek-v4-flash: 14/17 accepted (82%) · 1.3 gate rounds · $0.04 per accepted
  moonshot/kimi-k3: 5/5 accepted (100%) · 1.0 gate rounds · $0.31 per accepted
```

## How it decides

- **What counts:** accepted and failed attempts. Abandoned ones say nothing about the model. The model is recorded by `@mcp-horde/opencode` for task-bound spawns (`opencode_spawn { task }`). Attempts without a recorded model count for the tier they ran on.
- **Similar work:** the same area of the same repository (scope directories, two levels deep) counts most, then the same kind of work. Kinds are test, fix, refactor, docs, build and feature, read from the task's title or goal. Other repositories' history counts by kind only, at half weight, which helps a new repository start well.
- **The rule:** cheap first, escalate on evidence. A tier is skipped only when similar work passed on it less than 40% of the time, with at least two (weighted) similar attempts behind that. Without such evidence the default, tier 0, stands. When every tier failed similar work, the suggestion is the orchestrator itself (the tier past the list), with a hint to split the task.
- **Tiers move:** history is matched to today's `horde.json` `tiers` by model, so reordering or replacing tiers keeps old attempts meaningful.

## Setup

Part of the `horde` Claude Code plugin. From a clone:

```sh
claude mcp add ledger -- node /path/to/mcp-horde/plugins/horde/servers/ledger.js
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `HORDE_LEDGER_DIRECTORY` | `HORDE_BOARD_DIRECTORY`, else the current directory | Repository whose board the tools use (each tool also takes `directory`). |
| `HORDE_BOARD_STATE_DIR` | `~/.local/state/mcp-horde/board` | Where the boards are (the same setting the board server uses). |
