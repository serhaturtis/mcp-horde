# Delegation evals

Does an agent hand work to the horde when that is the better path, and keep it when it is not? Each case is a request a user might type, without any mention of the horde, run in a clone of this repository at a fixed commit (7caae37). Each case has one grader: whether `horde_do` was called.

| Case | Request | Expected |
| --- | --- | --- |
| `status-json` | A `--json` flag for the board CLI's `status`, with docs and tests | delegate |
| `core-text-tests` | Tests for six untested helpers in `packages/core/src/text.ts` | delegate |
| `three-pieces` | Three unrelated pieces: a core README, an `--interval` minimum, a fuller review README | delegate |
| `servers-log` | Keep the test servers' log lines out of the real state directory (mostly investigation, a small fix) | do directly |
| `one-line` | Change `watch`'s default interval from one second to two | do directly |
| `question` | How the verify server finds the tests that cover a change | do directly |

The reasons for these choices are in [docs/research/horde-implications.md](../../../docs/research/horde-implications.md#the-target-restated).

## Running it

From the repository root:

```sh
claude plugin eval plugins/horde --runs 1 --ablation none --model claude-opus-5-5 \
  --scaffold --trust-plugin --allow-tools Bash Edit Write --max-cost-usd 2.4 --no-publish
```

- **`--runs 1 --ablation none`.** One run per case, and no run without the plugin. Without the plugin `horde_do` does not exist, so that arm would measure nothing. One run is noisy: use `--runs 3` before trusting a small difference.
- **`--max-cost-usd 2.4`.** The runner checks the ceiling before it starts each run, so the run in flight can pass it by about $0.45. A whole pass cost $1.84 on 2026-10-21 (about $0.20–0.45 per case), and 2.4 keeps a pass under $3.
- **`--scaffold`.** It runs `scaffold.sh` (each case links to it), which clones this repository into the run's empty workspace and checks out the pinned commit.
- **`--allow-tools Bash Edit Write`.** These let the agent do the work itself, so not delegating is a real option. Bash runs in Claude Code's sandbox (bubblewrap and socat on Linux).
- **The 10-turn cap.** Each case stops at 10 turns. The decision comes well before that, and most runs end with "Reached maximum number of turns", which is expected and does not affect the score.

## The mocks

`mocks/opencode/` answers the five horde tools with fixed text in the shape of the real answers: a task starts, comes back READY and lands. No worker runs. `_tools.json` carries the real tool definitions, because the descriptions are part of what is being measured.

`node scripts/eval-tools.mjs` regenerates it from the bundled server; run it after changing a description. `ci.sh` fails while it is out of date.

## What the suite does not measure

- **Server instructions.** The mocked server does not send them, so changes to `HORDE_INSTRUCTIONS` do not show here. The tool descriptions, the skill and the plugin's hooks do reach the agent.
- **Upfront loading.** The mocked tools load through tool search, despite `anthropic/alwaysLoad` in `_tools.json`. In a real session they are loaded upfront, so the eval is slightly harder than reality.
- **Other plugins and user settings.** Only this plugin loads (no ponytail, no user CLAUDE.md), and the board, verify, context and ledger servers are not started.
- **A buildable tree.** The workspace has no `node_modules`, and `npm` is not on the run's PATH. Agents that try to build or test find they cannot. That happens after the decision in every run seen so far.
- **The Agent tool.** It is not allowed, so subagents are not an alternative here.
- **Distinct tasks.** Every mocked `horde_do` answers with task `t-1`. Agents that start several tasks notice, which does not change the grade.

## Results

| Date | Texts | Runs | Score | Cost |
| --- | --- | --- | --- | --- |
| 2026-10-21 | As of ead8811 (hook, skill and descriptions of that commit) | 1 per case | 6/6: all three delegate cases called `horde_do` (three-pieces three times, in parallel), none of the direct cases did | $1.84 |
