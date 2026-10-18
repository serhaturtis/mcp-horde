---
name: horde
description: Delegate coding work to cheap, fast OpenCode workers (DeepSeek, Kimi, GLM, Qwen, local models) and stay the reviewer. Use when the user asks to parallelize work, use cheaper models, run a "horde", or split a feature into tasks for agents. Plans tasks on the board, briefs workers, gates their work mechanically, and accepts or retries from structured reports instead of transcripts.
---

# Running the horde

You plan and judge; workers do the typing. Your context is the scarce resource: read verdicts and reports, not transcripts, logs or whole diffs. Tools come from four servers: `board_*` (tasks, briefs, reports), `opencode_*` (workers), `verify_*` (checks), `context_*` (code search).

## 0. Before the first task

- `opencode_models` to see what can run. Pick tiers: tier 0 = the cheapest model that can plausibly do small, well-specified tasks; tier 1 = a stronger one; the last tier is you. If the repository has `horde.json` with `"tiers"` (`["provider/model", { "model": "provider/model", "variant": "high" }, …]`, cheapest first), task-bound spawns pick the tier's model themselves; otherwise pass `model`.
- `context_map` if you do not know the project yet: layout, entry points, test directories, instruction files. Use `context_find` / `context_symbol` / `context_file` instead of reading whole files while you plan.
- `verify_detect` in the repository: these are the checks every gate runs. If it finds none, ask the user for the test command (or add `verify.checks` to `horde.json`) before delegating; a gate without checks only audits the diff.

## 1. Plan

`board_plan` with **small** tasks (one concern, roughly a few files each):
- `goal`: what and why, in one paragraph; it becomes the core of the worker's prompt, so include what a newcomer needs (entry points, conventions, the shape of the answer).
- `acceptance`: observable criteria ("returns 429 after 5 failed logins per minute", "existing tests pass"), not activities.
- `scope`: the paths it may change (they also choose the brief's code context). Tasks that can run in parallel must not overlap; heed the plan's overlap warnings by adding a dependency or narrowing a scope.
- `deps`: what must be merged first.

## 2. Run each ready task

For each task from `board_next` (it shows each task's tier; several in parallel, within the running limit: `opencode.maxRunning` in `horde.json`, default 8):

1. `opencode_spawn { task: <id>, name, model?: <tier model, when horde.json has no tiers>, variant?, limits?: { max_cost_usd, timeout_minutes } }` (no limit unless you set one). The agent gets the board's brief (goal, done criteria, scope, code context, reporting commands), runs in its own worktree, and is gated on the task's scope. Add `prompt` for extra instructions only. Use `worktree.link: ["node_modules"]` (or the language's equivalent) and `worktree.setup` when the project needs dependencies to run its checks.
2. (Without `task`, the manual way: `board_brief { id, agent }` and pass the brief **unchanged** as the `prompt`, with `isolation: "worktree"` and `gate: { allowed: <task scope> }`.)
3. Keep going with other tasks; do not watch one worker.

## 3. Collect results

`opencode_wait` returns the next worker with news. For each:

- **`gate: ✓ PASS`** → `board_task { id }` and read the report: what changed, tests added, **unverified claims**, questions. For task-bound agents the board checks the report against the actual diff: a `⚠ claimed but not in the diff` line means the worker said it did something it did not. Accept only if the report holds up against the acceptance criteria; anything unverified that matters is yours to check (`opencode_worktree diff` for a specific file, `verify_gate`, or a follow-up message).
  Then `opencode_worktree { action: "merge" }` (in dependency order), `board_accept { id }`, `opencode_dispose { worktree: "remove" }`. The board records the attempt's cost itself. Gates run only the tests related to a worker's change (the verdict says "related tests only"); the merge runs the project's full checks in your checkout and shows the verdict, so a merge that breaks something is caught there: fix it, or `sync` and message the worker.
- **`gate: ✗ FAIL (round N/N)`** → the worker already had its tries. Read the verdict (it says what fails, where). Either `opencode_message` it once more with a precise hint, or `board_fail { id, reason, escalate: true }` (it names the next tier's model) and spawn the task again. Two failed gates on one tier means escalate, not retry.
- **`NEEDS_INPUT`** → answer with `opencode_respond`. Questions about intent are yours to answer from the plan; permission requests outside the task's scope should usually be rejected with a reason.
- **`INTERRUPTED` / `ERROR`** → read the reason; `opencode_resume` or `board_fail`.

`board_summary` shows the whole picture in one call whenever you lose track. The user can follow the same live with `horde watch` in a terminal.

A merge that conflicts with work merged before it: `opencode_worktree { action: "sync" }` on the waiting worker replays its commits onto your branch's tip (it aborts cleanly on conflicts and names the files), then `opencode_message` it to re-run its checks; the gate runs again when it finishes.

## 4. When to step in yourself

- The last tier is you: when a task fails on the strongest worker tier, do it yourself, starting from the worker's report and the failing verdict (that is usually most of the diagnosis).
- A worker drifting from the task (steering the wrong way, touching unrelated files): `opencode_message` with a one-paragraph correction; `opencode_interrupt` if it keeps going.
- Several workers rediscovering the same fact: `board_remember` it, so later briefs include it.

## Best of N (hard, well-specified tasks)

Brief the same task to 2–3 workers on cheap tiers (one `board_brief` per worker, passed as their prompts; each brief starts a new attempt and ends the previous one, so only the last worker can report: compare the others by their gate verdicts and diffs). Gates filter out the broken attempts; compare the survivors' reports and `opencode_worktree diff` outputs, merge one, discard the others. To compare long diffs without reading them yourself, `opencode_ask` a cheap model as judge with a `schema` (e.g. `{"winner": …, "why": …}`) and attach the diffs as files.

## Do not

- Read transcripts (`opencode_output`) unless a gate failed twice and the verdict does not explain why. For a long log, `opencode_ask` a cheap model to summarize it.
- Rewrite briefs from memory: use `opencode_spawn { task }` or `board_brief`, which carry the reporting commands and the attempt token.
- Merge without a passing gate, or accept a report whose unverified claims cover the acceptance criteria.
- Give workers vague goals ("improve the auth code"). Vague goals are where cheap models waste money.
