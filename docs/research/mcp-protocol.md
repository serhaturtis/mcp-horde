# The MCP protocol and other hosts

Status: 2026-10-21. Tags are explained in the [index](README.md#evidence-tags). Specification pages are under `https://modelcontextprotocol.io/specification/2026-07-28/`.

## The specification

- **The current revision is 2026-07-28**, replacing 2025-11-25: "The **current** protocol version is **2026-07-28**" ([versioning](https://modelcontextprotocol.io/specification/versioning)) [read].
- **The core is stateless.** The changelog says: "remove the `initialize`/`notifications/initialized` handshake". Every request carries its protocol version and capabilities in `_meta`, and a new required `server/discover` RPC replaces the handshake. The announcement says MCP is "transforming from a bidirectional stateful protocol into a request/response stateless protocol". Servers that need state should mint handles that are passed back as ordinary tool arguments ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog), [blog](https://blog.modelcontextprotocol.io/posts/2026-07-28/)) [read].
- **Server `instructions` moved into `DiscoverResult`.** The 2026-07-28 schema says: "This can be used by clients to improve an LLM's understanding of available tools (e.g., by including it in a system prompt)… should not duplicate information already in tool descriptions." The 2025-11-25 wording was: "It can be thought of like a 'hint' to the model. For example, this information MAY be added to the system prompt." No revision says anything about trust or priority [read].
- **Tasks are an extension now: `io.modelcontextprotocol/tasks`** (SEP-2663, Final, created 2026-04-27). It supersedes the experimental core tasks of 2025-11-25 (SEP-1686).
  - The server decides per request whether to answer with a `CreateTaskResult` (`resultType: "task"`, `ttlMs`, `pollIntervalMs`).
  - Clients poll with `tasks/get` and send input with `tasks/update`.
  - `tasks/result`, `tasks/list` and `execution.taskSupport` were removed.
  - "A task is not a higher-trust channel."
  - For stateful handles: "the server's retention policy should be stated in the creation tool's description."

  Sources: [SEP-2663](https://modelcontextprotocol.io/seps/2663-tasks-extension.md), [tasks overview](https://modelcontextprotocol.io/extensions/tasks/overview.md) [read].
- **Multi Round-Trip Requests (MRTR) replace server-initiated requests.** A server needing input returns `resultType: "input_required"` with `inputRequests` and a `requestState`, and the client retries the call with `inputResponses`. "The previous pattern of server-initiated requests is no longer supported. This is a breaking change." `notifications/elicitation/complete` and `elicitationId` were removed ([mrtr](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)) [read].
- **Sampling, Roots and Logging are deprecated** (SEP-2577), each with at least a 12-month window: "new implementations should not add support for them… integrate directly with LLM provider APIs instead of Sampling." SEP-1577, sampling with tools, is effectively a dead end [read].
- **Tools.**
  - Progress is unchanged in substance (`progressToken`, `notifications/progress`), now sent on the response stream of its request.
  - `tools/list` should come back in a deterministic order, and list results carry required `ttlMs` and `cacheScope`.
  - `structuredContent` may be any JSON value. Tools that return it "SHOULD also return the serialized JSON in a TextContent block".
  - Annotations: "clients **MUST** consider tool annotations to be untrusted unless they come from trusted servers."
  - Who controls what: tools are "model-controlled", prompts "user-controlled" and resources "application-driven". So prompts and resources are not ways to get the model to choose a tool on its own.

  [read]
- **Official extensions:** MCP Apps, OAuth Client Credentials, Enterprise-Managed Authorization, Skills and Tasks. Skills over MCP (SEP-2640, Final) adds `skills/list` and `skills/get`, with files under `skill://` URIs and digests the host must verify: "Treat skill content as untrusted input." The [client matrix](https://modelcontextprotocol.io/extensions/client-matrix) lists Skills support as partial in ChatGPT, fast-agent and Inspector, and full in mcpc. Claude Code is not in the matrix [read].
- **Progressive tool discovery is not in the protocol.** The Progressive Disclosure group was promoted to a Working Group on 2026-09-21 ("Active Exploration", no SEP). The client best-practices page recommends host-side `search_tools` once tool definitions exceed about 1–5% of the context [read].
- **The Registry** is "currently in preview" and "not intended to be directly consumed by host applications" [read].

## What Claude Code supports

| Feature | Spec (2026-07-28) | Claude Code 2.1.305 |
| --- | --- | --- |
| Server instructions | In `DiscoverResult`; MAY go in the system prompt | Loaded at session start as "# MCP Server Instructions"; cut at 4,096 characters |
| Upfront tool loading | Not specified | `_meta["anthropic/alwaysLoad"]`; tool search defers the rest |
| Progress | Unchanged | Shown in `/tasks`; kept when a call moves to the background (2.1.283) |
| Long-running work | Tasks extension | Not used. Main-thread calls move to a background task after 2 minutes; subagent and `-p` calls block. 30-minute idle window for stdio |
| `structuredContent` | Any JSON, plus a text copy | Replaces the text on success, dropped on error (#86032) |
| Elicitation | Through MRTR | Form and URL modes |
| Sampling | Deprecated | Not supported (#1785) |
| Roots | Deprecated | Supported |
| MCP Apps | Extension | Not rendered (Claude web and Desktop render them) |
| Skills extension | Final | Not in the client matrix |
| Protocol version | 2026-07-28 | Negotiated by default for stdio since 2.1.292; `MCP_PROTOCOL_NEGOTIATION=legacy` opts out |

Details and sources are in [claude-code.md](claude-code.md#mcp-tools-and-server-instructions) [read].

## Other hosts

| Host | Server instructions | Context files | Context injection | Notes |
| --- | --- | --- | --- | --- |
| OpenCode 2 | "OpenCode adds them to the system prompt"; left out if the agent's permissions deny all of that server's tools | AGENTS.md only: "OpenCode V2 recognizes `AGENTS.md` only." | No session-start event; the plugin `context` hook can "Modify assembled system instructions, messages, tools, or request options immediately before model dispatch" | Code Mode is the default for MCP tools; MCP `protocol` defaults to `legacy`; 12 h execution timeout; elicitation supported |
| Codex CLI | Read; "Keep the first 512 characters self-contained" | AGENTS.md, each file "its own user-role message" | SessionStart, UserPromptSubmit and SubagentStart hooks inject developer context (about 2,500 tokens); plugin hooks are "not automatically trusted" | `tool_timeout_sec` defaults to 60; subagents start only "after a direct request or applicable project or skill instruction" |
| Gemini CLI | "appended to the system instructions" | GEMINI.md, or AGENTS.md via `context.fileName` | SessionStart, BeforeAgent and AfterTool hooks | 10-minute default timeout; the main agent "is instructed to use specialized subagents when a task matches their expertise"; replaced by Antigravity CLI for free and Google One users on 2026-06-18 |
| Cursor | | Rules | `sessionStart` `additional_context` goes into "the conversation's initial system context"; postToolUse can inject; beforeSubmitPrompt cannot | |
| VS Code agent mode | Supported, along with elicitation, sampling, roots and MCP Apps | Instructions files | SessionStart and UserPromptSubmit `additionalContext` (Preview); can read `.claude/settings.json` hooks behind `chat.useClaudeHooks` | Read-only tools skip confirmation; the page still links the 2025-06-18 spec |
| Copilot cloud agent | Not mentioned | | `.github/hooks/*.json` with sessionStart and subagentStart `additionalContext` | "only support[s] MCP tools", no resources or prompts |

Sources:
- OpenCode: [opencode.ai/v2/docs/mcp-servers](https://opencode.ai/v2/docs/mcp-servers), [instructions](https://opencode.ai/v2/docs/instructions), [plugins](https://opencode.ai/v2/docs/build/plugins).
- Codex: [learn.chatgpt.com/docs/extend/mcp](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [hooks](https://learn.chatgpt.com/docs/hooks).
- Gemini CLI: [geminicli.com/docs/hooks](https://geminicli.com/docs/hooks/), [subagents](https://geminicli.com/docs/core/subagents/).
- Cursor: [cursor.com/docs/agent/hooks](https://cursor.com/docs/agent/hooks).
- VS Code: [code.visualstudio.com/docs/copilot/customization/hooks](https://code.visualstudio.com/docs/copilot/customization/hooks).
- Copilot: [docs.github.com hooks reference](https://docs.github.com/en/copilot/reference/hooks-configuration).

All [read]. Blank cells were not found on the pages read.

OpenCode 2's prompt order is: agent prompt → Code Mode guidance → MCP and skill guidance → AGENTS.md → config `instructions` [read]. A contradiction: OpenCode's config docs say servers return instructions "during initialization", yet 2026-07-28 has no initialization step and OpenCode's default protocol is `legacy` [read].

**Cross-host standards.** [AGENTS.md](https://agents.md/) is stewarded by the Agentic AI Foundation (Linux Foundation): "explicit user chat prompts override everything." [Agent Skills](https://agentskills.io/) uses three-stage progressive disclosure: names and descriptions at startup, the body on activation [read]. Every host above except OpenCode 2 has a session-start or per-turn injection point. OpenCode 2 has a per-model-call one instead [read].

## Trust and priority of server text

- **The official blog** ([2025-11-03](https://blog.modelcontextprotocol.io/posts/2025-11-03-using-server-instructions/)) says: "Server instructions are for explaining your tools, not for modifying how the model generally responds or behaves" [checked]. It also says "No instructions are better than poorly written instructions" and "Don't include marketing or superiority claims". Instructions are not guaranteed to be injected or followed, so critical behaviour is "better implemented as deterministic rules or hooks", and clients should let users review and disable instructions [read].
- **The blog's evaluation (n = 10 per model):**

  | Model | With instructions | Without |
  | --- | --- | --- |
  | GPT-5-Mini | 8/10 | 2/10 |
  | Claude Sonnet 4 | 9/10 | 10/10 |

  [checked]
- **The spec** says only that instructions MAY go in the system prompt. It calls annotations, skill content and task `inputRequests` untrusted. The MCP security best-practices page does not cover prompt injection through instructions or descriptions [read].
- **Inference.** In Claude Code, instructions sit in the system section. That outranks tool results, but not CLAUDE.md or the user's turn. To the model, a server's text is a third party's text [inference; see [literature](literature.md#instruction-position-and-priority)].

## What this means for the horde's servers

Repository state checked on 2026-10-21 [checked]:
- All packages use the v2 SDK (`@modelcontextprotocol/server` and `/client` 2.3.1, since 2026-10-21; it was `@modelcontextprotocol/sdk` 1.32.1 before), still on the legacy era (see below).
- Tools set annotations, including `openWorldHint: false`.
- No tool returns `structuredContent`.
- `fleet.waitFor` calls its `onTick` on every loop pass (every 1–2 s). When the client sent a `progressToken`, `horde_wait` and `opencode_wait` turn each tick into `notifications/progress`.

1. **Keep start-by-id, then wait and land.** Explicit task-id handles are what 2026-07-28 recommends for state. Adopting the tasks extension buys nothing in Claude Code, which does not use it.
2. **Long waits.**
   - On the main thread, a `horde_wait` running past two minutes becomes a background task, and its result arrives as a notification.
   - In subagents and `-p` runs the call blocks for its whole duration. The 30-minute stdio idle window then matters if no progress is sent, for example when the client sent no `progressToken`. Whether Claude Code always sends one is not documented [inference].
   - A per-server `timeout` is not extended by progress.
3. **`structuredContent`.** If it is ever added, anything the model must read (the READY/NEEDS YOU/FAILED line, the next calls) has to be inside the JSON as well. The text is not shown on success.
4. **The packages are on SDK 2, on the legacy era.** Moving to 2026-07-28 is a separate step. Do not use sampling (deprecated).
5. **Lead with the trigger.** Claude Code cuts instructions and upfront descriptions at 4,096 characters, and Codex reads the first 512 with priority. The first sentences should say when to use the server.
6. **Workers in OpenCode 2 read AGENTS.md, never CLAUDE.md.** Project guidance for workers has to come from AGENTS.md or the brief. The `context` plugin hook is OpenCode 2's per-call injection point if one is needed.

## The SDK v2 migration

Done on 2026-10-21. The findings below were tested with a v2 client over stdio in a scratch clone, not in Claude Code, except where noted [read].

**What it took:**
- The SDK's codemod (`@modelcontextprotocol/codemod`) handled the imports and wrapped raw shapes in `z.object`.
- Four fixes by hand followed:
  - `setNotificationHandler` takes the method name;
  - `z.object` in the generic tool helpers;
  - `allowImportingTsExtensions` in the test tsconfigs, because a client dependency exports a `source` condition that our `customConditions` picks up;
  - zod `^4.2.0`, because older 4.x loses `.describe()` text in tool schemas.
- **The trap.** Handlers typed with a hand-written context (`extra.signal`, `extra._meta`, `extra.sendNotification`) compile, but progress goes quiet and cancellation stops reaching the checks. Typing the context as `ServerContext` and using `ctx.mcpReq.*` fixes that. A verify test now holds both.

**The wire stayed the same.** `server.connect(new StdioServerTransport())` keeps a v2 server on the legacy (2025) handshake only. In Claude Code 2.1.305 all five servers connect and list their tools as before [checked]. The tool schemas now name JSON Schema 2020-12 instead of draft-07, and `execution.taskSupport` is gone.

**Serving 2026-07-28 too** takes `serveStdio(factory)` from `@modelcontextprotocol/server/stdio`. The factory must build a fresh `McpServer` on each call, because a probe can create one and throw it away. What that would change:
- **Elicitation.** Requests from server to client do not exist on 2026-07-28 (`Server-to-client requests are not available`). The opencode server asks the human from the background (`askPermission` / `askQuestion`, outside any tool call), so the default `user` policy would quietly hand every prompt to the orchestrator instead. A tool call can still ask, but only by returning `input_required` with a sealed `requestState`. Whether Claude Code shows those prompts was not checked.
- **Channels.** The SDK still sends `notifications/claude/channel`, but Claude Code drops them on 2026-07-28.
- **Progress, `_meta` (`anthropic/alwaysLoad`), annotations and instructions** all work on both eras.
- **Client identity.** With no `initialize` there is no `getClientVersion()`, so `defaultWait`'s Claude Code check fails, and waits drop to 50 s. The client info is in each request's envelope instead (`ctx.mcpReq.envelope["io.modelcontextprotocol/clientInfo"]`).

**The order this suggests:**
1. board, context, ledger and verify can move to `serveStdio` with little change. They use only instructions, annotations and progress.
2. opencode should stay on legacy until Claude Code delivers channels on 2026-07-28 (or the horde drops them) and its handling of `input_required` is confirmed.
