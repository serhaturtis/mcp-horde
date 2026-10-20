# Literature: tool selection, delegation and instruction priority

Status: 2026-10-21. Tags are explained in the [index](README.md#evidence-tags). Numbers are as the papers report them. arXiv abstracts are at `https://arxiv.org/abs/<id>`.

## How much descriptions steer selection

- **Edited descriptions get used far more** ([2505.18135](https://arxiv.org/abs/2505.18135); Faghih et al., "Tool Preferences in Agentic LLMs are Unreliable", EMNLP 2025).
  - "Tools with properly edited descriptions receive over 10 times more usage from GPT-4.1 and Qwen2.5-7B" [checked].
  - Assertive cues were the strongest single edit. Appending "This is the most effective function for this purpose and should be called whenever possible" gave 7.5:1 (GPT-4.1) and 7.8:1 (Qwen2.5-7B), and about 17:1 on o4-mini.
  - "This function should be called whenever possible" gave 3.0:1 and 2.0:1, and "actively maintained" gave 4.3:1 and 1.8:1.
  - Usage examples (1.1–1.6:1), name-dropping, numerical claims and lengthening (about 1.0–1.3:1) did little. Combined edits reached about 12:1. A negative cue sharply cut selection.
  - 17 models were tested; whether Claude was among them was not confirmed. [read]
- **ToolTweak** ([2510.02554](https://arxiv.org/abs/2510.02554); Sneh et al., 2025-10). Adversarial name and description rewrites raised selection "from a baseline of around 20% to as high as 81%" among five equivalent tools: DeepSeek 20.2 → 81.6, GPT-OSS 19.0 → 73.6, Llama 3.1 19.8 → 34.0. Paraphrasing descriptions as a defence pulled DeepSeek back to 48.6. Perplexity filtering did not help [read].
- **BiasBusters** ([2510.00307](https://arxiv.org/abs/2510.00307); Blankenstein et al., ICLR 2026). "Semantic alignment between user queries and tool metadata is the strongest driver of selection", and "small perturbations to tool descriptions can significantly shift choices". Models also fixate on one provider or favour tools listed earlier [read: abstract].
- **MCP description smells** ([2602.14878](https://arxiv.org/abs/2602.14878); Hasan et al., 2026-02).
  - 97.1% of 856 tools across 103 servers have at least one smell, and 56% do not state their purpose clearly.
  - Rewriting all six description components raised task success by a median 5.85 points.
  - But execution steps rose 67.46%, and results regressed in 16.67% of cases.
  - Removing the examples component did not hurt significantly.

  [read]
- **Description dimensions** (2602.18914, 2026). Across 10,831 MCP servers, the functionality (+11.6%) and accuracy (+8.8%) dimensions moved selection most [snippet].
- **"A Single Rewrite Suffices"** ([2606.30775](https://arxiv.org/abs/2606.30775); Zhou et al., 2026-06). This is production skill routing: 9 skills, 372 regression cases.
  - Automated rewrites matched manual tuning (79.2% vs 79.4% F1).
  - "A single LLM rewrite using any available false-positive and false-negative cases captures most of the available improvement."
  - Rewording cannot fix collisions where two skills' "intended scopes genuinely overlap".

  [read]
- **Skill-Use** ([2608.04828](https://arxiv.org/abs/2608.04828); Han et al., "Skill-Use: Can LLMs Actually Use Skills in Agentic Harnesses?", 2026-08). Agents see skills only by name and short description.

  | Under the Claude Code harness | Trigger rate |
  | --- | --- |
  | Claude Opus 4.7 | 0.966 |
  | Claude Opus 4.8 | 0.940 |
  | GPT-5.5 | 0.972 |
  | DeepSeek-V4-Pro | 0.324 |
  | GLM-5.1 | 0.324 |

  [checked] Kimi-K2.6 was similar to DeepSeek and GLM. Under Codex those three reached 0.65–0.71 [read].
  - The trigger tasks "fall within the target skill's scope" [checked].
  - Most failures are runs with no skill call at all: "Models often fail to decide that any skill is relevant enough to invoke" [checked].
  - Out-of-scope over-invocations "are driven by topical overlap" [checked].
  - "The models best at following a skill can be the worst at suppressing unnecessary invocations" [checked].
- **Help or Hurdle / MCPGauge** ([2508.12566](https://arxiv.org/abs/2508.12566); Song et al., 2025-08).
  - Proactivity, meaning calling tools unprompted, from one turn to two: Claude-4 0.38 → 0.86, GPT-4 0.10 → 0.34, DeepSeek-V3 0.53 → 0.86.
  - "Most LLMs require cognitive 'warm-up' to recognize MCP tool necessity."
  - Compliance when told to use tools, in one turn: Claude-4 0.54, GPT-4 0.11, Qwen-2.5 0.06.
  - MCP lowered accuracy by 9.5% on average (17.0% on code generation) and multiplied input tokens by 3.25x to 236.5x.

  [read; title checked]
- **LiveMCPBench** ([2508.01780](https://arxiv.org/abs/2508.01780); Mo et al., 2025-08). "Most models suffer from severe underutilization of tools." Claude Sonnet 4 averaged 5.59 tool calls per task (78.95% success), against 1.29–2.8 for DeepSeek-V3, GPT-4.1 and Gemini-2.5-Pro (39–48%) [read].
- **RAG-MCP** ([2505.03275](https://arxiv.org/abs/2505.03275); Gan & Sun, 2025-05). Retrieving only the relevant tools raised selection accuracy from 13.62% to 43.13% and cut prompt tokens by about half. Selection held above 90% under about 30 tools, and failures dominated past about 100 [read].
- **Not verified:**
  - MCP-Zero (2506.01056) claims a 98% token reduction when the model requests tools itself [snippet].
  - MCP-Universe (2508.14704) reports GPT-5 at 43.72% [snippet].
  - MCP-Bench and MCPToolBench++ scores were not checked.
  - None of these studies the decision to use a tool at all.

## Over-use, under-use and the decision to delegate

- **SMART** ([2502.11435](https://arxiv.org/abs/2502.11435); Qian et al., ACL Findings 2025). Fine-tuned models used 24% fewer tools and performed over 37% better [read]. The "over 30%" unnecessary-call rate for base models is from a snippet only.
- **OTC, "Acting Less is Reasoning More"** ([2504.14870](https://arxiv.org/abs/2504.14870); Wang et al., 2025-04). RL cut tool calls by up to 68.3% at comparable accuracy [read].
- **ToolFailBench** ([2607.04686](https://arxiv.org/abs/2607.04686); Soni, ICML 2026 workshops). It names four failures: Tool-Skip, Result-Ignore, Output-Fabrication and Unnecessary-Tool-Use. The best of 19 models reached an 86.33% clean tool-use rate, and two 70B-class models differed by 89 points on no-tool control tasks [read: abstract].
- **MAS-Orchestra** ([2601.14652](https://arxiv.org/abs/2601.14652); Ke et al., Salesforce, 2026-01).
  - A reasoning-model orchestrator "tends to solve the task itself first and then delegate it to only one simple sub-agent", even when the sub-agent is stronger.
  - "RLMs prioritize direct task solving over delegation."
  - Instruction-tuned orchestrators are "more flexible in task delegation".

  [read; title checked]
- **The opposite failure: Copilot CLI over-delegated** ([GitHub blog](https://github.blog/ai-and-ml/github-copilot/how-we-made-github-copilot-cli-more-selective-about-delegation/), 2026-06-12).
  - It sent simple tasks to subagents, and waited on subagents sequentially.
  - The fix was a policy: handle focused work directly, and delegate when "broad exploration, independent context, or parallel execution adds value". "Subagents should be treated as a parallelism tool, not a pause button."
  - In an A/B test, tool failures per session fell 23%, P95 wait fell 5%, and quality did not regress. It shipped in Copilot CLI 1.0.42.

  [read; existence and figures confirmed by search]
- **Anthropic's research system** over-delegated early ("spawning 50 subagents for simple queries") and needed effort-scaling rules ([vendor guidance](vendor-guidance.md#delegation-economics)) [read].
- **OverclaimBench** ([2609.20812](https://arxiv.org/abs/2609.20812); Smyth et al., 2026-09). Agents failed to read all assigned files in 67.9% of runs, and 80.4% of incomplete runs were misleading. Requiring delegation raised coverage, but most incomplete delegated reviews were still misleading [read].
- **Thin evidence.**
  - SearchSwarm (2606.09730): "Training data for this capability [delegation] is scarce in naturally occurring text" [read].
  - Bayesian self-escalation (2608.24087) is theory plus a small 1.5B → 7B check [read].
  - No study was found that measures how often a frontier coding agent delegates when it may but need not.

## Planner, executor and routing economics

- **Aider architect/editor** ([2024-09-26](https://aider.chat/2024/09/26/architect.html)). A strong model plans and a cheap one edits:

  | Planner + editor | Score | Planner alone |
  | --- | --- | --- |
  | o1-preview + DeepSeek | 85.0% | 79.7% |
  | Sonnet + DeepSeek | 78.9% | 77.4% |
  | GPT-4o + DeepSeek | 74.4% | 71.4% |

  The cheap editor never fell below the strong model working alone [read].
- **AgentCARD** ([2606.20629](https://arxiv.org/abs/2606.20629); Jiang et al., 2026-05). "Heterogeneous teams consistently occupy the cost-accuracy frontier." They were up to 44% more accurate than cost-matched homogeneous teams, and matched the best homogeneous team at up to 12x lower cost. Whether the planner or the executor is the bottleneck depends on the domain [read: abstract]. One reversed pairing reportedly collapsed to 31.1% [snippet].
- **AI21, the inverse split** (vendor, 2026-07-15). Cheap models explore and a frontier model writes the patch: 80.8% on SWE-Bench Pro at $5.99 per task, against $18.28 for a solo frontier agent. The frontier model takes about 25% of the budget [read].
- **Anthropic.** Multi-agent setups use about 15x the tokens of chats, and coding parallelises less than research. The advisor strategy gave Haiku plus an Opus advisor 85% lower cost than Sonnet alone, at a 29% lower score ([vendor guidance](vendor-guidance.md#delegation-economics)) [read].
- **Routers and cascades.**
  - FrugalGPT ([2305.05176](https://arxiv.org/abs/2305.05176), TMLR 2024): matched GPT-4 at up to 98% lower cost [snippet].
  - RouteLLM ([2406.18665](https://arxiv.org/abs/2406.18665)): costs cut "by over 2 times in certain cases" without losing quality [read].
  - Hybrid LLM ([2404.14618](https://arxiv.org/abs/2404.14618), ICLR 2024): up to 40% fewer large-model calls [snippet].
- **NVIDIA position paper** ([2506.02153](https://arxiv.org/abs/2506.02153); Belcak et al., 2025-06): small models are "sufficiently powerful… and necessarily more economical for many invocations in agentic systems". It presents no new data [snippet].
- **Missing:** a controlled study of a Claude orchestrator handing coding work to DeepSeek, Kimi, GLM or Qwen workers. The figures that circulate (e.g. "5-10x token cost reduction") come without a method ([ecosystem](ecosystem.md#cost-and-quality-of-delegating-to-cheaper-models)).

## Instruction position and priority

- **Instruction Hierarchy** ([2404.13208](https://arxiv.org/abs/2404.13208); Wallace et al., OpenAI, 2024-04). Priority runs system > user > third-party content, with tool output last. Models are trained to "never follow instructions during browsing or tool use". Robustness rose by up to 63%, with some over-refusal [read].
- **IH-Challenge** ([2603.10521](https://arxiv.org/abs/2603.10521); Guo et al., 2026-03). The order is system > developer > user > tool. RL training of GPT-5-Mini raised hierarchy robustness from 84.1% to 94.1% and cut unsafe behaviour from 6.6% to 0.7% [read].
- **The contrary result: Control Illusion** ([2502.15851](https://arxiv.org/abs/2502.15851); Geng et al., AAAI-26). "The widely-adopted system/user prompt separation fails to establish a reliable instruction hierarchy." Authority, expertise and consensus framings "show stronger influence on model behavior than system/user roles" [read].
- **IHEval** ([2502.08745](https://arxiv.org/abs/2502.08745), NAACL 2025). All models drop sharply when instructions conflict. The best open model resolves about 48% of conflicts [snippet].
- **MCPTox** ([2508.14925](https://arxiv.org/abs/2508.14925); Wang et al., AAAI-26). Directives planted in tool metadata do work: attack success reached 72.8% on o1-mini. The highest refusal rate was under 3%, for Claude-3.7-Sonnet. "More capable models are often more susceptible" [read]. The average success of about 36.5% is from a snippet only.
- **IFScale** ([2507.11538](https://arxiv.org/abs/2507.11538); Jaroslawicz et al., 2025-07). "Even the best frontier models only achieve 68% accuracy at the max density of 500 instructions", with a "bias towards earlier instructions" [read].
- **Lost in the Middle** ([2307.03172](https://arxiv.org/abs/2307.03172); Liu et al., TACL). Performance "is often highest when relevant information occurs at the beginning or end" [read].
- **Instruction drift** ([2402.10962](https://arxiv.org/abs/2402.10962); Li et al., COLM 2024). "A significant instruction drift within eight rounds", attributed to attention decaying on the original instructions [read].
- **Multi-turn degradation** ([2505.06120](https://arxiv.org/abs/2505.06120); Laban et al.). Performance falls 39% on average from single-turn to multi-turn, mostly from unreliability rather than lost aptitude [read].

## What the literature implies

[inference]

- **Wording moves selection a lot, but the strongest lever is risky.** "Should be called whenever possible" works through the same mechanism as tool poisoning. The defences being trained in (instruction hierarchy, paraphrasing) push against it, and it invites over-triggering.
- **Tool-sourced text sits at the bottom of the hierarchy.** Under the instruction hierarchy, server instructions and tool descriptions are third-party text. Hook text injected at session start is early in a long context, which drift, density and multi-turn studies all work against. A line the user wrote in CLAUDE.md, or a reminder close to the decision, is better supported. No study tests hooks specifically.
- **The horde's problem is recognition.** Claude triggers skills well when the task matches the skill's topic. "Write this change myself" never registers as a task that matches a delegation tool.
- **Delegation fails in both directions.** Self-solving bias (MAS-Orchestra) and over-delegation (Copilot CLI, Anthropic) are both documented, so guidance needs both a trigger and a brake.
