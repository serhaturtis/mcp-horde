# Vendor guidance: tool design, triggering and delegation

Status: 2026-10-21. Tags are explained in the [index](README.md#evidence-tags).

## Anthropic

### Tool descriptions

- **Detail matters most.** "Provide extremely detailed descriptions. This is by far the most important factor in tool performance." A description should say "When it should be used (and when it shouldn't)", in "at least 3–4 sentences" ([define-tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)) [read].
- **[Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)** (2025-09-11) [read]:
  - "Even small refinements to tool descriptions can yield dramatic improvements."
  - "When tools overlap in function or have a vague purpose, agents can get confused about which ones to use."
  - Describe a tool as you would "to a new hire on your team".
- **[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)** (2024-12-19) [read]:
  - "Tool definitions and specifications should be given just as much prompt engineering attention as your overall prompts."
  - "We recommend finding the simplest solution possible."
- **[Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)** (2025-09-29):
  - "If a human engineer can't definitively say which tool should be used in a given situation, an AI agent can't be expected to do better" [checked].
  - [read] Subagents return "a condensed, distilled summary of its work (often 1,000-2,000 tokens)".
- **[Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)** (2025-11-24) [read]:
  - "Tool search matches against names and descriptions, so clear, descriptive definitions improve discovery accuracy."
  - "Keep your three to five most-used tools always loaded, defer the rest."
  - With the Tool Search Tool, internal MCP evals rose for Opus 4 (49% → 74%) and Opus 4.5 (79.5% → 88.1%).
  - Tool use examples raised accuracy on complex parameters from 72% to 90%. That is a parameter measure, not a selection measure.

### Prompting for tool use

- **[Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)** (current; covers models up to Opus 5.5 and Fable 5.1). On over-triggering:
  - "If your prompts were designed to reduce undertriggering on tools or skills, these models may now overtrigger. The fix is to dial back any aggressive language" [checked].
  - Instead of "CRITICAL: You MUST use this tool when…", write "Use this tool when…" [read].
  - "Instructions like 'If in doubt, use [tool]' will cause overtriggering" [checked: "If in doubt, use"].
  - Instead of "Default to using [tool]", give targeted guidance such as "Use [tool] when it would enhance your understanding of the problem" [read].
- **Being explicit about action.** The same page: "If you say 'can you suggest some changes,' Claude will sometimes provide suggestions rather than implementing them", with a `<default_to_action>` snippet [read].
- **Native subagent orchestration.** The same page: "Claude's latest models orchestrate subagents natively… Ensure well-defined subagent tools: Have subagent tools available and described in tool definitions." Its sample damping prompt reads: "For simple tasks, sequential operations, single-file edits, or tasks where you need to maintain context across steps, work directly rather than delegating" [read].
- **[Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5):**
  - "Claude Opus 5 also delegates to subagents more readily than prior models" [checked: "delegates to subagents more readily"].
  - "Delegation pays off on genuinely independent, sizeable tracks of work, but it multiplies cost and time when applied to small tasks" [read].
  - Its sample prompt: "Do not delegate work you can finish yourself in a handful of tool calls, and do not use subagents to verify or double-check your own work" [checked: first clause].
  - "Claude Code adds a delegation instruction of its own on Claude Opus 5 only when you use its `claude_code` system prompt preset" [read].
  - The Opus 5.5 page says "Existing Claude Opus 5 prompts should perform well without changes", and Opus 5.5 defaults to `medium` effort [read].
- **Model differences.** Opus 4.8 "has a tendency to favor reasoning over tool calls… `high` or `xhigh` effort settings show substantially more tool usage". "If you find that the model is not using your web search tools, clearly describe why and how it should." Opus 4.8 "tends to spawn fewer subagents by default". Sonnet 5: "With thinking disabled, the model is less likely to reach for tools" [read].

### Skills

- **[Equipping agents with skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)** (2025-10-16) [read]:
  - Claude "pre-loads the `name` and `description` of every installed skill into its system prompt", and uses them "when deciding whether to trigger the skill".
  - Watch for "overreliance on certain contexts".
- **The skill-creator skill** ([anthropics/skills](https://raw.githubusercontent.com/anthropics/skills/main/skills/skill-creator/SKILL.md), undated) [read]:
  - "Currently Claude has a tendency to 'undertrigger' skills… please make the skill descriptions a little bit 'pushy'."
  - "Claude only consults skills for tasks it can't easily handle on its own — simple, one-step queries… may not trigger a skill even if the description matches perfectly."

### Delegation economics

- **[Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)** (2025-06-13) [read]:
  - "multi-agent systems use about 15× more tokens than chats", and single agents about 4×.
  - Token usage "explains 80% of the variance" in performance, and the system beat single-agent Opus 4 by 90.2%.
  - "most coding tasks involve fewer truly parallelizable tasks than research".
  - Early versions were "spawning 50 subagents for simple queries", so explicit effort-scaling rules were added.
  - A subagent brief needs "an objective, an output format, guidance on the tools and sources to use, and clear task boundaries".
  - "Bad tool descriptions can send agents down completely wrong paths". An agent rewriting tool descriptions cut task completion time by 40%.
- **[The advisor strategy](https://claude.com/blog/the-advisor-strategy)** (2026-04-09) [read]:
  - Sonnet with an Opus advisor scored +2.7 points on SWE-bench Multilingual at −11.9% cost per task.
  - Haiku with an Opus advisor scored 41.2% on BrowseComp against 19.7% alone. It "trails Sonnet solo by 29% in score but costs 85% less".
  - The arms used different thinking and system-prompt settings, and Anthropic measured itself.

## Claude Code docs

Details are in [claude-code.md](claude-code.md). The points that bear on guidance:

- **Subagents.** "To encourage proactive delegation, include phrases like 'use proactively' in your subagent's description field" [checked].
- **Server instructions.** "Server instructions help Claude understand when to search for your tools, similar to how skills work" [checked]. They are cut at 4,096 characters [checked].
- **Hooks.** Write hook text "as factual statements rather than imperative system instructions" [checked].
- **CLAUDE.md** "is delivered as a user message after the system prompt" [checked]. Emphasise one line at most [read].
- **The Agent SDK's fix for "Claude not delegating":** explicit prompting, and a clear description [checked].

## The MCP project

Details are in [mcp-protocol.md](mcp-protocol.md#trust-and-priority-of-server-text).

- **Instructions** "are for explaining your tools, not for modifying how the model generally responds or behaves" [checked]. "Don't include marketing or superiority claims." Critical behaviour is better as "deterministic rules or hooks" [read].
- **The blog's evaluation:** GPT-5-Mini went from 2/10 to 8/10 with instructions. Claude Sonnet 4 scored 10/10 without and 9/10 with [checked].
- **Annotations** are untrusted hints. Prompts are user-controlled, and resources are application-driven [read].

## OpenAI

- **[Function calling guide](https://developers.openai.com/api/docs/guides/function-calling)** (current) [read]:
  - "Use the system prompt to describe when (and when not) to use each function."
  - "Aim for fewer than 20 functions available at the start of a turn."
  - For deferred tools, "put detailed guidance in the function description".
- **The o3/o4-mini guide** (archived, about May 2025) [read]:
  - "A function's description should clarify when it should be invoked and how its arguments should be constructed."
  - "It is helpful to clarify the model boundaries on when and when not to invoke certain tools."
  - Ordering and preferences belong in the developer prompt, which "avoids tool overuse or underuse".
- **The GPT-5 prompting guide** (archived) [read]:
  - Cursor's "Be THOROUGH when gathering information…" was "counterproductive" on GPT-5.
  - The guide gives eagerness controls, including a tool-call budget.
- **The Codex prompting guide** (gpt-5.3-codex) [read]:
  - The model "has been trained to closely adhere to" AGENTS.md.
  - "Each discovered file becomes its own user-role message."
  - Tool names should match what the model was trained on.
- **[Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)** [read]:
  - "Current local Codex releases spawn agents after a direct request or applicable project or skill instruction."
  - "Subagent workflows consume more tokens than comparable single-agent runs."
- **[Agents SDK multi-agent](https://openai.github.io/openai-agents-python/multi_agent/)** [read]:
  - With agents-as-tools, the manager "keeps control". With a handoff, the specialist becomes the active agent.
  - "Orchestrating via code makes tasks more deterministic and predictable".

## Google

- **[Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling)** [read]:
  - "Keep active set to 10-20 tools maximum."
  - "Prompt Engineering: Provide context and instructions."
  - Calling modes are auto, any, none and validated.
- **[ADK agent team tutorial](https://adk.dev/tutorials/agent-team/index.md)** [read]:
  - "The `description` is the primary information the *root agent* uses to decide *when* to delegate."
  - Yet the example's root instruction spells out the routing too: "If it's a greeting, delegate to 'greeting_agent'."
- **[Gemini CLI subagents](https://geminicli.com/docs/core/subagents/)** (2026-06-08) [read]:
  - The harness instructs the main agent "to use specialized subagents when a task matches their expertise".
  - Its tuning tip is to ask the model why it did not call your subagent. For what happened when we tried that, see [experiments](experiments.md#asking-a-session-why).

## Where the guidance disagrees

- **Pushy or calm?** The skill-creator skill says Claude under-triggers skills, so be "pushy". The prompting guide says recent models over-trigger, so drop forceful wording and blanket defaults. The best-practices page allows emphasis on one line. The effect depends on the model version, so measure it instead of assuming [inference].
- **Natural or damped delegation?** The prompting guide says Claude orchestrates subagents natively. The Opus 5 guide and Claude Code's own prompt damp delegation of small work. Codex ties delegation to an explicit request or instruction. Opus 4.8 spawns fewer subagents.
- **Description or system prompt?** Anthropic's define-tools page and ADK put the description first. OpenAI's current guide puts when/when-not in the system prompt. OpenAI's older guide and the ADK example use both.
- **Do server instructions help Claude?** In the MCP blog's small evaluation they helped GPT-5-Mini and did not help Claude Sonnet 4.
