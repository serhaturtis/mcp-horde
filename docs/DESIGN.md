# mcp-horde: system design

Status: October 2026. Built: `@mcp-horde/opencode`, `@mcp-horde/core`, `@mcp-horde/verify`, gates in `opencode` (M0, M1), `@mcp-horde/board` with its worker CLI, the `horde` Claude Code plugin with its orchestration skill (M2), `@mcp-horde/context` with code context in briefs and related-test gates (M3), and the M4 refinements (one-shot asks, scopes, worktree sync, revert, saved permissions, task-bound spawns that check reports against the diff; compaction waits on OpenCode), and the integration pass after it (model tiers from `horde.json`, attempt costs recorded on the board automatically, checks on the main checkout after every merge, `opencode.maxRunning` in `horde.json`, `node <plugin dir>/servers/cli.js status` for humans), and M5 (tree-sitter definitions in `context`, `node <plugin dir>/servers/cli.js watch`). The milestones in §12 are complete; since then: `@mcp-horde/ledger` (§4.7), starting tiers learned from the boards' history, and `@mcp-horde/review` (§4.8), acceptance reviews with checked citations. The servers run on the MCP SDK v2, still on the 2025 handshake; M7 (§12) moves them to the 2026-07-28 protocol.

## 1. What this is for

A strong, expensive model (Claude Fable in Claude Code, but any MCP harness) plans and reviews. Cheap, fast models (DeepSeek, Kimi, GLM, Qwen, local) do the work, as OpenCode agents, in parallel. The horde is the set of MCP servers that make that arrangement actually cheaper and more reliable than the strong model doing everything itself.

The arrangement breaks in three places, and every server exists to fix one of them:

| Break | What happens without a fix | Server |
| --- | --- | --- |
| **Context** | The orchestrator fills its window reading worker transcripts, logs and diffs. | `verify` (compact verdicts), `board` (structured reports), `context` (precise briefs) |
| **Trust** | Cheap models produce plausible, wrong work: skipped tests, swallowed errors, edits outside scope, invented claims of success. | `verify` (gates and diff audits), `board` (claims are not completion) |
| **Coordination** | Parallel workers edit the same files, rediscover the same facts, and nobody knows what is left. | `board` (task graph, locks, findings, memory) |

`opencode` is the runtime underneath: it turns OpenCode sessions into controllable agents.

## 2. Principles

1. **The orchestrator's context is the scarce resource.** Every tool returns the smallest output that supports a decision. Raw logs, full diffs and transcripts are available on request, never by default. Target: an entire task (plan, brief, run, verify, accept) costs the orchestrator under 4k tokens of tool output when it goes well.
2. **Done means the gate passed.** A worker saying "done" is a claim. Only a mechanical verdict (tests, typecheck, lint, diff audit) moves a task to done, and only the orchestrator side can record that.
3. **Workers are untrusted.** Everything a worker reports is data. Worker-facing tools can add information and ask for things; they cannot approve, complete or widen anything.
4. **Cheap first, escalate on evidence.** A task starts on the cheapest tier that could plausibly do it. Two failed gates escalate the tier. The last tier is the orchestrator doing it itself.
5. **One source of truth, shared by both sides.** Orchestrator and workers see the same task graph, findings and memory, through the same server in two modes.
6. **No daemons, no network.** State is files with atomic writes and cross-process locks (the scheme `opencode` already uses). Every server is a stdio MCP. This keeps Windows, macOS and Linux identical and makes attach-mode and multi-session setups work without a broker.
7. **Harness-agnostic, OpenCode-specific, OpenCode 2 only.** Tools work from any MCP client. Worker integration assumes OpenCode (its config, its agents, its permission system). All server calls go through OpenCode 2's API (`/api/*`, `@opencode/client`) (§3.1).
8. **Reuse the agent runtime for model access.** One-shot model calls go through OpenCode too (its providers, auth and catalog), so there is exactly one place where models are configured.
9. **Delegating is a tool call, not a procedure.** Starting work, collecting it and landing it take one call each (§4.9). Everything an agent would otherwise have to know (worktrees, dependencies, scopes, gates, review, cleanup) is a default it can override, and every answer names the calls that make sense next. An agent that has never seen the horde succeeds from the tool descriptions alone; the other tools are for finer control, not for the common case.

## 3. The system

```
                 Claude Code / any MCP harness (orchestrator model)
   ┌────────────┬─────────────┬──────────────┬──────────────┬──────────────┐
   │ opencode   │ verify      │ board        │ context      │ ledger       │   stdio MCP servers
   │ spawn/wait │ gate/audit  │ plan/brief/  │ map/symbol/  │ stats/       │   (the `horde` plugin)
   │ steer/ask/ │ run/detect  │ accept/recall│ tests/pack   │ suggest tier │
   │ review     │             │              │              │              │
   └─────┬──────┴──────┬──────┴──────┬───────┴──────┬───────┴──────┬───────┘
         │ v2 API      │ lib         │ files        │ lib          │ reads the boards
         ▼             ▼             ▼              ▼              ▼
   opencode serve  ◄── gate runs in the agent's directory when it settles
     │  (shared, one per machine, or private per MCP process)
     │  sessions = agents, each in its own git worktree on branch horde/<name>
     ▼
   worker model (DeepSeek …) with tools: shell, edit, read …
     └── worker-side access through the shell: the `horde` CLI (board, verify, context);
         the fleet auto-approves exactly those commands (agents get no injected MCP tools)
                                              │
                                              ▼
                      ~/.local/state/mcp-horde/board/<repo>-<hash>/   (board state: tasks, findings, memory, locks, events)
```

Package dependency graph (npm workspaces, all TypeScript, Node 20+):

```
core ── context ─┬─ verify ──────────┐        (verify narrows tests with context's import graph)
                 ├─ board ─┬─ ledger │        (board puts context packs in briefs; ledger reads boards)
                 │         └─ review ┤        (review reads a task and its attempt's diff)
                 └───────────────────┴─ opencode   (gates, task-bound spawns, review_task)

plugins/horde: .mcp.json + the `horde` skill + every server above, bundled (no code of its own)
```

`opencode` depends on `board` since M4 (`opencode_spawn { task }` assigns the attempt, briefs the worker and records its workspace, model, cost and state on the board). The orchestrator still composes everything else.

### 3.1 API policy: OpenCode 2

The target is OpenCode 2: the `/api/*` endpoints served by `opencode serve`, typed by `@opencode/client` (the CLI is `@opencode/cli`; the old `opencode-ai` package stops at 1.19.3). The version is pinned (2.1.1) and `./ci.sh --latest` runs the suite against the latest release, so API changes show up before users hit them.

What the horde uses: sessions (create with `location`, `title`, `model`, `agent` and the session's own `permissions` rules; get; list; active; remove; interrupt; switch model and agent; prompt with `steer`/`queue` delivery; inbox; compact; revert stage/commit), messages, permission requests (per-session list and reply, saved rules list and remove), forms (the question tool's questions), `model`, `agent`, `location`, `server.info` (health and version), `debug.location.evict` (release a directory before a worktree is deleted) and the SSE event stream.

How each need is met:

| Need | OpenCode 2 | Handling |
| --- | --- | --- |
| health and version | `GET /api/info` | used; `/api/health` no longer exists |
| conversation state | no replayable event log (`session.log` reports `log.synced` only); messages are the projection | the tracker rebuilds turns from messages, re-reading only what follows the last `idle` marker (§3.2); events only wake waiters and show activity |
| per-agent rules (profiles, scopes, one-shot asks) | `permissions` on `session.create` | used; no agent files, no fresh-directory requirement |
| one-shot call with no tools | a session whose rules deny `*` offers no tools at all | used (§4.2c) |
| worktrees | `/api/worktree` | keep the horde's own worktrees (baseline commits, links, setup); revisit later |
| block until a session settles | `/api/experimental/session/{id}/wait` (experimental) | keep polling plus the event stream |

### 3.2 Verified facts about OpenCode 2.1.1 this design relies on

Checked against the pinned binary with a scripted mock model and against DeepSeek Flash during the port:

