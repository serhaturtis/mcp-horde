---
name: horde
description: Delegate coding work to cheap, fast OpenCode workers (DeepSeek, Kimi, GLM, Qwen, local models) and stay the reviewer. Use it by default whenever you are about to write a self-contained code change yourself (a bug fix, a feature slice, tests, a refactor, docs), and when the user asks to parallelize work, use cheaper models, run a "horde", or split a feature into tasks; not for one-line edits or results you need right now. Three calls per task (horde_do, horde_wait, horde_land): workers run in their own worktrees, their work is checked and reviewed before you see it, and landing never breaks your branch.
---

# Running the horde

You plan and judge; workers do the typing. Your context is the scarce resource: read outcomes, not transcripts or whole diffs.

## The loop

1. `horde_do { goal, done, scope }` for each independent piece of work; start several at once.
2. `horde_wait` returns outcomes, and each one names the calls that fit next:
   - **READY** → `horde_land`. First look at what the outcome flags: an "unproven" criterion (send its ready-made `horde_tell` if it matters), "⚠ the report claims …" (the worker described work it did not do), files you did not expect.
   - **NEEDS YOU** → `horde_tell`: an answer, or `approve` true/false. Questions about intent are yours to answer from the plan; refuse requests that go beyond the task, with a reason.
   - **FAILED** → read why, then one precise `horde_tell` hint; `model` for the stronger tier it names; `scope` when the fix is outside the task's files; `horde_drop` when the task itself was wrong.
3. Land in dependency order. `horde_land` checks the work on top of your branch first; when it refuses, tell the worker what changed on your branch, then land again.

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
