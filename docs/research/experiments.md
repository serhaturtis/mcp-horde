# Experiments in this repository

Status: 2026-10-21, Claude Code 2.1.305, model `claude-opus-5-5` unless stated otherwise. Everything here was observed directly [checked], except where marked.

## Setup facts

- **The plugin loads from the checkout.** The `mcp-horde` marketplace is a `directory` source pointing at the repository, so `CLAUDE_PLUGIN_ROOT` is `plugins/horde` of this checkout. The running servers are `node …/mcp-horde/plugins/horde/servers/*.js`, and edits take effect after `/reload-plugins` or in a new session.
- **The cache is stale and unused.** The copy under `~/.claude/plugins/cache/mcp-horde/horde/0.1.0` dates from 5b3ca8e and is not what runs.
- **Enablement is per project.** The plugin is enabled with local scope through `.claude/settings.local.json` (`"enabledPlugins": {"horde@mcp-horde": true}`). Copying that file into a worktree enables the plugin there.
- **Headless runs load everything.** In a `claude -p` run the init event lists the plugin, its five servers as connected, and the horde tools, and the SessionStart hook output appears as `hook_response` events in `--output-format stream-json`.

## Two headless runs of one task

| | Run A | Run B |
| --- | --- | --- |
| When (UTC) | 2026-10-20 21:52–21:59 | 2026-10-20 22:11–22:19 |
| Tree | master at 7caae37 | worktree at 7caae37, same servers |
| Horde guidance | Tools loaded upfront (`alwaysLoad`), server instructions, skill | Same, plus the SessionStart hook (ead8811), confirmed delivered |
| horde calls | 0 | 0 |
| Tool calls | 40 | 40 |
| Cost | $1.04 | $1.18 |
| Duration | 6.5 min | 7.6 min |
| Result | The fix later committed as 108721c | The same fix, done again |

**The prompt.** It contains no hint about the horde:

```sh
claude -p "The test suites' servers write their start and exit lines into my real ~/.local/state/mcp-horde/servers.log. Make the tests keep those lines in a temporary directory instead." \
  --output-format stream-json --verbose --permission-mode acceptEdits \
  --allowedTools "mcp__plugin_horde_opencode" "mcp__plugin_horde_board" "mcp__plugin_horde_verify" "mcp__plugin_horde_context" \
    "Bash(npm *)" "Bash(git *)" "Bash(node *)" "Bash(ls *)" "Bash(grep *)" "Bash(cat *)" "Bash(find *)" "Bash(./ci.sh*)"
```

**The shape of the work, from run B:**
- Calls 1–7 found the cause.
- Calls 8–26 made the edits: one short new preload file (`scripts/test-state.mjs`), and nine one-line changes to the test scripts of the seven packages.
- Calls 27–40 verified the result.
- Its narration never mentions the horde.
- Several of its shell commands were refused by the permission rules (`for` loops: "A variable in this command can't be checked before it runs"), so it retried them in other forms.

**How to read it.** This is a small, investigation-heavy fix: most of the cost is diagnosis and checking, and the code written is a short file plus nine one-line edits. That is exactly the work Anthropic's guidance and Claude Code's own prompt say to do inline ([claude-code](claude-code.md#claude-codes-own-delegation-prompt)). The two runs show that agents do not delegate such work. They say nothing about sizeable work, and with one run per arm they would show nothing even for this case [inference].

**Side effect to avoid.** Run B's verification pointed `TMPDIR` inside the checkout. A test then created a `horde/failed` branch in the real repository, which was deleted afterwards. Run probe tests with temporary directories outside any git checkout.

## Eval baseline

The suite in [`plugins/horde/evals`](../../plugins/horde/evals/README.md) runs six requests in a clone at 7caae37, with the horde tools mocked. Three should be delegated and three done directly. On 2026-10-21 it ran with the texts of ead8811: one run per case, `claude-opus-5-5`, $1.84 for the pass, plus $0.24 for a trial of one case.

| Case | Expected | `horde_do` calls | Cost |
| --- | --- | --- | --- |
| status-json | delegate | 1 | $0.37 |
| core-text-tests | delegate | 1 | $0.29 |
| three-pieces | delegate | 3 | $0.45 |
| servers-log | direct | 0 | $0.32 |
| one-line | direct | 0 | $0.22 |
| question | direct | 0 | $0.20 |

**What the traces show:**
- `core-text-tests` delegated at once.
- `status-json` read seven files (CLI, README, tests, render code), then said "I'm handing the change to a horde worker. I'll review what comes back before it lands".
- `three-pieces` opened the horde skill, then started all three pieces in parallel.
- Each first fetched the horde tools through tool search (the mocks do not honour `alwaysLoad`).
- `servers-log` and `one-line` went straight to their own edits, as in the headless runs.

**What it means.** Claude, given the plugin, delegates sizeable, describable work and keeps small work, which is the target in [horde-implications](horde-implications.md#the-target-restated). Earlier, only small work had been tried, and it was kept, correctly. The recognition argument in [literature](literature.md#what-the-literature-implies) (delegation has no topic to match) predicted failure on sizeable work, and this run contradicts it.

**Caveats.**
- One run per case.
- The environment is cleaner than a real session: no other plugins such as ponytail, no user CLAUDE.md, and only the five horde tools.
- Server instructions are absent, so they cannot be what made the difference.
- Which of the hook, the skill and the descriptions carries the effect is not known. Finding out needs an arm without the hook, or with other texts.

## Earlier subagent run

Before the tools were loaded upfront (779d122), a general-purpose subagent was given a plain request to write `ci.sh`. It did not delegate. In its report it cited:
- the built-in subagent rule against re-delegating;
- the ponytail hook's "shortest path" context;
- the extra step of finding the deferred horde tools through tool search;
- that the task was small and judgment-heavy.

This was observed in-session; the transcript was not kept.

## Hook delivery

The research subagents of 2026-10-21 reported seeing ponytail's SubagentStart text but no horde text. The session had loaded its hooks before the horde hook existed. A fresh session shows the hook working.

```sh
claude -p "Use the Agent tool once: a general-purpose subagent whose prompt is 'Reply with the single word done.' Then reply ok." \
  --model claude-haiku-5-5 --output-format json --allowedTools "Agent" --debug-file /tmp/subdebug.log
grep -i subagentstart /tmp/subdebug.log
```

The log shows `SubagentStart:general-purpose [node ".../plugins/horde/hooks/delegate.js" SubagentStart] (plugin horde@mcp-horde) finished with status 0 (31ms)` and `provided additionalContext (623 chars)`. Ponytail's SubagentStart hook provided 5,229 characters in the same run.

`--output-format stream-json` shows `hook_started` and `hook_response` events for SessionStart only, so it cannot confirm SubagentStart delivery. Use `--debug-file`.

## Asking a session why

Resuming run B's session (`claude -p --resume <id> "…why did you not use horde_do…"`) was refused by the API: "Opus 5.5's safeguards flagged this message", details `[reasoning_extraction]`. Asking a model to report how it reached a decision is treated as reasoning extraction. Evaluate behaviour (which tools were called) with graders, not by asking the model to explain itself. Gemini CLI's docs suggest that kind of question ([vendor guidance](vendor-guidance.md#google)); it does not work here.

## Reading a stream

The numbers above come from the `stream-json` output:
- Count the `tool_use` blocks in `assistant` messages, and among them the ones whose name starts with `mcp__plugin_horde_`.
- Take the cost, duration and turns from the final `result` message (`total_cost_usd`, `duration_ms`, `num_turns`).
- Hook events are the `system` messages with subtype `hook_started` or `hook_response`.
