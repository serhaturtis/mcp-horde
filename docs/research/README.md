# Research: MCP servers, hooks and agent guidance

Status: 2026-10-21. Claude Code 2.1.305, MCP specification 2026-07-28, OpenCode 2.1.1, models up to Claude Opus 5.5 and Fable 5.1.

The question behind this suite: what makes an agent reach for an MCP server's tools without being told, and what makes it hold back when it should. It came from the horde. Its tools were loaded upfront, and the server instructions, the skill and a session-start hook all said to delegate, yet two identical headless runs on a small fix delegated nothing ([experiments](experiments.md)). The findings apply to any MCP server that wants to be used by default, not only to delegation.

## Files

| File | What it covers |
| --- | --- |
| [claude-code.md](claude-code.md) | How Claude Code puts MCP tools, server instructions, skills, hooks, output styles, CLAUDE.md and subagents in front of the model; caps; its own delegation prompt; `claude plugin eval`; relevant changelog entries and issues |
| [mcp-protocol.md](mcp-protocol.md) | The MCP specification as of 2026-07-28 (stateless core, tasks extension, MRTR, deprecations), what Claude Code supports, and the guidance channels of other hosts (OpenCode 2, Codex, Gemini CLI, Cursor, VS Code, Copilot) |
| [vendor-guidance.md](vendor-guidance.md) | What Anthropic, the MCP project, OpenAI and Google tell developers about tool descriptions, triggering, aggressive wording and delegation |
| [literature.md](literature.md) | Papers and benchmarks: how much descriptions steer selection, tool over- and under-use, delegation bias, planner/executor economics, instruction hierarchy and position effects |
| [ecosystem.md](ecosystem.md) | What real projects do to get agents to use their tools or delegate (superpowers, ponytail, oh-my-openagent, Roo, ruflo, PAL, Codex plugin, claude-delegator, …), and the few measurements that exist |
| [experiments.md](experiments.md) | Our own runs and checks in this repository, with the commands to repeat them |
| [horde-implications.md](horde-implications.md) | What all of this means for mcp-horde: what to change, what to measure, what not to do |

## Evidence tags

Every claim carries one tag.

- **[checked]**: compared word for word against the primary source (the doc page, paper, repository file or the Claude Code binary) on 2026-10-21.
- **[read]**: a research agent fetched and read the primary source on 2026-10-20/21; not rechecked. Spot checks of about 25 such claims all held, one with slightly different wording.
- **[snippet]**: seen only in search-result text. Treat as unconfirmed.
- **[inference]**: our reasoning, not a claim any source makes.

Issue numbers refer to `anthropics/claude-code` unless stated otherwise.

## Conclusions

1. **In our eval, Claude delegated exactly the work it should.** With the horde's current texts it called `horde_do` for all three sizeable requests: a feature slice, a batch of tests, and three independent pieces, started in parallel. It called it for none of the three small ones (one run each; [experiments](experiments.md#eval-baseline)). The headless runs that delegated nothing were small work. The literature suggests a different picture: skills trigger when the task matches their topic, and delegation has no topic ([literature](literature.md#how-much-descriptions-steer-selection)). For these cases that reading was wrong.
2. **The host and the vendor tell models to do small work themselves.** "Do not delegate work you can finish yourself in a handful of tool calls" (Anthropic, Opus 5 guide). Claude Code's binary carries similar text, and GitHub improved Copilot CLI by delegating *less* ([vendor guidance](vendor-guidance.md#anthropic), [claude-code](claude-code.md#claude-codes-own-delegation-prompt)). Both of our runs were such small work.
3. **The channels differ in weight.** Server instructions are a "hint" meant to explain tools, not change behaviour. The tool description is "by far the most important factor". Hook text is a system reminder that should read as facts, not commands. CLAUDE.md arrives as the user's own instruction. A forced output style has the most weight ([claude-code](claude-code.md#what-each-channel-puts-in-context)).
4. **What has measurably changed behaviour:**
   - Making the agent state a yes/no decision every turn took skill activation from about 55% to 100%.
   - Structural setups make delegation the only path: an orchestrator without edit tools, or a system prompt the plugin owns.
   - Wording works, but in a direction that depends on the model: assertive cues raised usage 3–17x on other models, while Anthropic warns that its current models over-trigger on them.
   - Gentle reminders did nothing measurable.

   See [ecosystem](ecosystem.md#measured-effects) and [literature](literature.md).
5. **Delegating pays for sizeable, describable or parallel work, and costs extra otherwise.** Strong-planner, cheap-editor pairs match or beat the strong model alone. Multi-agent setups use about 15x the tokens, and coding parallelises less than research. No controlled study of a Claude orchestrator with cheap open-weight workers exists yet ([literature](literature.md#planner-executor-and-routing-economics)).
6. **Measure, don't guess.** Before the eval, everything pointed to "agents don't delegate", and the eval showed that was wrong for sizeable work. The suite is in [`plugins/horde/evals`](../../plugins/horde/evals/README.md): six cases graded on whether `horde_do` was called, about $1.84 a pass. Run it before and after any change to the texts ([claude-code](claude-code.md#measuring-claude-plugin-eval)).
7. **The protocol moved.** MCP 2026-07-28 is stateless, tasks became an extension Claude Code does not use, and sampling is deprecated. Claude Code moves long main-thread calls to the background after two minutes, but never in subagents or `-p` runs. Explicit task-id handles, as horde_do / horde_wait / horde_land use, are the pattern the new revision recommends ([mcp-protocol](mcp-protocol.md)).

## Keeping it current

This field changes monthly. Before relying on a number here (a cap, a version, a gate), recheck it. The Claude Code docs serve Markdown at `https://code.claude.com/docs/en/<page>.md` and the Claude platform docs at `https://platform.claude.com/docs/en/<path>.md`, so `curl -sL <url> | grep -F '<quote>'` confirms a quote in seconds. The Claude Code binary (`readlink -f "$(command -v claude)"`) can be searched with `strings` for prompt text. When something here turns out wrong, fix it in place and note the date.
