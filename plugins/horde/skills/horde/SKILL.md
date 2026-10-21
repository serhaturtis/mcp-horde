---
name: horde
description: Delegate coding work to cheap, fast OpenCode workers (DeepSeek, Kimi, GLM, Qwen, local models) and stay the reviewer. Use it for any change you can state as a goal, done-criteria and files (a fix, a feature, tests, docs, a refactor, several independent pieces), and when the user asks to parallelize work, use cheaper models, run a "horde", or split a feature into tasks. Not for one- or two-line edits, questions, work you are still investigating, or results you need right away. Three calls per task (horde_do, horde_wait, horde_land): workers run in their own worktrees, their work is checked and reviewed before you see it, and landing never breaks your branch.
---

# Running the horde

You plan and judge; workers do the typing. Your context is the scarce resource: read outcomes, not transcripts or whole diffs. This holds when you are a subagent too: a worker is a cheaper model running one piece of your assignment, not another Claude agent; hand it the pieces, keep the judgement.

## The loop

1. `horde_do { goal, done, scope }` for each independent piece of work; start several at once.
2. `horde_wait` returns outcomes, and each one names the calls that fit next:
   - **READY** → `horde_land`. First look at what the outcome flags: an "unproven" criterion (send its ready-made `horde_tell` if it matters), "⚠ the report claims …" (the worker described work it did not do), files you did not expect.
   - **NEEDS YOU** → `horde_tell`: an answer, or `approve` true/false. Questions about intent are yours to answer from the plan; refuse requests that go beyond the task, with a reason.
   - **FAILED** → read why, then one precise `horde_tell` hint; `model` for the stronger tier it names; `scope` when the fix is outside the task's files; `horde_drop` when the task itself was wrong.
3. Land in dependency order. `horde_land` checks the work on top of your branch first; when it refuses, tell the worker what changed on your branch, then land again.

## Setting up a repository

The project's checks judge every task, so `horde_do` refuses in a repository where none are found; `verify_detect` shows what is found. Everything lives in `horde.json` at the repository root, versioned with the code:

```json
{
  "tiers": ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"],
  "workers": { "setup": "uv sync --frozen && npm ci --prefix web", "brief": ["docs/lane_brief.md"] },
  "verify": {
    "checks": {
      "go": { "command": "go test -race ./...", "env": { "AUTH_PROVIDER": "local" }, "slots": 2 },
      "web": { "command": "npm test", "cwd": "web" },
      "pg": { "command": "uv run pytest -n 8 tests/pg", "when": "land", "exclusive": "dev-stack" }
    }
  }
}
```

- **Checks** run in a shell from the repository root (or `cwd`), with `env` added. While a task works, only the tests related to its change run; `"when": "land"` keeps a slow check for the gate before landing. `"slots": n` caps how many runs of a check overlap across all of this repository's tasks; checks naming the same `"exclusive"` resource never overlap.
- **Checks and setup see `HORDE_TASK` and `HORDE_WORKTREE`** (the task id, its checkout): name per-task databases, ports or caches with them, e.g. `createdb app_$HORDE_TASK`.
- **`workers.setup`** prepares each new worktree; dependency directories git ignores (`node_modules`, `.venv`) are linked from your checkout instead. **`workers.brief`** lists files every worker reads in full, for house rules; `CLAUDE.md`, `AGENTS.md` and `CONTRIBUTING.md` are included anyway.
- **`tiers`** are the worker models, cheapest first; a failing task moves up. Your defaults for every repository go in `~/.config/mcp-horde/horde.json` (`tiers`, `opencode`). Worktrees live in `~/.local/share/mcp-horde/worktrees` unless `HORDE_OPENCODE_WORKTREE_DIR` says otherwise.
- Run `verify_gate` once before the first task: a check that fails on a clean tree fails every task.

## Writing a task: where cheap models waste money

- **goal**: what and why, the files or functions you already know, the conventions to follow, the shape of the result. Never "improve the auth code".
- **done**: observable criteria a reviewer can check against the diff ("returns 429 after 5 failed attempts", "a test covers the window expiring"). Passing checks is the gate's job; you need not list it.
- **scope**: the paths it may change. Tasks running at the same time must not overlap.
- **Small**: one concern, a few files. Split bigger work into tasks that land one by one; start a dependent task after its dependency has landed.

## When to step in

- Two failed rounds on one tier: escalate (`horde_tell` with the `model` the outcome names) instead of another hint.
- Failing on the strongest tier: do it yourself, starting from the FAILED outcome (usually most of the diagnosis).
- Several workers rediscovering the same fact: `board_remember` it; later briefs include it.

## More control (rarely needed)

- A plan of many tasks with dependencies: `board_plan`, then `opencode_spawn { task }` per ready task (`board_next`).
- Best of N on a hard, well-specified task: `horde_do` the same goal two or three times, land the best READY one, `horde_drop` the rest. To compare long diffs without reading them, ask a cheap model as judge with `opencode_ask` and a `schema`.
- Steering mid-step, reading a transcript, pausing: `opencode_message`, `opencode_output`, `opencode_interrupt` with the task id.
- `horde watch` in a terminal shows the board live.
