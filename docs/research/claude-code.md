# Claude Code: how tools and guidance reach the model

Status: 2026-10-21, Claude Code 2.1.305. Tags are explained in the [index](README.md#evidence-tags). Docs pages are under `https://code.claude.com/docs/en/`.

## MCP tools and server instructions

- **Tool search is on by default.** "Only tool names and server instructions load at session start." The rest of a tool's definition loads when Claude searches for it. `ENABLE_TOOL_SEARCH` takes:
  - unset or `true`: defer every tool;
  - `auto`: load upfront until the definitions reach 10% of the context;
  - `auto:N`;
  - `false`.

  Source: [mcp](https://code.claude.com/docs/en/mcp) [read].
- **`_meta["anthropic/alwaysLoad"]: true` on a tool loads it upfront.** The key is documented on the same page [checked]. "Startup doesn't wait for your server because of this value" [read]. A user's server-level `"alwaysLoad": false` defers every tool of that server and overrides the per-tool key [read]. The changelog has server-level `alwaysLoad` in 2.1.121, and per-tool `alwaysLoad: false` honoured from 2.1.285 [read].
- **Server instructions and upfront tool descriptions are cut at 4,096 characters** [checked]. Deferred tool descriptions may run to 16,384 [read]. The cap was 2,048 before 2.1.296 (2026-10-09) [read]. `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` changes both caps [read]. The docs advise to "put critical details near the start" [read].
- **What instructions are for.** "Server instructions help Claude understand when to search for your tools, similar to how skills work" [checked]. The page suggests covering what category of tasks the tools handle and when Claude should search for them [read].
- **Where instructions appear.** They come under the heading "# MCP Server Instructions" with the line "The following MCP servers have provided instructions for how to use their tools and resources:". This was observed in our own session context [checked]. In the binary they travel as an `mcp_instructions_delta` attachment, not as part of the system prompt proper [read]. In subagents they reportedly arrive "just before the subagent's 2nd API call" (#98438, 2026-09-30) [read]. So for a subagent's first decision, only tool descriptions and SubagentStart hook text count [inference].
- **The trust and priority of server-provided text are not documented.** The only related line is a warning to verify that you trust each server, because of prompt-injection risk [read].
- **`structuredContent` replaces the text.** On a successful call Claude receives only the `structuredContent` JSON, not `content[].text`. On an error result, `structuredContent` is dropped. A maintainer confirmed this in #86032 (open, 2026-08-12) [read]. Anything the model must read has to be inside whichever part it sees.
- **Long-running calls (changelog 2.1.212):**
  - "An MCP tool call in the main conversation that is still running after two minutes moves to a background task… the result arrives as a task notification."
  - Calls from subagents and non-interactive runs are never moved to the background.
  - A stdio call "that sends no response and no progress notification for the idle window aborts". The idle window is 30 minutes.
  - A per-server `timeout` is a hard wall-clock limit that progress notifications do not extend. The default tool timeout is about 28 hours.
  - 2.1.283 stopped progress notifications being discarded once a call moved to the background.

  [read]
- **Protocol negotiation.** Claude Code has two MCP client runtimes. The v2 runtime (TS SDK 2.0) negotiates 2026-07-28 with servers that support it and treats the rest as v1. Since 2.1.292, stdio servers negotiate 2026-07-28 "by default on every install", and `MCP_PROTOCOL_NEGOTIATION=legacy` opts out. A channel server on 2026-07-28 "can't deliver channel messages" [read].
- **Elicitation** is supported in form and URL modes (2.1.76; URL mode on 2026-07-28 connections since 2.1.281), with `Elicitation` and `ElicitationResult` hooks. Roots are supported. Sampling is not (#1785, still open). MCP Apps UI resources are not rendered [read].

## What each channel puts in context

| Channel | How it reaches the model | Documented weight or advice |
| --- | --- | --- |
| Tool description | In the tool list (upfront or after search); cut at 4,096 / 16,384 | The main signal for choosing a tool ([vendor guidance](vendor-guidance.md#anthropic)) |
| Server instructions | "# MCP Server Instructions" section, loaded at session start | For "when to search for your tools"; a hint ([mcp-protocol](mcp-protocol.md#trust-and-priority-of-server-text)) |
| Skill name + description | The skill listing; `description` + `when_to_use` cut at 1,536 | Matched against the task; see below |
| Hook `additionalContext` | A system reminder placed where the hook fired | Facts, not commands; see below |
| CLAUDE.md, rules | "delivered as a user message after the system prompt" | Introduced as overriding default behaviour |
| `--append-system-prompt` | System prompt | "diminishing returns for adherence" |
| Output style | Replaces parts of the system prompt | "highest instruction-following weight" |
| Plugin `agent` setting | Runs the main thread under a plugin agent's prompt | The user's own `agent` setting wins |

### Skills

- **The listing.** `description` plus `when_to_use` is "truncated at 1,536 characters" [checked: "1,536"]. The whole listing gets 1% of the context window (`skillListingBudgetFraction`, `SLASH_COMMAND_TOOL_CHAR_BUDGET`). On overflow it "drops descriptions starting with the skills you invoke least" [read]. A skill that is never used is therefore the first to lose its description [inference].
- **Troubleshooting advice.** Not triggering: "Check the description includes keywords users would naturally say." Triggering too often: "Make the description more specific" [read]. "Claude skipped a rule that must hold every time: move the rule into a hook… To keep the rule with the skill, define the hook in the skill's `hooks` frontmatter. That hook applies from the time the skill is invoked until the session ends" [checked]. Source: [skills](https://code.claude.com/docs/en/skills).

### Hooks

- **Events that accept `additionalContext`:** SessionStart, SubagentStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolBatch, Stop, SubagentStop and PostModelSwitch [read].
- **Delivery.** "Claude Code wraps the string in a system reminder and inserts it into the conversation at the point where the hook fired" [read]. Where that is depends on the event [read]:
  - SessionStart and SubagentStart: at the start of the conversation;
  - UserPromptSubmit: alongside the submitted prompt;
  - PreToolUse and PostToolUse: next to the tool result.
- **Size.** Each value is capped at 10,000 characters, and "Claude receives all of the values" [read]. The JSON must sit under `hookSpecificOutput`; a top-level `additionalContext` is silently dropped (#96193, title) [read].
- **Phrasing, verbatim:** "Write the text as factual statements rather than imperative system instructions. Phrasing such as 'The deployment target is production' or 'This repo uses `bun test`' reads as project information. Text framed as out-of-band system commands can trigger Claude's prompt-injection defenses, which causes Claude to surface the text to you instead of treating it as context" [checked]. Directly above it: "For instructions that never change, prefer CLAUDE.md" [checked].
- **Resume and compaction.**
  - SessionStart hooks run again on resume with `source` set to `"resume"`, or `"fork"` with `--fork-session`.
  - Mid-session hook text is replayed from the transcript, not re-run [checked].
  - After compaction, earlier hook context is summarized with the rest of the conversation, and only SessionStart hooks that match `compact` run again ([context-window](https://code.claude.com/docs/en/context-window)) [read].
- **Decision fields.**
  - PreToolUse `permissionDecisionReason` is shown to Claude for `"deny"`; for `"allow"` it only goes to the debug log.
  - A SubagentStop `block` "delivers `reason` to the subagent as its next instruction".

  [read]
- **Escaping.** Since 2.1.292, `<system-reminder>` tags in hook output are escaped [read].

### Output styles, plugin settings, CLAUDE.md

- **Output styles.** Plugins can ship them. With `force-for-plugin: true` [checked: key] a style applies "automatically whenever the plugin is enabled… Overrides the user's `outputStyle` setting", and the first plugin loaded wins [read]. Without `keep-coding-instructions`, Claude Code's software-engineering instructions are dropped. Styles reach the main thread and forks, not other subagents [read]. Anthropic's "Steering Claude Code" post (2026-06-18) says output styles "carry the highest instruction-following weight of any method", and that appending to the system prompt "has diminishing returns for adherence" [checked]. Contradiction: the glossary lists output-style instructions among the things delivered as system reminders [read].
- **Plugin settings.** A plugin's `settings.json` honours only `agent` and `subagentStatusLine`. A CLAUDE.md at the plugin root is not loaded: "To include instructions that load into Claude's context, put them in a skill" [read].
- **CLAUDE.md** "is delivered as a user message after the system prompt" [checked]. Claude Code introduces it "with a line telling Claude that the instructions override default behavior" [read]. The Agent SDK docs say "Instructions in a user message carry marginally less weight than the same text in the system prompt" [read]. On emphasis, the best-practices page says: "If Claude keeps skipping one instruction, add emphasis such as 'IMPORTANT' to that line alone. If you emphasize many lines, none of them stands out" [read]. AGENTS.md has been read natively since 2.1.277, but only when there is no CLAUDE.md [read].
- **Channels** are a research preview that needs `--channels` each session and an allowlist. They push events in; they are not a guidance channel [read].

## Subagents

- **Choosing a subagent.** Claude picks one by its `description`: "To encourage proactive delegation, include phrases like 'use proactively'" ([sub-agents](https://code.claude.com/docs/en/sub-agents)) [checked].
- **What a subagent gets.** It has its own system prompt, "not the Claude Code system prompt". It inherits MCP tools, can invoke skills through the Skill tool, and loads CLAUDE.md, except in Explore and Plan [read].
- **Nesting.** Subagents nest "up to three layers" by default (2.1.219), set with `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` [read].
- **Hooks in subagents.** Plugin hooks run inside subagents, and SubagentStart context is "added to the subagent's context at the start of its conversation" [read]. Our hook was confirmed to arrive ([experiments](experiments.md#hook-delivery)). SessionStart context never reaches subagents, which is why ponytail added a SubagentStart hook (its source comment, issue #252 of DietrichGebert/ponytail) [read]. Plugin-provided agents ignore the `hooks`, `mcpServers` and `permissionMode` fields [read].
- **The built-in general-purpose subagent's prompt ends with:** "You are already the dedicated agent for this task. Do the work directly — do not re-delegate your entire assignment to another single subagent." This is in the 2.1.305 binary [checked]. 2.1.203 says "agents are now less likely to re-delegate their entire task" [read].
- **The Agent SDK troubleshooting for "Claude not delegating to subagents":** "Use explicit prompting: mention the subagent by name in your prompt" and "Write a clear description: explain exactly when to use the subagent so Claude can match tasks appropriately" ([agent-sdk/subagents](https://code.claude.com/docs/en/agent-sdk/subagents)) [checked].

## Claude Code's own delegation prompt

These strings are in the 2.1.305 binary [checked]:

- "Do the work inline when it is a small, bounded sub-task — a few file reads, one search, a short edit, a single check. Do not spawn a subagent for work you could finish yourself in a handful of tool calls."
- "Subagents multiply cost and time: each one re-establishes context, re-explores, and reports back, and you then re-read its report. Delegate only when the payoff clearly exceeds that overhead."
- "Do not use the ${Agent} tool, workflows, or deep-research unless the user, a CLAUDE.md file, or a skill asks for it" (`${Agent}` is a template variable for the tool name).
- "Do not call the AgentTool unless the user" (an older form; still present as a string).

The Agent SDK docs say: "when the model is Opus 5, Claude Code adds a line to its system prompt telling Claude not to call the Agent tool unless it's asked to" [checked].

According to the research agent's binary inspection, the reduced-delegation section (`opus5_reduced_delegation`) is gated on a capability only `claude-opus-5` carries. The "inline" counter-steer text sits behind the flag `tengu_thistle_grebe` (env `CLAUDE_CODE_THISTLE_GREBE`: `default`, `no_nudges` or `counter_steer`), cached as `default` on this machine [read]. Our Opus 5.5 main-session system prompt contains none of these lines [checked: own context].

History: from 2.1.219 an Opus-5-only section said "Do not call the AgentTool unless the user requested it". Users reported it overriding their CLAUDE.md delegation rules (#80988, opened 2026-07-24, 37 comments, no maintainer reply; related #82456, #84183, #82371) [read].

These lines are about the Agent tool, not MCP tools. They show the host's stance, though: small, bounded work belongs inline, and the user, CLAUDE.md or a skill can authorise delegation [inference].

## Measuring: `claude plugin eval`

- **Availability.** The command exists in 2.1.305 [checked: `claude plugin eval --help`]. It runs eval cases (`<eval dir>/**/case.yaml`, or `prompt.md` plus `graders/*.md`) against a plugin. With `--ablation with-without`, the default when a plugin resolves, it adds a no-plugin baseline arm and reports the delta [checked: help text].
- **Mocks and real servers.** MCP servers are mocked unless you opt in with `--allow-real-servers` [checked: help text].
- **Graders.** Each case runs three times per arm. A `tool_used` grader takes `input_match`, and `min: 0`, `max: 0`, `arm: both` make a "must not invoke" case [read].
- **What the docs warn about:** "The most common first finding is a `Δ` near zero with the case's `tool_used: Skill` grader failing, which means Claude isn't choosing your skill on natural phrasing" [checked: first clause; rest read]. Source: [plugin-evals](https://code.claude.com/docs/en/plugin-evals).
- **Headless caution.** #36570 (2026-03) reported 0% skill recall in a `claude -p` loop because headless mode did not load skills [read]. In our headless runs the plugin and its five servers did load ([experiments](experiments.md)).

## Changelog entries that matter here

| Version | Date | Change |
| --- | --- | --- |
| 1.0.52 | 2025-07-15 | MCP server instructions |
| 2.0.43 | 2025-11-17 | SubagentStart hook |
| 2.1.7 | 2026-01-13 | Tool search auto mode on by default |
| 2.1.9 | 2026-01-15 | PreToolUse `additionalContext` |
| 2.1.84 | 2026-03-25 | 2 KB cap on descriptions and instructions |
| 2.1.105 | 2026-04-13 | Skill description cap 250 → 1,536 |
| 2.1.121 | 2026-04-27 | Server-level `alwaysLoad` |
| 2.1.163 | 2026-06-04 | Stop / SubagentStop `additionalContext` |
| 2.1.203 | 2026-07-07 | Agents less likely to re-delegate their entire task |
| 2.1.212 | | Long main-thread MCP calls move to the background |
| 2.1.219 | 2026-07-24 | Subagent nesting depth 3 |
| 2.1.277 | | AGENTS.md read when there is no CLAUDE.md |
| 2.1.285 | 2026-09-29 | Per-tool `alwaysLoad: false` honoured |
| 2.1.292 | 2026-10-06 | stdio servers negotiate 2026-07-28 by default; `<system-reminder>` tags in hook output escaped |
| 2.1.296 | 2026-10-09 | Description and instructions cap 2,048 → 4,096 |
| 2.1.304 | 2026-10-19 | Tool search on by default behind a custom `ANTHROPIC_BASE_URL`; skill listing rebuilt after compaction |

Source: [CHANGELOG.md](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md), with dates from npm [read]. Blank dates were not recorded. Contradiction: the MCP docs page still says tool search is disabled behind a non-first-party `ANTHROPIC_BASE_URL`, while 2.1.304 says it is now on there [read].

## Issues worth knowing

| Issue | What it reports |
| --- | --- |
| #80988 | Opus 5 "do not call the AgentTool unless the user requested it" overrode CLAUDE.md delegation rules (open) |
| #95745 | After `/compact`, CLAUDE.md was present but ignored, while "an imperative, trigger-coupled hook instruction was honoured" |
| #96326 | CLAUDE.md, the language setting and a per-turn UserPromptSubmit hook still gave 11 of 98 replies in the wrong language, "right after reading English tool output" |
| #94333 | The auto-mode "prefer Bash" reminder competes with instructions to use an MCP tool (title) |
| #98438 | MCP server instructions reach subagents only before their second API call |
| #86032 | `structuredContent` replaces the text on success and is dropped on error |
| #90296 | UserPromptSubmit `additionalContext` intermittently never reaches the context (title) |
| #96193 | Top-level `additionalContext` outside `hookSpecificOutput` is dropped (title) |
| #2544 | "CLAUDE.md Mandatory Rules Consistently Ignored" (open since 2025-06) |
| #9716 | Skills not used; the thread's fixes are slash commands, "Use when: user says X, Y, or Z" descriptions, and a routine in CLAUDE.md |
| #46952 | Skill activation is "closer to keyword matching" (closed as stale) |
| #30355 | A request for a switch to turn off skill auto-triggering |
| #36570 | Headless `-p` runs did not load skills (2026-03) |
| #1785 | Sampling support (open) |

All [read]; "(title)" means only the title was seen.
