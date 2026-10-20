# Ecosystem: how projects get agents to use their tools

Status: 2026-10-21. Tags are explained in the [index](README.md#evidence-tags). Mechanisms were read in source code. Claims that they work are mostly anecdotal, and this file says so where they are.

## Mechanisms in real projects

### Injected context

- **[obra/superpowers](https://github.com/obra/superpowers)** (main, 2026-10).
  - **The hook.** A SessionStart hook (matcher `startup|clear|compact`) injects the whole `using-superpowers` skill through `hookSpecificOutput.additionalContext`, wrapped in `<EXTREMELY_IMPORTANT>` [checked].
  - **The skill's wording.** It says "If you think there is even a 1% chance a skill might apply to what you are doing, you ABSOLUTELY MUST invoke the skill" [checked]. A "Red Flags" table rebuts excuses, e.g. "'This is just a simple question' | Questions are tasks. Check for skills" [read].
  - **Subagents are exempt:** "If you were dispatched as a subagent to execute a specific task, ignore this skill" [checked].
  - **How it was tuned.** The author hardened the wording by pressure-testing it with subagents in realistic scenarios, and by applying Cialdini's persuasion principles ([blog.fsck.com, 2025-10-09](https://blog.fsck.com/2025/10/09/superpowers/)) [read]. The effect is anecdotal.
- **[DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail).**
  - **SessionStart** (`startup|resume|clear|compact`) injects the full ruleset, about 1.4k words, including "ACTIVE EVERY RESPONSE" [read].
  - **SubagentStart** injects it into every subagent: "SessionStart context is parent-thread only and never reaches subagents, so without this every Task-spawned agent runs ponytail-unaware". The regex `PONYTAIL_SUBAGENT_MATCHER` filters by `agent_type` [read]. On this machine its SubagentStart text is 5,229 characters ([experiments](experiments.md#hook-delivery)) [checked].
  - **UserPromptSubmit** only tracks `/ponytail` mode switches. The exception is Qoder, which has no SessionStart and so gets the ruleset every turn [read].
  - **Benchmark.** Its README reports its own benchmark (39 tasks × 5 runs, Opus 5.5): "-53% code". That measures behaviour shaping, not tool use [read].
- **[ruvnet/ruflo](https://github.com/ruvnet/ruflo)** (formerly claude-flow).
  - A UserPromptSubmit hook runs on every prompt and prints a "Primary Recommendation" box (agent, confidence, reason).
  - CLAUDE.md tells the model to read those tags: "Always check for `[CODEMOD_AVAILABLE]` or `[TASK_MODEL_RECOMMENDATION]` before spawning agents." It routes through three tiers: a $0 codemod, then Haiku, then Sonnet/Opus. [read]
  - Its own CLAUDE.md says a speedup figure was "never reproduced in-tree". A secondary source reports a self-audit that found subsystems stubbed [snippet]. Its claims are weak evidence.
- **[jarrodwatts/claude-delegator](https://github.com/jarrodwatts/claude-delegator).**
  - Setup copies rule files into `~/.claude/rules/delegator/`, so they load like CLAUDE.md. The rules say: "IMPORTANT: Check These Triggers on EVERY Message… PROACTIVE: On every user message, check if semantic triggers match → delegate automatically."
  - They pair trigger-phrase tables with a "When NOT to Delegate" table ("Trivial bug fixes", "First attempt at any fix | Try yourself first").
  - Its README admits misses: "Expert not triggered | Try explicit: 'Ask GPT to review...'".

  [read]
- **[wshobson/agents](https://github.com/wshobson/agents).** Subagent descriptions end with "Use PROACTIVELY when…" and carry a per-agent `model:`. Its trace-based evals are "in progress", and its LLM judge is "not validated against human labels" [read].

### Owning the prompt or the structure

- **[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)** (formerly oh-my-opencode, for OpenCode). It owns the main agent's system prompt (Sisyphus) instead of adding rules to someone else's.
  - The prompt says: "Delegation Check (MANDATORY before acting directly)… **Default Bias: DELEGATE. WORK YOURSELF ONLY WHEN IT IS SUPER SIMPLE.**" [checked: the second sentence, in `packages/omo-opencode/src/agents/sisyphus-dynamic-prompt-*.ts`].
  - It makes the agent state its routing decision ("I detect [..] intent - [reason]. My approach: …") and defines a "Trivial (single file, known location) → Direct tools only" class [read].
  - Per-message keywords (`ulw`) switch modes. "Kibitzer" is "A small, cheap model sits beside the expensive main agent… and nudges the main agent" [read].
- **Roo Code Orchestrator ("boomerang").** The orchestrator mode has `groups: []`: no read, edit or command tools, so delegating through `new_task` is the only way it can act ([mode.ts](https://github.com/RooCodeInc/Roo-Code/blob/main/packages/types/src/mode.ts)). The repository was archived in 2026-05. Kilo's docs say: "Orchestrator mode is deprecated… You no longer need a dedicated orchestrator." Kilo's Code, Plan and Debug agents now delegate themselves [read].
- **[claude-code-router](https://github.com/musistudio/claude-code-router).** Routing happens in the gateway, so the model never chooses. Background requests go to a configured cheap model. Subagents are routed by a `<CCR-SUBAGENT-MODEL>provider,model</CCR-SUBAGENT-MODEL>` tag "at the **beginning** of the subagent's prompt" (README, 2025-09) [read].

### Explicit entry points by design

- **[Amp's oracle](https://ampcode.com/news/oracle)** (2025-07-04): "We consciously haven't pushed the oracle too hard in the system prompt… to avoid unnecessarily increasing costs… Instead, we rely on explicit prompting." The current docs say "Amp chooses subagents automatically for suitable tasks" [read].
- **[PAL MCP](https://github.com/BeehiveInnovations/pal-mcp-server)** (formerly zen). "You're the one who crafts the powerful prompt that makes Claude bring in Gemini, Flash, O3 — or fly solo." Most tools are off by default to save context [read].
- **openai/codex-plugin-cc** (2026-03).
  - Its main entry points are slash commands (`/codex:rescue`, `/codex:review`).
  - A `codex-rescue` subagent's description reads "Proactively use when Claude Code is stuck… or should hand a substantial coding task to Codex".
  - An optional Stop-hook review gate blocks the stop when Codex finds issues; the README warns it "may drain usage limits quickly".

  [read]
- **aoalejo/opencode_mcp** scopes itself as "not meant for tasks that genuinely need Claude-level reasoning (architecture decisions, ambiguous requirements…)" [read].

## Hooks that steer at decision time

- **diet103/claude-code-infrastructure-showcase.**
  - A UserPromptSubmit hook matches keywords and intent regexes from `skill-rules.json`, then prints "🎯 SKILL ACTIVATION CHECK" or "⛔ MANDATORY SKILL ACTIVATION REQUIRED".
  - A PreToolUse guard on Edit/Write uses a "Two-try blocking model": the first edit attempt is blocked, the second allowed.
  - Its AI classifier "over-triggers (~1/3 of off-topic prompts in the 2026-07 held-out benchmark)", so it only suggests by default.

  [read]
- **[nizos/tdd-guard](https://github.com/nizos/tdd-guard).** PreToolUse on `Write|Edit|MultiEdit|TodoWrite` blocks the call and "explains what needs to happen instead". Its docs warn that agents route around it through the shell, and recommend denying `Bash(echo:*)`, `Bash(sed:*)` and similar [read].
- **Anthropic's example hook** redirects grep to rg with a message: "Use 'rg' (ripgrep) instead of 'grep'…" (`examples/hooks/bash_command_validator_example.py` in anthropics/claude-code) [read].

## Measured effects

The only controlled measurements found are Scott Spence's sandboxed skill-activation evals: [2026-02-08](https://scottspence.com/posts/measuring-claude-code-skill-activation-with-sandboxed-evals), Sonnet 4.5, `claude -p`, 22 prompts.

| Configuration | Run 1 activation | Run 2 | Avg latency, run 1 |
| --- | --- | --- | --- |
| None (control) | 55% (12/22) | 50% | 8.7 s |
| Simple instruction | 59% (13/22) | 50% | 8.6 s |
| Forced-eval hook | 100% (22/22) | 100% | 10.7 s |
| LLM-eval hook (Haiku pre-classifier) | 100% (22/22) | 100% | 6.4 s |
| Native prompt-type hook | 55% (12/22) | 41% | 9.6 s |

Run 1 is [checked]. Run 2 and everything below are [read].

- **Harder prompts.** On 24 of them, forced-eval reached 75% and got 5 of 5 should-not cases right. LLM-eval reached 67% with 4 false positives.
- **The forced-eval text.** The UserPromptSubmit hook says: "For each skill in <available_skills>, state: [skill-name] - YES/NO - [reason]… CRITICAL: You MUST call Skill() tool in Step 2. Do NOT skip to implementation."
- **Caveats:** only 4 skills; a 20-second cutoff that measured activation, not task quality; about 4 s of added latency.
- **His earlier post** (2025-11): a gentle "💡 Check .claude/skills/…" reminder was ignored, and a generic "INSTRUCTION: …use Skill(skill-name)" worked in 9 of 20 sessions, "basically a coin flip".

Reminders also drift. In #96326, a per-turn UserPromptSubmit hook plus CLAUDE.md still lost to recent tool output 11 times in 98 replies (language, not tool use) [read].

## Practitioner reports

- **CLAUDE.md "Mandatory Rules Consistently Ignored"** (#2544, open since 2025-06). Workarounds are a `/check-rules` command, or asking Claude to review CLAUDE.md before each task [read].
- **Skills not used** (#9716, 69 comments). The fixes are:
  - slash commands as the entry point ("No hoping Claude picks the right skill");
  - descriptions in the form "Use when: user says X, Y, or Z";
  - a routine in CLAUDE.md: "analyze the request → review the available skills → use the relevant ones → then act", skipped for trivial chat.

  #46952: activation is "closer to keyword matching". blog.fsck.com (2025-12-17): skill descriptions share a budget, and "there's no warning when you go over" [read].
- **Over-triggering is the opposite complaint.** #30355 asks for a switch to turn off skill auto-triggering, and Anthropic's guide warns current models over-trigger on aggressive wording ([vendor guidance](vendor-guidance.md#prompting-for-tool-use)) [read].
- **After compaction,** an imperative hook instruction tied to a trigger was honoured while CLAUDE.md was ignored (#95745) [read].

## Cost and quality of delegating to cheaper models

- **Anthropic's advisor strategy** and multi-agent figures are in [vendor guidance](vendor-guidance.md#delegation-economics). Aider, AgentCARD and AI21 are in [literature](literature.md#planner-executor-and-routing-economics).
- **No controlled study** was found of a Claude orchestrator handing coding work to DeepSeek, Kimi, GLM or Qwen workers. What exists are vendor or affiliate posts, e.g. MindStudio's "5-10x token cost reduction" without a method, and price tables that disagree [snippet].

## Patterns, by how much they take the choice away from the model

[inference]

| Pattern | Examples | Strength | Cost |
| --- | --- | --- | --- |
| No choice: the orchestrator cannot edit, or a gateway routes | Roo orchestrator, claude-code-router | Total | Gives up direct work entirely; Kilo dropped it |
| Own the system prompt | oh-my-openagent, plugin `agent` setting, forced output style | High | Replaces the user's setup |
| Forced per-turn decision | Spence forced-eval, oh-my-openagent's routing statement | Measured 55% → 100% for skills | Latency and tokens every turn; imperative text |
| Block at the edit | tdd-guard, two-try blocking | High for what it gates | Agents route around it through the shell; false positives |
| Injected rules at session start | superpowers, ponytail, horde today | Unmeasured; anecdotal | Decays over long sessions and compaction |
| Description wording, "use proactively" | wshobson/agents, codex-plugin-cc | Model-dependent | Over-triggering on current Claude models |
| Explicit entry point | PAL, Amp oracle, `/codex:rescue`, skills as slash commands | Total when used | The user has to ask |
