---
name: setup
description: Set a repository up for the horde. Finds the commands that really check this project, what a fresh checkout needs and the resources checks share, then writes horde.json and proves it on a clean tree. Use when horde_do refuses because no checks are found or its checks are not committed, or when the user asks to set up or configure the horde for a repository.
---

# Setting a repository up for the horde

Every task runs in its own worktree, a fresh checkout of HEAD, and the project's checks judge its work there. `horde.json` at the repository root says what those checks are, what a new worktree needs, and what checks share. Without it, checks are guessed from package.json, pyproject.toml, Cargo.toml, go.mod or a Makefile at the root; `verify_detect` shows what is found.

## Steps

1. **Read before writing.** `verify_detect` for what is found today. Then the sources of truth, CI first: `.github/workflows` (or `.gitlab-ci.yml`, …), task runners (`Makefile`, `justfile`, `Taskfile`), manifests and their scripts, `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, dev scripts. Take the commands CI runs over ones you compose.
2. **Checks.** One per suite a worker's change can break: tests, typecheck, lint, per language or subproject (`cwd`). For each one:
   - what it needs from the environment, in `env` (settings such as `AUTH_PROVIDER=local`; never real secrets);
   - whether it needs a service (database, queue, emulator), and whether two runs at once can share it. If not, name per-task resources with `$HORDE_TASK` (`createdb app_$HORDE_TASK`), or serialise the checks that share it with the same `"exclusive"` name;
   - how heavy it is. `"slots"` caps how many runs overlap across all tasks; a suite that takes minutes, or needs the dev stack running, gets `"when": "land"` (the tests related to a change run during a task's rounds, every check before landing).
3. **Worktree setup.** What a fresh checkout needs before the checks can run: code generation, installs the linked dependency directories do not cover. That goes in `workers.setup`. Directories git ignores, such as `node_modules` and `.venv`, are linked from your checkout, so try the checks without an install first.
4. **House rules.** Short, rule-like files workers should read in full go in `workers.brief` (each capped at 300 lines). `CLAUDE.md`, `AGENTS.md` and `CONTRIBUTING.md` are included anyway.
5. **Models.** Add `tiers` only when the user names models for this repository. Their defaults for every repository live in `~/.config/mcp-horde/horde.json`.
6. **Prove it.** `verify_gate` with `fresh: true` on the clean tree. A check that fails here fails every task: fix the command, or tell the user which check is broken on their branch. Never drop or loosen a check to get a pass without saying so.
7. **Commit it.** Workers start from HEAD and their gates read HEAD's `horde.json`, so an uncommitted one changes nothing. Show the user the file and commit it once they agree.
8. **Offer the opt-in line.** If the user wants delegation by default here, offer to add this to the repository's `CLAUDE.md`: "Hand changes that touch several files, or several independent pieces, to the horde (`horde_do`), and review what comes back." It is their instruction to give, so ask.

## horde.json

```json
{
  "tiers": ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"],
  "workers": { "setup": "buf generate && npm ci --prefix web", "brief": ["docs/lane_brief.md"] },
  "verify": {
    "checks": {
      "go": { "command": "go test -race ./...", "cwd": "api", "env": { "AUTH_PROVIDER": "local" }, "slots": 2 },
      "web": { "command": "npm test", "cwd": "web" },
      "pg": { "command": "uv run pytest -n 8 tests/pg", "when": "land", "exclusive": "dev-stack" }
    }
  }
}
```

- **Checks** run in a shell from the repository root (or `cwd`), with `env` added, so a plain string works too: `"test": "AUTH_PROVIDER=local go test ./..."`. Checks and `workers.setup` see `HORDE_TASK` and `HORDE_WORKTREE` (the task id, its checkout).
- **`slots` and `exclusive`** hold across every process and worktree of the repository; a dead holder frees its slot, and a waiting run says what it waits for.
- **`tiers`** are the worker models, cheapest first; a failing task moves up.
- **Worktrees** live in `~/.local/share/mcp-horde/worktrees` unless `HORDE_OPENCODE_WORKTREE_DIR` says otherwise.
