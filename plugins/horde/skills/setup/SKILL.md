---
name: setup
description: Set a repository up for the horde. Finds the commands that really check this project, what a fresh checkout needs and the resources checks share, then writes horde.json and proves it on a clean tree. Use when horde_do refuses because no checks are found or its checks are not committed, or when the user asks to set up or configure the horde for a repository.
---

# Setting a repository up for the horde

Every task runs in its own worktree, a fresh checkout of HEAD, and the project's checks judge its work there. `horde.json` at the repository root says what those checks are, what a new worktree needs, and what checks share. Without it, checks are guessed from package.json, pyproject.toml, Cargo.toml, go.mod or a Makefile at the root; `verify_detect` shows what is found.

## Steps

1. **Read before writing.** `verify_detect` for what is found today. Then the sources of truth, CI first: `.github/workflows` (or `.gitlab-ci.yml`, …), task runners (`Makefile`, `justfile`, `Taskfile`), manifests and their scripts, `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, dev scripts. Take the commands CI runs over ones you compose.
2. **Checks.** One per suite a worker's change can break: tests, typecheck, lint, per language or subproject (`cwd`). For each one:
   - whether it judges the code at all. A check whose result depends on something outside the tree (the time since a record was written, another run's results, a live service) turns every task red with something no worker can fix: leave it out, or drop it from the command with the project's own option (a gate meant for pushes belongs to the push);
   - what it needs from the environment, in `env` (settings such as `AUTH_PROVIDER=local`; never real secrets);
   - whether it needs a service (database, queue, emulator), and whether two runs at once can share it. If not, name per-task resources with `$HORDE_TASK` (`createdb app_$HORDE_TASK`), or serialise the checks that share it with the same `"exclusive"` name;
   - how it runs in a task's rounds. Every check runs each round, but a test check runs only the tests related to the change when its runner takes paths (pytest, vitest, jest, `go test`). `kind` (test, typecheck, lint, build, other) is guessed from the name; set it when the name misleads. `"when": "land"` takes a check out of the rounds entirely, related tests included, and runs it only before landing: keep it for checks that cannot run per task (they need the dev stack) or take many minutes even narrowed;
   - how many may run at once. `"slots": n` caps the runs of that one check across all tasks; checks naming the same `"exclusive"` resource run one at a time. Neither sees locks outside the horde: when the project already has a throttle script, wrap the commands in it instead, so the horde and everything else share one limit.
3. **Worktree setup.** Without `workers.setup`, dependency directories git ignores (`node_modules`, `.venv`, `venv`) are linked from your checkout, except those that point back into it: a `node_modules` holding workspace packages (with the rest of that install) and a virtualenv with an editable install, which would run your checkout's code; a task's first answer names what was left out. With `workers.setup`, which runs before every task (time it in a throwaway `git worktree`), nothing is linked unless `workers.link` lists it: a linked directory is your checkout's own, and an install in the worktree would write into it (`npm ci` empties it). So either install and generate code in `workers.setup`, or rely on links and keep installs out of it. `workers.link` can also link an untracked file such as `.env.local`.
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
- **`verify.timeoutSeconds`** is the limit per check run, 600 by default; a run also waits at most that long for a slot.
- **`tiers`** are the worker models, cheapest first; a failing task moves up.
- **Worktrees** live in `~/.local/share/mcp-horde/worktrees` unless `HORDE_OPENCODE_WORKTREE_DIR` says otherwise.
