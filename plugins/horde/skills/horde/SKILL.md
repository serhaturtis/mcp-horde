---
name: horde
description: Delegate coding work to cheap, fast OpenCode workers (DeepSeek, Kimi, GLM, Qwen, local models) and stay the reviewer. Use it for any change you can state as a goal, done-criteria and files (a fix, a feature, tests, docs, a refactor, several independent pieces), read-only investigations (an audit, a code review, a bug hunt, how some code works) through horde_investigate, and when the user asks to parallelize work, use cheaper models, run a "horde", or split a feature into tasks. Not for one- or two-line edits, quick questions, changes you are still working out, or results you need right away. Three calls per task (horde_do, horde_wait, horde_land): workers run in their own worktrees, their work is checked and reviewed before you see it, and landing never breaks your branch.
---

# Running the horde

You plan and judge; workers do the typing. Your context is the scarce resource: read outcomes, not transcripts or whole diffs. This holds when you are a subagent too: a worker is a cheaper model running one piece of your assignment, not another Claude agent; hand it the pieces, keep the judgement.

## The loop

1. `horde_do { goal, done, scope }` for each independent piece of work; start several at once.
2. `horde_wait` returns outcomes, and each one names the calls that fit next:
   - **READY** → `horde_land`. First look at what the outcome flags: an "unproven" criterion (send its ready-made `horde_tell` if it matters), "⚠ the worker's report names …" (it claims changes the diff does not have), files you did not expect. "⚠ <check> fails at … too" means that check already fails where the task started or on your branch: not the worker's doing and no reason to hold the task, but tell the user their branch is broken.
   - **NEEDS YOU** → `horde_tell`: an answer, or `approve` true/false. Questions about intent are yours to answer from the plan; refuse requests that go beyond the task, with a reason.
   - **FAILED** → read why, then one precise `horde_tell` hint; `model` for the stronger tier it names; `scope` when the fix is outside the task's files; `horde_drop` when the task itself was wrong.
3. Investigations (`horde_investigate {question, want, focus}`) come back as **REPORT**: findings ordered by severity, each citation checked against the code (a ⚠ marks one that does not hold), and the path of the full JSON report. Nothing lands; judge the findings, and re-run the ones that matter before acting on them. Use it for audits, code reviews, bug hunts and questions about how the code works, split into several investigations by area so they run in parallel.
4. Land in dependency order. `horde_land` checks the work on top of your branch first; when it refuses, tell the worker what changed on your branch, then land again. Your branch gets the worker's own commits, the ones that were checked. Workers commit through the repository's hooks; where a commit-msg hook exists, a task that left changes uncommitted is refused until the worker commits them (`horde_tell`). `message` squashes the task into one commit with that message, judged by the hook: use it when the repository wants one commit per change, and write it in the repository's style; when the hook refuses, fix the message, not the work.

## Setting up a repository

The project's checks judge every task, so `horde_do` refuses in a repository where none are found, or where they are not committed (an uncommitted `horde.json` is never carried into a task's worktree; its gates read HEAD's). The setup skill (`/horde:setup`) writes `horde.json` for a repository: the checks CI runs, what a new worktree needs, the resources checks share (database, ports, test slots). Run `verify_gate` once before the first task: a check that fails on a clean tree is flagged on every task and costs each one a second run.

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