- **The API needs a password.** Without `OPENCODE_SERVER_PASSWORD` only `/api/info` answers; everything else is 401. Paths outside `/api` serve the web app (HTML, 200), so a health check must use `/api/info`. `opencode serve` prints `server listening on <url>`. A missing session is a 404 `SessionNotFoundError`.
- **A run is a prompt, steps, and an `idle` marker.** Prompts go through an inbox (`session.prompt` returns the inbox item; the user message keeps its id). A run ends with an `idle` message whose `outcome` is `succeeded`, `failed` or `interrupted`, with a structured error (message, provider status). A prompt steered or queued while a run is going is delivered inside the same run, before its `idle` marker. Assistant messages carry cost, tokens, finish and their file snapshot.
- **Config from OpenCode 1 is translated** (`provider`, `permission`, `variants`). Models without variants get default `low`/`medium`/`high` ones unless their config sets `variants: {}`. The default permission rules allow everything; OpenCode asks only where a rule says `ask`.
- **Agent markdown files in the OpenCode 1 format are not loaded** (`.opencode/agent/*.md` nor `.opencode/agents/*.md`). Session rules replace them: rules are matched last-first after the agent's; a session denying `*` is offered no tools; denying `*` and allowing `read` and `grep` offers exactly those; `edit` denied outside a glob makes an outside write fail with "Permission denied: edit" (with `ask`, it becomes an `edit` permission request).
- **Tools:** `shell` (no longer `bash`), `edit`, `write` (takes `path`), `read`, `glob`, `grep`, `question`, `skill`, `subagent`, `webfetch`, `websearch`, `execute`. A shell permission request has action `shell`, the command as its resource and the proposed "always" pattern in `save`.
- **Questions are forms** (`frm_…`): one field per question (`description` is the question, `options` have values and labels, `custom` allows free text); the reply maps field keys to values.
- **Revert:** `revert.stage { messageID, files: true }` undoes that message and everything after it (OpenCode 1.19 kept it), and restores the files; the staged diff lists them. Undoing a turn therefore stages at the turn's own prompt.
- **Compaction works:** it runs as an inbox item and leaves a `compaction` message, `completed` or `failed` (a summary that does not follow OpenCode's template fails).
- **MCP:** a server injected through `OPENCODE_CONFIG_CONTENT` connects, but its tools are not offered to agents directly (a canary test watches this), so workers keep the CLI (§4.2e).
- **Live:** DeepSeek Flash ran the parallel-agents scenario, a checked JSON answer and the full loop (brief → worktree → gate pass → report through the CLI) in about 30 s.

## 4. Package designs

### 4.1 `@mcp-horde/core` (library, not a server)

Shared by every package. Extracted from `opencode`, which currently owns these:

- `Store`: one JSON file per entity, atomic write (tmp + rename, EPERM retry on Windows), `update()` deleting `undefined` keys.
- `lock(name, fn)`: cross-process lock with heartbeat, stale takeover, and release-only-your-own.
- Process helpers: `killTree`, detached spawn, `pidAlive` (EPERM counts as alive), supervisor pattern.
- Paths: XDG state/data dirs, `projectKey(repoRoot)` (hash of the real path), `horde.json` loader (§5).
- Rendering: `truncate`, `truncateHead`, `formatUsd`, `formatTokens`, `estimateTokens` (chars/4), a `Budget` helper that trims a list of sections to a character cap keeping the most important first.
- Git helpers from `worktree.ts` that are not worktree-specific: `gitRaw` with `GIT_TERMINAL_PROMPT=0`, timeouts, `repoRoot`, `changedFiles(base)`, `-z` parsing.

Internal package: a library the servers share, with no stability promise of its own.

### 4.2 `@mcp-horde/opencode` (exists) and its planned extensions

What exists is documented in `packages/opencode/README.md`. The design pass adds five things, in priority order.

**a. Gates (`gate` option on `opencode_spawn` and `opencode_message`).**
```
gate: { checks?: string[], audit?: boolean (default true), max_rounds?: number (default 2), related_only?: boolean (default true) }
```
When the agent settles idle, the fleet runs `verify.gate()` in the agent's directory (library call, no second MCP round trip). On failure it sends the compact verdict back to the agent as a steer ("these checks fail; fix them; do not skip or weaken tests") and the agent runs again, up to `max_rounds`. The snapshot gains `verdict: {pass, blockers, warnings, rounds}` and the state rendering shows `IDLE ✓ gate` or `IDLE ✗ gate (2 rounds)`. `opencode_wait` with `gated: true` only reports agents whose gate is decided. This is the single biggest token saver: the worker fixes its own failures without the orchestrator in the loop.

Gates only run when the agent is idle, so they never race the agent's edits. Outside a worktree the gate runs in a shared directory the human may also be editing; the README says so and the default for `isolation: "none"` is `audit: false`.

**b. Scope (`scope` option).**
```
scope: { paths: string[], outside: "deny" | "ask" (default "deny") }
```
The session gets `edit` rules: `*` as `outside`, then the scope paths `allow` (the last match wins). Works with or without a worktree. With `"ask"`, an out-of-scope edit surfaces as a permission request the orchestrator (or the human) answers; with `"deny"`, OpenCode refuses it and the model is told why. `verify_audit` independently reports out-of-scope changes in the diff, so an agent without a scope is still caught after the fact. (`edit` covers OpenCode's edit/write/patch tools; shell commands can still write files. The audit is the backstop for that; a `shell` rule set that denies `>`/`tee`/`sed -i` is not attempted because it is unenforceable in general.)

**c. One-shot calls (`opencode_ask`).**
```
opencode_ask { prompt, model?, variant?, files?, schema?: JSONSchema } → text | JSON
```
Runs as a session in the project whose rules deny every tool, so the model is offered none; the instruction to answer directly travels with the prompt. The call creates the session with the requested model, sends one prompt, waits for the answer, returns the text with its cost, and deletes the session. OpenCode's free tier refuses sessions without tools (403 `FreeTierError`), so on that error only a second rule set keeps `read`, `grep` and `glob` (and the "deny" policy still refuses anything that asks). With `schema`, the prompt asks for JSON matching the schema, the reply is parsed and validated client-side, and one retry with the validation error is attempted before giving up. No agent loop, no worktree. Uses: classification, summarizing a long log or diff for the orchestrator, judging between candidates, drafting a brief. Best-of-N is `opencode_spawn` ×N + `verify` + `opencode_ask` as judge; the skill describes it rather than a dedicated tool.

**f. Context management (`opencode_compact`, context in status).** Long tasks on small-context models hit the window. `session.context` gives the usage; the snapshot shows it (`ctx 71%`) so the orchestrator can see a worker about to lose its thread; `opencode_compact` calls `session.compact` on an idle agent before messaging it again. The skill's rule: compact instead of re-spawning when the task is mid-way and the worktree holds good work.

**g. Undo a turn (`opencode_revert`).** `session.revert.stage` to a message id rolls the worker's files back to that point and marks the later messages reverted; `revert.commit` makes it permanent, `revert.clear` abandons it. `opencode_revert { id, to?: messageID }` defaults to the start of the last turn. Cheaper than discarding a worktree when one bad turn ruined a good run, and it keeps the worker's context consistent with its files, which a manual `git checkout` would not.

**h. Saved permission rules (`opencode_permissions`).** An "always" reply saves a rule in OpenCode. `opencode_permissions { action: "list" | "remove", id? }` shows and removes those rules so the orchestrator can see what has been permanently allowed for a project and undo it.

**d. `opencode_worktree action: "sync"`.** Merges the base branch into the agent's branch inside the agent's worktree, so conflicts with other merged work land where a cheap model (with a gate) can resolve them, instead of at the orchestrator's merge. Refused while the agent is running; after a sync the skill says to message the agent "resolve the conflicts and run the gate".

**e. Worker access to the horde (revised in M2).** Agents are not offered injected MCP tools (§3.2), so workers reach the board, verify and context through a `horde` CLI they run with the shell tool; the brief contains the exact command. The fleet auto-approves a `shell` permission request only when the command is exactly that CLI with plain arguments (a shell-word check rejects `;`, `&&`, `||`, pipes, redirects, `$`, backticks and newlines anywhere outside single quotes), whatever the agent's policy, so board plumbing never prompts the human and a hijacked worker cannot chain anything onto a trusted command. Since the review pass the command must also name the board of the agent's own repository (so a worker cannot create board files elsewhere or read another repository's notes), quoted text may hold no control characters, and agents adopted from a human's TUI get no auto-approval at all. No MCP servers are injected into OpenCode: the brief carries the CLI command, and the canary test in §3.2 watches for agents gaining tools.

Also built: the snapshot shows a `task:` line when a board binding exists (§10); the running limit is `opencode.maxRunning` in `horde.json`, with `HORDE_OPENCODE_MAX_RUNNING` as override (default 8, 0 = unlimited); a task-bound spawn without `model` takes the model and variant of the task's tier; `opencode_worktree merge` runs the project's checks (no audit) in the main checkout after merging and reports the verdict (`check: false` skips it).

**Outcome delivery.** `horde_do` returns when the worker starts, so nothing is pushed when it finishes; the orchestrator calls `horde_wait` right after starting. In Claude Code a wait longer than two minutes moves to the background, and its result arrives as a task notification when the first outcome is ready. The server keeps a per-session news file at `<stateDir>/news/<session>.json` (`HORDE_OPENCODE_STATE_DIR`, else `$XDG_STATE_HOME/mcp-horde/opencode`, else `~/.local/state/mcp-horde/opencode`) with `{ pid, at, waiting: [{ id, title, kind: "finished" | "needs you" }], working: [{ id, title }] }`, written when an agent settles, an outcome is reported, an agent is disposed or a task starts, and removed at shutdown. Two plugin hooks (`plugins/horde/hooks/news.mjs`) read it: `Stop` refuses the stop once while outcomes sit unread, naming them with a ready `horde_wait` call (not when a `horde_wait` already runs in the background, and never a second time in a row), and `UserPromptSubmit` puts the same line next to the user's next prompt, plus the ids still working. Push delivery stays off by default: with `HORDE_OPENCODE_CHANNEL=1` the server declares the `claude/channel` capability and sends `notifications/claude/channel` when an agent settles (`packages/opencode/src/hooks.ts`), which Claude Code shows as a `<channel source="…">` message; channels are a research preview in which only allowlisted official plugins register, so the horde needs the dev flag (§11).

### 4.3 `@mcp-horde/verify`

Mechanical judgement with a compact verdict. Library + MCP server; both orchestrator and workers mount it (workers so they can run the gate themselves before reporting).

**Tools**

- `verify_detect { directory }` → the checks that would run: from `horde.json` `verify.checks`, else auto-detected: `package.json` scripts (`test`, `typecheck`, `lint`, `build`), `pyproject.toml`/`pytest.ini`/`setup.cfg` (pytest, ruff, mypy), `Cargo.toml` (`cargo test`, `cargo clippy`), `go.mod` (`go test ./...`, `go vet`), `Makefile` targets named `test`/`lint`. Output is one line per check.
- `verify_run { directory, checks?, related_to?: string[] (changed files), timeout_seconds?, budget_chars? }` → per check: `PASS 12s` or `FAIL 9s` plus extracted failures. With `related_to`, test commands are narrowed to the tests `context` maps to those files (transitively through imports) when every changed file is covered and the runner supports path arguments (built in M3: pytest, jest, vitest, `go test ./...` by package, and an npm `test` script that is a plain jest/vitest call; node:test script file lists and cargo are not narrowed); otherwise the full suite runs, and the verdict says which and why.
- `verify_audit { directory, base }` → findings over `git diff base...HEAD` plus the working tree:
  - scope: files outside `allowed` globs (from the task, or `horde.json`)
  - tests: deleted test files, `.skip`/`.only`/`xit`/`@pytest.mark.skip` added, assertions removed (count of `expect(`/`assert` lines lost per test file), snapshot files rewritten wholesale
  - suppressions: `@ts-ignore`, `@ts-expect-error` without a reason, `eslint-disable`, `# type: ignore`, `# noqa`, `as any`, `unknown as`, empty `catch {}`, `.catch(() => {})`
  - dependencies: manifest or lockfile changes, new packages named
  - binaries: added or changed files with binary content, and files grown past 1 MB (lockfiles excepted); paths matching `generated` are exempt
  - secrets: secret-looking strings (common key prefixes, private key headers)
  - git: merge commits on the branch, commits that touch only `.horde`/`.opencode`
  Each finding has `severity: block | warn`, a file, a line when known, and one line of text. Which categories block, warn or are off is configurable (`horde.json` `verify.audit`); defaults: scope, test deletion/skips, secrets and binaries block; suppressions, dependency changes and merge commits warn.
- `verify_gate { directory, base, checks?, related?, allowed?, budget_chars? (default 1500) }` (`related` derives the changed files from `base`) → `PASS` or `FAIL` with `blockers` (failing checks, blocking audit findings) and `warnings`, rendered within the budget. This is what `opencode` calls.
- `verify_logs { directory, check }` → the last run's full output for one check, head-truncated to a requested size. Available, never automatic.

**Output extraction without a model.** Per-runner extractors run on captured stdout+stderr: TAP (`not ok` blocks with their YAML), jest/vitest (`●`/`FAIL` blocks, `AssertionError`, `expected`/`received` lines), pytest (`FAILED path::test - message` and the `E ` lines), cargo (`---- name stdout ----` to `failures:`), go (`--- FAIL` to the next `===`), tsc (`path(line,col): error TSxxxx`), eslint/ruff/biome (path:line rule lines), generic (`Error:`/`Traceback`/`panicked at` with 6 lines of context). Each failure keeps: the test or file name, the assertion text (up to 300 chars), and the first stack frame inside the project (not `node_modules`, not `node:internal`). Fallback when nothing matches: the last 40 lines. Counts are always exact (`14 failed, 212 passed`) even when details are truncated. For logs that still exceed the budget, the skill's option is `opencode_ask` with a cheap model summarizing them: cheap compresses for expensive.

**Execution.** Each check runs through the shell in the directory with a timeout (default 600 s, from config), in its own process group, killed as a tree on timeout or abort; `OPENCODE_SERVER_*` and `HORDE_*` are stripped from the environment; `CI=1` is set; output is capped at 8 MB per check with the head and tail kept. Within a task the checks run one after another, in the order listed (shared `node_modules`, ports); across tasks, `slots` caps how many runs of one check overlap and checks naming the same `exclusive` resource run one at a time.

**Cache.** A verdict is keyed by (directory, HEAD, working-tree hash, checks). A passing verdict on an unchanged tree is served from the cache instantly; a failing verdict is never cached and is re-run on the same tree (a failure may be the environment's). `opencode_wait` polling never re-runs passing tests.

### 4.4 `@mcp-horde/board`

The shared task graph. One MCP server for the orchestrator, and the plugin CLI over the same library for workers (§4.2e). State in `~/.local/state/mcp-horde/board/<repo>-<hash>/`: `tasks/<id>.json`, `findings.jsonl`, `memory.jsonl`, `locks/<slug>.json`, `events.jsonl`. Every process (one orchestrator, one CLI per worker command) shares it through `core`'s store and locks.

**Task record**
```ts
{
  id: "t-7k2",               // short, stable
  title, goal,               // goal: one paragraph, what and why
  acceptance: string[],      // observable criteria; the gate checks what it can, the orchestrator the rest
  scope: { paths: string[] },
  deps: string[],            // task ids that must be done first
  status: "todo" | "ready" | "claimed" | "working" | "review" | "done" | "failed" | "blocked",
  tier: number,              // index into horde.json tiers; raised on escalation
  attempts: [{ n, agent, session, model, startedAt, endedAt?, verdict?, cost? }],
  reports: Report[],         // from the worker, see below
  questions: [{ at, text, answer? }],
  cost: number,              // sum over attempts (task-bound agents record theirs as they settle; accept/fail may override)
  parent?: string,           // epic / feature grouping
  token: string,             // the worker quotes it; weak identity, not security
  createdAt, updatedAt
}
```
`Report` (worker-filed, ≤ 2k chars total): `{ summary, filesChanged[], testsAdded[], decisions[], questions[], unverifiedClaims[], confidence: low|medium|high }`. `unverifiedClaims` is where the brief tells the worker to put anything it did not actually run or check. The orchestrator reads reports; it does not read transcripts unless a gate failed twice.

**Orchestrator tools**
- `board_plan { tasks: [{title, goal, acceptance, scope, deps(by title or id), tier?, parent?}] }` → ids, plus warnings for overlapping scopes and dependency cycles.
- `board_next { limit? }` → ready tasks (all deps done, unclaimed), one line each.
- `board_brief { id, agent?, budget_tokens? (default 6000) }` → the full worker prompt: goal, acceptance, scope, the reporting protocol (file a report with the CLI before finishing; put unverified work in `unverifiedClaims`), relevant findings and memory (tag and path overlap), and a `context.pack()` of the scoped files, trimmed to the budget. The orchestrator passes this to `opencode_spawn` unchanged.
- `board_accept { id, note?, cost? }` / `board_fail { id, reason, escalate?, retry?, cost? }` / `board_block { id, on }` / `board_edit { id, title?, goal?, acceptance?, scope?, tier?, status? }` (renames, re-scopes, raises the tier, reopens a blocked or failed task).
- `board_summary { }` → ≤ 1500 chars: counts by status, running tasks with their agents, blocked tasks and why, unanswered worker questions, cost so far, next ready tasks, held locks.
- `board_task { id, detail?: "brief" | "full" }` → one task; `full` includes reports and attempts.
- `board_findings { paths?, tags? }`, `board_remember { text, tags?, paths?, confidence? }`, `board_recall { query?, tags?, paths? }`, `board_forget { note }`.
- `board_unlock { path }` (orchestrator can break a worker's lease; locks also expire 30 minutes after the worker's last activity).

**Worker commands** (`node <plugin dir>/servers/cli.js` over the same library; see §4.2e for why not MCP tools today. Each item below is a subcommand: `task <id> <token>`, `progress <id> <token> "<note>"`, `report <id> <token> --summary "…" …`, `finding "<text>" --paths a,b`, `findings`, `recall "<query>"`, `lock|unlock <id> <token> <paths…>`.)
- `task { id, token }` → the task as the worker should see it (goal, acceptance, scope, open questions' answers), never other tasks' internals beyond titles.
- `progress { id, token, note }` → one-line status, renews the lease.
- `report { id, token, report }` → files the structured report; status becomes `review`. Does **not** complete the task.
- `finding { text, tags?, paths? }` → shared fact ("the auth middleware expects `req.user` set by …"). Findings are capped (500 chars) and deduplicated by hash.
- `findings { tags?, paths? }` and `recall { query }` → read shared facts and project memory.
- `lock { paths, id, token }` / `unlock { paths, id, token }` → advisory leases (TTL 30 min, renewed by `progress`). `lock` fails with the holder's task id if another task holds the path; the brief tells the worker to lock before touching anything outside its scope and to report instead of fighting over a lock.

Worker questions go through OpenCode's own question tool (they already surface as `needs_input` on the parent agent in `opencode`), so the board has no `ask`.

**Memory.** Entries `{ id, text, tags, confidence, source: {task, attempt}, createdAt, verifiedAt? }`. `board_recall` ranks by tag and path overlap, then recency. The brief includes memory under a "Project notes" heading with the caveat that notes may be outdated.

**Events.** Every mutation appends to `events.jsonl`. `board_summary` prints the summary for the orchestrator; the plugin CLI's `status` and `watch` (`node <plugin dir>/servers/cli.js status|watch`) show the board to people (§10.13).

### 4.5 `@mcp-horde/context`

Precise briefs instead of exploration. Fast models are weakest at navigating large codebases and spend most of their tokens doing it; the orchestrator should not spend its tokens doing it for them either. Library + MCP; mounted by both sides.

**v1 (built in M3, no native dependencies):** git's file list (so `.gitignore` applies) scanned in-process with content-keyed caches, plus language-aware regexes for definitions, block extents and imports in TypeScript/JavaScript, Python, Go, Rust, Java/Kotlin, C#. Ripgrep turned out unnecessary at this size (a 100-file repository maps in ~25 ms, a full pack with the import graph in ~0.5 s); it stays an option if large monorepos need it. Import resolution includes workspace packages by name, so monorepo tests are linked to the packages they exercise. **v2 (built in M5):** tree-sitter via `web-tree-sitter` (WASM, portable; prebuilt grammars vendored gzipped, 1.3 MB with the runtime) for definitions and their extents, and comment/string spans so references in them are not counted. Every server that builds context (context, board, verify, opencode) loads the grammars once at startup (~60 ms); the patterns stay as the fallback for a missing grammar and for the regions of a file a syntax error breaks. Call sites are still matched by name: telling same-named functions apart needs type information, which is a non-goal.

**Tools**
- `context_map { directory, depth?, budget_chars? }` → directory tree with file counts and languages per directory, entry points, manifests, test directories, the project's own instructions files (`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`) listed, not inlined.
- `context_find { query, kind?: "definition" | "reference" | "text", paths?, limit? }` → `path:line  one-line match`.
- `context_symbol { name, path? }` → definition with signature and doc comment, the enclosing file, and call sites (count plus the first N with one line each).
- `context_file { path, lines?: "a-b", symbols?: string[], budget_chars? }` → an excerpt with line numbers; with `symbols`, only those definitions.
- `context_imports { path, direction: "in" | "out" }` → files this file imports, or files importing it.
- `context_tests_for { files: string[] }` → test files that cover them: naming conventions (`x.test.ts`, `test_x.py`, `x_test.go`), directory mirrors (`src/a/b.ts` → `test/a/b.*`), and tests that import the file (through re-exporting index/lib files; `verify` follows imports transitively). Used by `verify` for related tests.
- `context_pack { goal, files?, symbols?, scope?, budget_tokens }` → an assembled brief section: the scoped files' excerpts (whole file when small, signatures plus relevant regions when large), the symbols the goal mentions with their definitions, the tests that cover the scope, and the conventions section (the first 60 lines of the project's instructions files). Sections are ranked (scope files > named symbols > tests > conventions) and trimmed to the budget with the `core` `Budget` helper.

**Conventions file.** `horde.json` `context.ignore` extends `.gitignore`; `context.entrypoints` names files always worth listing.

### 4.6 The `horde` plugin and its skill (no code of its own)

Distribution and procedure. A plugin directory with:

- `.mcp.json` registering `opencode`, `board`, `verify`, `context` and `ledger`, each started with `node ${CLAUDE_PLUGIN_ROOT}/servers/<name>.js`: self-contained bundles generated from the packages (`npm run bundle`, checked by `ci.sh`), so the plugin needs no npm. The packages are not published.
- `skills/horde/SKILL.md`: the orchestration procedure the strong model follows. Plan with `board_plan` (small tasks, each with observable acceptance and a scope), then `ledger_suggest { apply: true }` for starting tiers. For each ready task: `opencode_spawn { task }` (brief, worktree, scope and gate from the board; model from the task's tier) → `opencode_wait` (gated) → `review_task` on a pass → read the review and the report (checked against the diff), not the transcript → `opencode_worktree merge` in dependency order (the project's checks then run on the merged checkout) → `board_accept`, or `board_fail` with escalation. Escalation: two failed gates raise the tier; the top tier is "do it yourself". Best-of-N for hard, well-specified tasks: spawn N on cheap tiers, gate filters, `opencode_ask` judges the survivors' diffs. Steer with `opencode_message` when a worker drifts; never let a worker run more than `limits` allow. What not to do: reading transcripts before a gate has failed twice, re-briefing from memory instead of `board_brief`, merging without a gate.
The skill also explains the tier table users edit (`horde.json` `tiers`, §5).

### 4.7 `@mcp-horde/ledger` (built after M5)

The board already records every attempt's task (kind of work, scope), tier, model (recorded by `opencode` for task-bound spawns), gate rounds, cost and outcome; nothing read that history back, so tiers were chosen by guesswork. The ledger closes principle 4 ("cheap first, escalate on evidence") with measured evidence:

- `ledger_suggest { ids? | draft?, apply? }`: the cheapest tier that similar work has not shown to fail. Similar work: the same area of the same repository (scope directories, two levels), then the same kind (test, fix, refactor, docs, build, feature, from the title/goal); other repositories count by kind at half weight. A tier is skipped only when similar work passed on it under 40% of the time with at least two weighted attempts; otherwise tier 0 stands. `apply` raises untried tasks' tiers, never lowers them. History is matched to today's tiers by model.
- `ledger_stats { by: model | tier | kind | area | repo, all_repos?, since_days? }`: accepted/attempts, mean gate rounds, cost per accepted task (failed attempts' spend counts against the accepted ones), and a drift warning when a model's last 10 attempts pass clearly less often than its history.

A library plus a small server with no store of its own, so it is always consistent with the boards. It reads them directly (`ledger → board`), with one write path: `ledger_suggest { apply: true }` raises the tier of open, untried tasks through the board's own `edit` (under the board's lock, recorded in `events.jsonl` like any edit), and never lowers a tier. Keeping that write in the ledger saves the orchestrator one `board_edit` per task; the cost is that the board's tiers can change from a second server, so anything reasoning about who mutates a board should count `ledger` alongside `board`, `opencode` (assignments, workspaces, activity, reviews) and the worker CLI. The skill calls `ledger_suggest { apply: true }` right after `board_plan`.

### 4.8 `@mcp-horde/review` (built after M5)

The gate proves the code builds and its tests pass; it cannot tell whether the change does what the task asked, so the orchestrator still read reports and diffs. `review_task { id, models? }` (in `opencode`, which owns the models; the logic is the `review` library) gives each acceptance criterion to a cheap model with the attempt's worktree diff (new-file line numbers, touched definitions, a budget that lists what it leaves out) and asks for met / not met / unclear with cited lines, as checked JSON through `opencode_ask`. Every citation is then checked against the lines the diff shows: a "met" without a real line becomes "unclear", invented citations are dropped and counted, a skipped criterion is "unclear". The default reviewer is the cheapest tier model other than the worker's, else the worker's own; several models cross-check and list disagreements. The first reviewer's outcome is kept on the attempt and shown by `board_task`.

### 4.9 The simple path: `horde_do`, `horde_wait`, `horde_tell`, `horde_land`, `horde_drop` (M6)

**The vision.** Delegating coding work should feel like calling a subagent: one call to start it, one to collect it, one to take it. An agent that has never seen the horde must succeed from the tool descriptions alone, with no skill, README or inspection, and must never be left with a broken branch or a dead end. The full flow (§6) took nine calls across four servers per task, plus knowledge the agent could only get by reading the code: link the dependencies into the worktree, re-pass the scope, pick a reviewer, verify by hand what the reviewer could not see. All of that becomes a default.

**Five verbs** in the `opencode` server (it owns the fleet, and already uses the board, verify and review libraries). A task id (`t-…`) is also the worker's name.

| Call | Does |
| --- | --- |
| `horde_do { goal, done?, scope?, title?, model?, variant?, directory?, wait? }` | Plans one board task and starts a worker on it with the defaults below. Returns the id at once (`wait: true` blocks until the outcome, like a subagent). |
| `horde_wait { ids?, timeout_seconds? }` | Returns every outcome that is ready, each once; if none is, blocks until the first. |
| `horde_tell { id, message?, approve?, model?, scope? }` | Answers what the worker waits on (a question: `message`; a permission: `approve`, and a `message` alone refuses it with that instruction), or asks for changes (a new round of work and checks). While it works, the message steers it. `model` switches it first (escalation without losing its context); `scope` replaces the task's scope (its session rules, the audit and the board together), so an edit refused outside the scope is one call, not a new task. Approving never widens the scope. |
| `horde_investigate { question, want?, focus? }` | Starts a read-only worker in its own worktree (no checks, no audit, no review gate) that answers with JSON findings citing file:line; the citations are checked against the worktree, the report is saved under the horde's state directory, and `horde_wait` returns it as REPORT. Nothing lands. |
| `horde_land { id, message? }` | Takes a READY task's work atomically (below), marks the task done, removes the worktree and branch. After a failed landing and a fix, it is called again. `message` lands the work as one commit with it. |
| `horde_drop { id, reason? }` | Stops the worker, fails the attempt on the board (the ledger learns from it), removes the worktree and branch; the answer names the last commit. |

**Outcomes.** Each is a compact block that ends with the calls that make sense next, so the agent never has to look up what to do:

- **READY**: the checks' verdict, the review in words ("3 of 4 criteria met, 1 unclear"), whether the report matches the diff, each check that fails where the task started too ("⚠ test fails at 1a2b3c4d where the task started too (not caused by this work)"), the files changed with line counts, the worker's one-line summary, each undecided criterion with a ready-made `horde_tell` to have it proven (so the agent is not pulled back into the diff), cost, time, model → `horde_land` · `horde_tell` · `horde_drop`.
- **NEEDS YOU**: the question with its options, or the command or edit it asks permission for → `horde_tell`.
- **FAILED**: why (the checks' verdict after the last round, an error, a limit), the edits it was refused outside its scope, the files it changed with a short excerpt, the worker's last words, the `git diff` command for the whole change, and the next tier's model when there is one → `horde_tell` (a hint, or `model` to escalate) · `horde_drop`.
- **WORKING** (a wait that timed out): elapsed time, cost and the current activity per worker.

**Defaults the agent no longer chooses.**
1. Always a worktree, on branch `horde/<id>`.
2. Dependencies: `horde.json` `"workers": { "link": [...], "setup": "…" }` when present (with a `setup`, only what `link` names is linked: `npm ci` in a worktree empties a linked `node_modules`, reproduced); otherwise every untracked dependency directory git ignores in the checkout (`node_modules` anywhere, `.venv`, `venv`) is linked, except one that points back into the checkout: a `node_modules` holding workspace packages (with every other `node_modules` of that install) or a virtualenv with an editable install. Linked, those run the checkout's code in the worktree, and `uv run` there repoints the checkout's own environment at the worktree (both reproduced); the worktree notes name what was left out, for `workers.setup` to install.
3. The task's scope confines edits (session rules, outside denied) as well as the audit, for every task-bound spawn.
4. The model is the task's tier from `horde.json`, else OpenCode's default model; the answer says which.
5. The gate is the project's checks, the audit and the **review**: once the checks pass, a reviewer model (the first tier other than the worker's, else the worker's own) judges each criterion with cited lines, and it sees the checks' verdict, so "tests pass" can be met by citing a passed check. A criterion it finds not met goes back to the worker like a failing check while rounds remain (2 by default); criteria it cannot decide become "check yourself" lines.
6. Questions from the worker come to the caller (they are about intent); permission requests follow the configured policy.

**Landing never breaks your branch.** `horde_land` rebases the task's own commits onto your current branch's tip *inside its worktree*, leaving out the commit that carried your uncommitted changes over (they stay uncommitted in your checkout), records that exact commit, runs the project's full checks on it, and commits nothing in the worktree afterwards: files the checks write never land. Only if the checks pass, and your branch is still at that tip (checked under a lock per repository, so parallel landings cannot combine unchecked), is your branch fast-forwarded to the judged commit: the commits that were checked are the commits you get, hashes included, so files that name commits of their own history stay true. If the branch moved, the loop rebases onto the new tip and checks again. A conflict or a failing check leaves your branch untouched; the worker is now on top of your branch and can fix it after a `horde_tell`, and when it rebases its branch itself, the recorded base follows. Uncommitted changes in your checkout stay where they are; a fast-forward they would collide with is refused and names them. A check that fails on your branch's tip too, with the same failures, does not block landing; the answer names it. With `message`, the task's own commits are squashed into one commit with it before the checks, and the repository's commit-msg hook (the user's copy, found as git would, `core.hooksPath` included) judges it with the changes staged, as it would the user's own commit; a refusal changes nothing and shows the hook's output. Workers commit through the repository's hooks themselves; in a repository with a commit-msg hook the horde does not commit their leftovers with `--no-verify`: a gate round with uncommitted changes goes back to the worker, and landing refuses them.

**Failures the work did not cause.** A broken branch, or a check that judges the clock or another run's records, would otherwise fail every task, send each worker after something it cannot fix, and push it up the tiers. So when a check fails, `verify` runs the same commands once more in a throwaway worktree of the commit the task started from (before landing: of your branch's tip), prepared like any task's, and compares the failures by test and file, or by first message line, with digits masked. A check whose failures all happen there too, and no more of them, passes with a warning. One with new failures still fails, showing only the new ones. The comparison is shared by every task on that commit for 15 minutes.

**What stays.** The 47 other tools remain for what the simple path does not cover: multi-task plans with dependencies (`board_*`), best-of-N, steering in the middle of a step, transcripts, saved permissions, one-shot asks, code search and checks for the agent's own work (`context_*`, `verify_*`). Their descriptions say when to prefer `horde_do`. The server instructions lead with the five verbs, and the skill shrinks to the judgement calls (how to write a goal, when to split work, when to escalate).

**Measured, not assumed.** The design was checked on paper before any code: two fresh agents, given only the tool list, these descriptions and sample outputs, planned two tasks, a question, a permission request, a failure and a broken landing. The first scored it 7/10 against a plain subagent call and found that landing could leave the branch broken and that failures sent it outside the five tools; both were fixed (atomic landing, FAILED outcomes with the change and the refused edits, `model` on `horde_tell`). The second scored the revision 8/10 ("each output told me the next call") and found one dead end left, a scope that cannot change once the task runs, now `scope` on `horde_tell`. Both found the other tools noise; they stay visible because they are real capabilities (a plain `opencode_spawn` has no task, worktree or gate), and hiding them is the next step if the live test shows an agent reaching for them. It is done when a fresh agent with only the plugin installed delegates a real task in this repository in three calls (`horde_do`, `horde_wait`, `horde_land`) without reading anything else.

**Not in the simple path yet:** dependencies between tasks (land one, then `horde_do` the next), per-task budgets (`opencode_spawn` `limits`), several workers on one task.

## 5. Configuration: one `horde.json`

At the repository root (optional; everything auto-detects without it):

```json
{
  "opencode": { "maxRunning": 8 },
  "tiers": [
    { "model": "deepseek/deepseek-v4-flash", "variant": "high" },
    "moonshotai/kimi-k3"
  ],
  "verify": {
    "checks": {
      "test": "npm test",
      "lint": "npm run lint",
      "pg": { "command": "uv run pytest tests/pg", "cwd": "api", "env": { "AUTH_PROVIDER": "local" }, "when": "land", "slots": 2, "exclusive": "dev-stack" }
    },
    "timeoutSeconds": 600,
    "audit": { "warn": ["binaries"], "generated": ["dist/**"] }
  },
  "context": { "ignore": ["fixtures/**"], "entrypoints": ["src/index.ts"] },
  "workers": { "setup": "uv sync --frozen", "brief": ["docs/lane_brief.md"] }
}
```

`tiers` lists worker models cheapest first, as `"provider/model"` or `{ model, variant }`; a task's tier indexes it, and the tier past the last entry is the orchestrator itself (a task-bound spawn there is refused with that explanation; an explicit `model` always wins). `workers.brief` lists repository-relative files (house rules) that every worker brief includes in full under `## House rules (<path>)`, right after its scope (each capped at 300 lines, with a missing file named in the brief rather than failing it). A check runs in a shell from the root or its `cwd`, with its `env`; `"when": "land"` keeps it out of a task's rounds entirely (its related tests do not run either) and in the gate before landing; `slots` and `exclusive` bound how many runs overlap across every process and worktree of the repository (lock files under verify's state directory, freed when their holder dies). Checks and `workers.setup` see `HORDE_TASK` and `HORDE_WORKTREE` when they run for a task, for per-task databases and ports. `workers.land` runs while a task lands, after the rebase onto your branch and before the checks, and its changes are committed on top through the repository's hooks: what a project regenerates after any rebase (migration chains, digests, docs pinned to commit hashes) is regenerated on the base the work actually lands on; when the landing does not complete, the worker's branch is put back as it was before the step. `horde_do` refuses in a repository where no checks are found, since its gate could never pass, and looks for them in HEAD's `horde.json`, the one its workers' gates read (an uncommitted one is named as the reason); its first answer names the checks that will judge the work. `horde.json` is the one file a task never carries over from the checkout: its uncommitted changes stay in your checkout, the task's gates read HEAD's, and the task's notes say so, so a local edit cannot silently change a task's checks (every other uncommitted change is still carried over). The plugin's setup skill (`/horde:setup`) writes `horde.json` from the project's CI and manifests and proves it on a clean tree. Environment variables remain for machine-level settings (state dirs, the OpenCode binary, server mode, passwords), as `opencode` does today. Project behaviour lives in `horde.json`, so it is versioned with the code and shared by every horde server and both sides.

`verify.audit` decides the diff audit's seven categories, `scope`, `tests`, `suppressions`, `dependencies`, `secrets`, `binaries` and `git`: `block` and `warn` list them, a category named in neither warns (listing only `block` does not switch the rest off), a category named only in `warn` leaves the default `block` list, and `off` turns one off entirely. By default `scope`, `tests`, `secrets` and `binaries` block and `suppressions`, `dependencies` and `git` warn. `allowed` lists globs every change must stay within, and `generated` lists committed generated output such as bundles: a change there gets no binary, size, secret or suppression findings, though scope still applies. These rules are read from the committed `horde.json` on the branch the work lands on, at the gate and at land, never from a worktree's copy: a committed change takes effect on a task's next round and at landing, and an uncommitted `horde.json` changes nothing.

A user-level `$XDG_CONFIG_HOME/mcp-horde/horde.json` (or `~/.config/mcp-horde/horde.json` when `XDG_CONFIG_HOME` is unset) sets `tiers` and `opencode` once for every repository; each applies only where the repository's `horde.json` does not set it, and every other key in it is ignored. For example, `{ "tiers": ["deepseek/deepseek-flash"] }` there makes `deepseek/deepseek-flash` the default worker model everywhere.

## 6. Flows

### A single task
1. `horde_do { goal, done, scope }` → `t-1 working · deepseek/deepseek-flash (tier 0 of 2) · worktree horde/t-1 · checked by: test (npm test), lint (npm run lint)`.
2. The worker works; the checks fail on round 1 (a type error) and the verdict goes back to it; round 2 passes; the reviewer finds every criterion met.
3. `horde_wait` → `t-1 READY · checks ✓ · review: 3 of 3 criteria met · report matches the diff · changed 3 files (+86 −2) · $0.04` (~300 tokens).
4. `horde_land { id: "t-1" }` → the checks pass on top of the orchestrator's branch, the commits land, the task is done.

Orchestrator-visible tool output: well under 1k tokens, and the goal it wrote. The same task by hand, as the flow ran before §4.9:
1. `board_plan` (one task) → `t-1`.
2. `board_brief t-1` → ~4k tokens of brief, which the orchestrator forwards without reading closely.
3. `opencode_spawn { prompt: brief, model: tier 0, isolation: "worktree", scope, gate: {max_rounds: 2}, limits }`.
4. Worker works; the gate fails on round 1 (a type error); the fleet steers the verdict back; round 2 passes. The worker files its report with the CLI.
5. `opencode_wait` returns: `t-1 agent IDLE ✓ gate (2 rounds) · $0.04 · report: "Added rate limiting middleware … unverified: none"` (~300 tokens).
6. `board_accept t-1` with the verdict; `opencode_worktree merge`; `opencode_dispose`.

Orchestrator-visible tool output: roughly 1k tokens plus the brief it generated. Without the horde, the same task costs the strong model the whole investigation and the whole diff review.

### A feature with parallel tasks
`board_plan` with four tasks and deps; `board_next` → the two ready ones; both spawned with disjoint scopes. One worker finds that a shared helper has a bug and files a finding; the other worker's brief (generated later) includes it. Merge in dependency order; after each merge `opencode_worktree sync` on still-running workers so they absorb the base; `verify_gate` on the integrated branch before the next merge. `board_summary` is the only status call the orchestrator needs.

### Best-of-N
Three cheap workers on the same brief in three worktrees. `opencode_wait mode: all`. Gates filter; `opencode_ask` with a judge prompt over the survivors' `opencode_worktree diff` outputs (the diffs capped) picks one; the others are disposed with `discard`.

### Escalation
`board_fail { id, escalate: true }` raises the tier; the next spawn uses the next model. When the tier is `"orchestrator"`, the skill says the strong model does the task itself, with the worker's report and the failed verdict as its starting point, which is usually most of the diagnosis already done.

## 7. Token economy

What the orchestrator sees per task when things go well, by tool, with target caps:

| Call | Output cap |
| --- | --- |
| `board_brief` | the brief itself (budgeted; default 6k tokens, the orchestrator sends it on, it does not need to study it) |
| `opencode_spawn` | 1 snapshot (~150 tokens) |
| `opencode_wait` | per settled agent: snapshot + verdict + report ≈ 400 tokens |
| `board_accept`, `board_summary` | ≤ 1500 chars |
| `verify_gate` (integration) | ≤ 1500 chars |

Rules that keep this true: every tool takes a `budget` argument with a sane default; lists are one line per item; details are a second call (`detail: "full"`, `verify_logs`, `opencode_output`), never inline; counts are exact even when items are truncated; repeated information (the same report shown twice) is suppressed through the "reported" tracking `opencode` already does.

## 8. Trust and security

- **Who may do what.** Only the orchestrator side can accept, fail, plan, forget, or break leases. Worker-side tools add information scoped to a task they can name (id + token). The token is a weak identity to prevent accidents between parallel workers, not a security boundary: all processes run as the same user on the same machine.
- **Prompt injection.** Workers read untrusted repository content and web pages. A hijacked worker can file misleading reports or findings and can try out-of-scope edits. Reports are claims; the gate and audit do not trust them; scope denies the edits or the audit flags them. Findings are shown with their source task, so a poisoned finding is traceable. Nothing a worker reports can trigger an action on the orchestrator side without the orchestrator model deciding to.
- **Code execution.** `verify` runs the repository's own check commands, which is the same trust the human extends by running `npm test`. Commands come from `horde.json` or manifests in the repository, never from a worker's report. Setup commands for worktrees come from the orchestrator's spawn call.
- **Secrets.** `OPENCODE_SERVER_*` and `HORDE_*` are stripped from check environments; the audit flags secret-looking strings in diffs; `opencode` never prints the server password.
- **State files** are mode 0600 under the user's state directory, as today.

## 9. Failure modes and recovery

| Failure | Handling |
| --- | --- |
| Gate hangs (test suite stuck) | per-check timeout, process-tree kill, `FAIL (timeout)` verdict with the tail of the output |
| Worker loops on a failing gate | `max_rounds`, then `IDLE ✗ gate`; the skill escalates |
| Worker claims success without running anything | the gate runs regardless; the audit compares `testsAdded` in the report with the diff and flags mismatches as `warn: report claims tests not in diff` |
| Two workers need the same file | scope overlap warning at plan time; advisory locks at run time; the audit flags out-of-scope edits; `worktree sync` lets the later worker resolve conflicts |
| Orchestrator process dies mid-feature | board state is on disk; agents keep running on the shared server; `opencode` reclaims ownership on restart; `board_summary` restores the picture |
| Lease expires (worker died) | the task returns to `ready` with the attempt marked `abandoned`; locks are released |
| Stale memory misleads a worker | memory shows confidence and age; `board_forget`; findings carry their source |
| `rg` missing | JS fallback for repos under a size limit; otherwise a clear error naming the dependency |
| Windows file locks during gate or worktree removal | retries and tree kills as `opencode` already does; checks run with `windowsHide` |

## 10. Gaps found in this pass, and the decisions

1. **How do workers get horde tools?** Probed in M2 and again on OpenCode 2.1.1: injected MCP servers connect, one process per project directory, but **agents are not offered their tools**. Decided: a `horde` CLI run through the shell tool, auto-approved by the fleet only for exact, metacharacter-free invocations (§4.2e). Same library as the MCP servers, so moving to MCP mounts later changes the transport only. A canary test asserts the current behaviour so the `dev`-tag CI job reports when it changes.
2. **How does a worker identify itself?** No session identity reaches an MCP server OpenCode spawns. Decided: task id + token quoted by the worker, carried in the brief; reduced worker tool set; acceptance only on the orchestrator side.
3. **Call overhead for the orchestrator.** Five calls per task is a lot. Decided: the gate loop lives inside `opencode` (no orchestrator involvement for retries); `board_brief` composes context and memory in one call; later, `opencode_spawn { task }` fetches the brief and records the assignment itself, cutting a task to three calls (`board_plan`, `opencode_spawn`, `opencode_wait` + `board_accept`).
4. **Scope enforcement.** `edit` rules on the agent's session plus the audit as backstop. Shell writes cannot be fenced reliably; accepted and documented.
5. **Test time.** Related tests in the worker gate, full suite at integration, verdict cache so polling never re-runs anything.
6. **Merge conflicts between parallel workers.** Scopes, locks, `worktree sync` so the cheap model resolves conflicts under a gate; the project's checks on the main checkout after every merge (built: `opencode_worktree merge`).
7. **Log compaction without a model.** Per-runner extractors with exact counts and a tail fallback; `opencode_ask` with a cheap model as the optional second stage.
8. **One-shot calls without leaving v2.** Agents cannot be injected via config content (verified) and v2 prompts carry no per-call tool or format options, so `opencode_ask` uses a tool-less agent profile in a horde-owned directory and validates JSON client-side. Verified in M4: `tools: { "*": false }` disables every tool.
9. **No daemon.** Everything is files plus locks; stdio only. Cost: no push from board to workers; workers read findings when they start and when the orchestrator steers them to.
10. **Verifying worker claims.** Reports have `unverifiedClaims`; the audit cross-checks claimed tests against the diff; the gate is the only path to done.
11. **Escalation.** Built: tiers in `horde.json`; a task-bound spawn picks the tier's model; `board_fail { escalate }` moves to the next tier and says which model that is; the skill escalates after two failed gates; past the last tier is the orchestrator.
12. **Cost.** Tracking, not budgets. `opencode` estimates from the catalog; a task-bound agent's spend is written to its attempt whenever it settles (and when it is disposed), so `board_task`/`board_summary` show it without the orchestrator passing anything; `board_accept`/`board_fail` may still override it. There is no spending limit unless the caller sets `limits.max_cost_usd` on a spawn (per turn); the default is none.
13. **Observability.** Built: `events.jsonl`, and `node <plugin dir>/servers/cli.js status [task id]` on the command line (the board summary, or one task in full with its report checked against the diff; read-only, and not a worker command, so the fleet never approves it). Built in M5: `node <plugin dir>/servers/cli.js watch`, the board live in a terminal (tasks, tiers, costs, each attempt's agent state and gate as `opencode` records them on the board, locks, recent events; a task's full view on enter). It only reads files, like everything else: no daemon.
14. **Configuration sprawl.** One `horde.json`; env vars only for machine-level settings.
15. **Many servers in the client.** Claude Code defers tool loading, so eight servers' worth of descriptions do not sit in context; descriptions stay terse; the plugin registers everything in one step.
16. **The shared server is also the human's.** Injected config may add MCP mounts but must never change agents, permissions or models. A horde server mounted into the human's own TUI sessions is harmless: without a task token its worker tools only read.
17. **Staying on v2 as it moves.** Legacy calls are confined to one adapter with a test guarding the boundary; `./ci.sh --latest` runs against OpenCode's latest release so v2 changes are seen early; `session.wait` and project copies are watched as replacements for polling and for the horde's own worktrees.

### Review pass (October 2026)

A full review after M5 fixed, among others: gates that could pass with nothing run (no checks is now a FAIL; a worker's edits to `horde.json`, test scripts or runner configs are judged by the base commit's rules and flagged; renamed or moved-out tests and changed test helpers widen to the full suite; aliases, nested Go/Python projects and capped maps never narrow); a line-level audit blind under `diff.mnemonicPrefix`; trusted board commands naming another directory or carrying escape sequences (only the agent's own repository's board is trusted now); briefs whose reporting commands could be cut; spawns of a task that broke its live attempt; processes left holding a gate's output; a hung request freezing every agent's monitoring (requests and ticks time out); two MCP processes driving one agent (claims under a lock, owner heartbeats); `context_file` reading outside the project; and quadratic import resolution in large Java/Go repositories. Details are in the commit history.

## 11. Open questions to verify empirically before building

- ~~An injected `mcp` local server connects and its tools appear in sessions~~ (answered in M2: connects, but v2 runners do not offer its tools).
- ~~One MCP process per server or per project directory~~ (answered: per directory, started lazily, cwd = the directory).
- ~~`tools: {"*": false}` semantics in an agent profile~~ (answered in M4: it disables every tool. OpenCode's free tier refuses such agents with 403 `FreeTierError`, hence `opencode_ask`'s guarded fallback, §3).
- ~~How reliably cheap models return valid JSON when asked in the prompt~~ (answered in M4: usually on the first try with the schema in the prompt; one retry with the validation error covers the rest in the live suite).
- ~~`session.compact` on v2 sessions; `session.revert.stage` semantics~~ (answered in M4: compaction answers 503 "not available" on 1.19.3 and the legacy summarize does not reach v2 sessions, so `opencode_compact` explains the workaround; `revert.stage { messageID, files: true }` keeps everything up to and including that message, and file snapshots land shortly after a step ends).
- ~~`permission.edit` glob semantics~~ (answered in M4: globs are relative to the project root and the v2 `write`/`patch` tools honour the same map).
- ~~The same questions on OpenCode 2~~ (answered in the port to 2.1.1, §3.2: compaction works; revert undoes the given message too; session rules replace agent files; MCP tools still do not reach agents).
- ~~Whether `web-tree-sitter` WASM grammars load acceptably fast~~ (answered in M5: the runtime starts in ~30 ms and all nine grammars load in ~50 ms; a 90 KB TypeScript file parses in ~50 ms).
- Whether Claude Code shows a prompt that a tool call returns as `input_required` on the 2026-07-28 protocol, and how many rounds it allows. This decides whether `opencode` can keep asking the human once it serves that protocol (M7). To find out: a ten-line server whose one tool answers `input_required` with a form, tried in an interactive session.
- ~~Whether Claude Code delivers channel notifications on 2026-07-28~~ (answered on 2026-10-28: channels are a research preview in which only allowlisted official plugins register, so a non-allowlisted server needs the session started with `claude --dangerously-load-development-channels plugin:horde@mcp-horde` (the form seen on Claude Code 2.1.312) — a warning dialog at each start, interactive sessions only. This does not apply to the horde today: it negotiates MCP 2025-11-25 through `@modelcontextprotocol/sdk` 2.3.1, so the documented refusal of channel servers on 2026-07-28 never comes up).

- ~~Why the `opencode` MCP server sometimes dies in a long Claude Code session~~ (answered on 2026-10-21: the heap ran out). Ubuntu's crash reporter recorded signal 6 (SIGABRT) for the deaths at 00:19, 04:00 and 14:48, which is how V8 ends a process that runs out of heap; the exit handlers never run, so `servers.log` showed only "started". Sampling the next server showed its heap jump by about 1.5 GB at a task's brief and again at its gate, never released, against a 4.3 GB limit. The cause was `signatureOf` in the context package: a minified file's single line is hundreds of KB, and each definition's signature was a slice of a fresh copy of that line, keeping the copy alive. The plugin's bundled servers are such files, about 1,800 definitions each, so one brief or gate kept about 1.4 GB (270–557 MB per bundle) and spent 9 s building it. Lines are now cut to 1,000 characters first: 38 MB and 2 s. A test keeps it there. Since then every server also writes Node's fatal-error report next to `servers.log` and logs each new 512 MB high of its heap, so a native abort says why.

Each goes into a `probe/` script in the relevant package, like the probes used while building `opencode`, and becomes an integration test once the behaviour is confirmed.

## 12. Build order

| Milestone | Delivers | Why first |
| --- | --- | --- |
| **M0** ✓ `compat.ts` boundary + v2 health + `dev`-tag CI job | the v2 policy enforced in code | small, and it keeps every later milestone honest |
| **M1** ✓ `core` + `verify` + gates in `opencode` | mechanical verdicts; self-fixing workers (related-test selection moves to M3 with `context`) | the biggest trust and token win, and it needs no worker-side mounts |
| **M2** ✓ `board` (MCP for the orchestrator, an auto-approved CLI for workers) + the `horde` plugin with its skill | shared task graph, reports, findings, memory; the procedure, proven end to end by a mock run (`opencode/test/flow.test.ts`) | turns ad-hoc delegation into a tracked workflow |
| **M3** ✓ `context` v1 + `board_brief` composition + related-test gates | precise briefs; gates that run only the tests reaching the change (transitively through imports), with a full-suite fallback whenever that is not safe | closes most of the quality gap for fast models |
| **M4** ✓ `opencode_ask`, `scope`, `worktree sync`, `opencode_compact`, `opencode_revert`, `opencode_permissions`, `opencode_spawn { task }` (+ report-vs-diff checks, context use in status, prices in the catalog) | one-shot calls and judging; scope enforcement; conflict handling; context and undo for long tasks; fewer calls | refinements once the loop works end to end |
| **Integration** ✓ tiers from `horde.json`, automatic attempt costs, checks after merges, `opencode.maxRunning`, `node <plugin dir>/servers/cli.js status` | the loop without hand-carried models, costs or limits | gaps found by running the whole flow |
| **M5** ✓ tree-sitter `context`, `node <plugin dir>/servers/cli.js watch` (plugin packaging done early: bundled servers, no npm) | depth and visibility | after the shape is proven |
| **M6** ✓ the simple path (§4.9): `horde_do`, `horde_wait`, `horde_tell`, `horde_land`, `horde_drop`; review inside the gate, seeing the checks; task scopes confine edits; dependencies linked into worktrees; atomic landing | delegating is a tool call: three calls per task, no procedure to learn | two fresh agents found the nine-call flow usable only with the skill and inside knowledge |
| **M7** the 2026-07-28 protocol, in two steps. **(a)** `board`, `context`, `ledger`, `verify` move to `serveStdio` (a fresh `McpServer` per call of its factory), with a client test pinned to 2026-07-28 and a check in Claude Code. **(b)** `opencode`, once its §11 question is answered: permission prompts and questions ride an in-flight `horde_wait` / `opencode_wait` as `input_required` (sealed `requestState`) instead of background elicitation; the client name comes from each request's envelope (`defaultWait` depends on it); it stays on the 2025 handshake while `HORDE_OPENCODE_CHANNEL` is set | the current protocol revision on every server | not urgent: Claude Code chooses the protocol per server and still speaks the 2025 handshake; serving 2026-07-28 now would cost `opencode` its background prompts and channels. Findings and costs: [research/mcp-protocol.md](research/mcp-protocol.md#the-sdk-v2-migration) |

Each milestone ships with the same bar as `opencode`: unit tests, integration tests against a real `opencode serve` with the mock LLM, `./ci.sh` passing, READMEs updated.

## 13. Non-goals

- Replacing OpenCode's agent loop, tools or provider layer. The horde drives OpenCode; it does not reimplement it.
- A web UI or cloud sync. State is local files; `node <plugin dir>/servers/cli.js watch` in a terminal is as far as viewing goes.
- Security isolation between the orchestrator and workers beyond scope and audit. Sandboxing workers is OpenCode's and the OS's job.
- Supporting agent runtimes other than OpenCode as workers. The orchestrator side is runtime-agnostic through MCP; the worker side is OpenCode.
