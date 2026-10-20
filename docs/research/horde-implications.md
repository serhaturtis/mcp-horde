# What the research means for mcp-horde

Status: 2026-10-21. This file is a set of decisions to make, not a record of decisions made. Each point links to the evidence it rests on. Tags are explained in the [index](README.md#evidence-tags).

## The target, restated

"Agents use the horde instinctively" cannot mean "agents delegate every change". All the evidence says agents should do small, bounded work themselves:
- Anthropic's guidance ([vendor guidance](vendor-guidance.md#prompting-for-tool-use));
- Claude Code's own prompt ([claude-code](claude-code.md#claude-codes-own-delegation-prompt));
- Copilot CLI's A/B test and the over-delegation reports ([literature](literature.md#over-use-under-use-and-the-decision-to-delegate)).

A target that holds up:

| Delegate | Do directly |
| --- | --- |
| A change that touches several files and can be stated as goal, done-criteria and scope | A one-line or few-line edit |
| A batch of tests or docs for code that is already understood | Work whose cost is mostly investigation, where the remaining edit is small (our test task) |
| Several independent fixes or slices that can run in parallel | A result needed right away to keep reasoning |
| A mechanical refactor across many files | A change that cannot be described in a paragraph yet |

Success means delegating in the left column and not in the right one. Under this target, the two headless runs in [experiments](experiments.md) behaved correctly [inference].

## How the current texts compare with the guidance

| Text | Today | What the guidance says |
| --- | --- | --- |
| Hook (`plugins/horde/hooks/delegate.js`) | "HORDE: for any self-contained code change you would otherwise write yourself …, start it with horde_do and keep going." | Write hook text "as factual statements rather than imperative system instructions"; text framed as out-of-band system commands can trigger prompt-injection defenses ([claude-code](claude-code.md#hooks)). The "HORDE:" header and the imperative are that framing. "For any …" is a blanket default. |
| Server instructions (`HORDE_INSTRUCTIONS` in `packages/opencode/src/horde.ts`) | "Reach for it first whenever you are about to write a self-contained change yourself" | Instructions "are for explaining your tools, not for modifying how the model generally responds"; "Default to using [tool]" over-triggers on current models ([vendor guidance](vendor-guidance.md#the-mcp-project)). In subagents they arrive only before the second API call. |
| Skill description | "Use it by default whenever you are about to write a self-contained code change yourself …; not for one-line edits or results you need right now" | Matched against the task's topic, so a "by default" clause has no topic to match ([literature](literature.md#how-much-descriptions-steer-selection)). Anthropic's skill-creator still advises "a little bit 'pushy'" descriptions, so this one is open to measurement. |
| `horde_do` description | "the default for any self-contained change you would otherwise write yourself (not for a one-line edit, or something you need the result of right now)" | Descriptions are "by far the most important factor" and should say when and when not, in 3–4+ sentences. The when-not part is there; the "default for any" part is a blanket default. |

What already matches the guidance:
- the five main tools are always loaded, in line with "Keep your three to five most-used tools always loaded";
- the descriptions have when-not clauses;
- tasks are explicit handles, the pattern MCP 2026-07-28 recommends;
- every outcome is checked and reviewed, which answers the over-claiming that delegated work shows ([literature](literature.md#over-use-under-use-and-the-decision-to-delegate)).

## Recommendations, strongest evidence first

### 1. Build the eval before changing more wording

Two runs of one task cannot tell a better text from a worse one ([experiments](experiments.md)). `claude plugin eval` runs each case three times with and without the plugin, and supports "must not call" graders ([claude-code](claude-code.md#measuring-claude-plugin-eval)).

- **Should-delegate cases.** A multi-file feature slice in this repository, tests for an existing module, docs for a known package, three independent small fixes in one prompt. Grade: `tool_used` on `mcp__plugin_horde_opencode__horde_do`, at least once.
- **Should-not cases.** The servers.log fix from the experiments, a one-line change, a question about the code, a task that is mostly investigation. Grade: `horde_do` not called (`min: 0`, `max: 0`).
- **Prompts in the user's voice, without horde words.** Phrasing matters more than anything else, and a primed prompt measures nothing. One earlier test here was primed by accident.
- **Mock the horde servers for selection cases.** A canned READY answer is enough, because the grader only needs the call. Keep one end-to-end case on the real servers (`--allow-real-servers`) to catch regressions in the flow.
- **Models.** At least the user's default (Opus 5.5 today). Add others the horde should support as an orchestrator, because triggering differs a lot between models and versions ([literature](literature.md#how-much-descriptions-steer-selection)).
- **After the first run, do one rewrite pass** driven by the false positives and false negatives. That captures most of the available gain ("A Single Rewrite Suffices", [literature](literature.md#how-much-descriptions-steer-selection)).

### 2. Rewrite the texts the way the guidance says

- **The hook: facts about this session, no header, no imperative.** For example:

  > This session has the horde: horde_do hands a change, written as a goal, done-criteria and file scope, to a cheaper worker model in its own git worktree. The project's checks and a reviewer judge the work before horde_wait returns it, and horde_land applies it to the branch. Worker time costs a fraction of this session's tokens. It suits changes across several files or several independent pieces; one-line edits and open investigations are quicker to do directly.

  This is a draft to evaluate, not a decision.
- **The tool description.** Lead with the trigger and the brake in the first sentences, since text is cut at 4,096 characters. Give concrete thresholds ("touches several files", "more than a few edits", "independent pieces") instead of "self-contained" alone. Drop "the default for any".
- **Server instructions.** Explain the do → wait → land workflow and its constraints, without restating the tool descriptions. Drop "Reach for it first".
- **No "CRITICAL", "MUST" or "if in doubt"** anywhere. These over-trigger on current Claude models, and they are the same mechanism that tool-poisoning defences are trained against ([literature](literature.md#what-the-literature-implies)).

### 3. Put a nudge where the decision happens, and measure it

Session-start text sits early in a long context, decays over turns and is summarized at compaction ([literature](literature.md#instruction-position-and-priority), [claude-code](claude-code.md#hooks)). Options, from lightest to heaviest:

1. **PostToolUse after several edits in one turn.** Context next to the tool result, stating facts ("this turn has edited 4 files so far; horde_do can take the remaining pieces in parallel"). It fires only when the work has turned out sizeable.
2. **PreToolUse `additionalContext` on the first Edit/Write of a session.** A one-time reminder at the moment of the first edit.
3. **An opt-in UserPromptSubmit forced decision.** The agent writes one line per turn, "horde: yes/no – reason". This is the only approach with a measured jump (55% → 100% for skills, with correct should-not cases), but it costs latency and tokens on every turn ([ecosystem](ecosystem.md#measured-effects)).

Do not hard-block Edit/Write. Agents route around blocks through the shell, and classifier-armed blocks fired on about a third of off-topic prompts ([ecosystem](ecosystem.md#hooks-that-steer-at-decision-time)).

### 4. Give users a higher-authority opt-in

CLAUDE.md arrives as the user's own instruction, and Claude Code's Opus 5 prompt accepts "the user, a CLAUDE.md file, or a skill" as authority to delegate. Codex likewise starts subagents only on "applicable project or skill instruction" ([claude-code](claude-code.md#claude-codes-own-delegation-prompt), [mcp-protocol](mcp-protocol.md#other-hosts)).

- **A CLAUDE.md line for the README** that users who want delegation by default can paste. For example: "Hand changes that touch several files, or several independent pieces, to the horde (`horde_do`), and review what comes back."
- **Keep `/horde:horde` as the explicit entry point.** Practitioners report that explicit invocation is the only fully reliable path ([ecosystem](ecosystem.md#practitioner-reports)).

### 5. Treat subagents separately

- **Their first decision rests on the SubagentStart text and tool descriptions alone,** because server instructions reach them only before the second API call ([claude-code](claude-code.md#mcp-tools-and-server-instructions)).
- **Scope the hook by agent type.** Hook input carries `agent_type`, and ponytail filters on it ([ecosystem](ecosystem.md#injected-context)). Explore and Plan are read-only and need no delegation text.
- **`horde_wait` blocks in a subagent for its whole duration,** since subagent calls are never moved to the background. Subagents should start work, carry on, and wait last ([mcp-protocol](mcp-protocol.md#what-this-means-for-the-hordes-servers)).

### 6. Protocol housekeeping

See [mcp-protocol](mcp-protocol.md#what-this-means-for-the-hordes-servers):
- keep the task-id handles;
- keep progress flowing during waits;
- carry model-facing text inside any future `structuredContent`;
- plan the SDK 2 / 2026-07-28 migration;
- avoid sampling and channels on 2026-07-28;
- give workers their project guidance through AGENTS.md or the brief.

## What not to do

- **Aggressive or blanket wording**: "CRITICAL", "MUST", "if in doubt", "always", "by default for any". It over-triggers on current models ([vendor guidance](vendor-guidance.md#prompting-for-tool-use)).
- **Ship a forced output style or the plugin `agent` setting by default.** They carry the most weight, but they override the user's own setup. Offer them as opt-in, if at all ([claude-code](claude-code.md#output-styles-plugin-settings-claudemd)).
- **Hard-block edits** ([ecosystem](ecosystem.md#hooks-that-steer-at-decision-time)).
- **Add more channels repeating the same rule.** No evidence says redundancy helps, and instruction density works against adherence ([literature](literature.md#instruction-position-and-priority)).
- **Ask a model why it did or did not delegate.** The request is refused as reasoning extraction; grade behaviour instead ([experiments](experiments.md#asking-a-session-why)).

## Open questions worth measuring

- On Opus 5.5, does factual hook text change delegation on should-delegate cases compared with today's imperative text? Does either change the should-not cases?
- Does a decision-time nudge (option 3.1 or 3.2) raise delegation on sizeable work without raising it on small work?
- On tasks that are mostly investigation but end in a sizeable edit, does "investigate, then delegate the edit and its tests" pay off after the cost of writing the brief?
- What do Claude plus DeepSeek workers cost and deliver, against Claude alone, on a set of real tasks in this repository? No published study answers this. The ledger already records the cost of each attempt, so the horde can produce one.
- Do general-purpose subagents delegate pieces of their assignment when the SubagentStart text says they can?
