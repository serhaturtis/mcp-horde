# mcp-horde: system design

Status: October 2026. Built: `@mcp-horde/opencode`, `@mcp-horde/core`, `@mcp-horde/verify`, gates in `opencode` (M0, M1), `@mcp-horde/board` with its worker CLI, the `horde` Claude Code plugin with its orchestration skill (M2), and `@mcp-horde/context` with code context in briefs and related-test gates (M3). Planned: everything from M4 on.

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
7. **Harness-agnostic, OpenCode-specific, v2 API only.** Tools work from any MCP client. Worker integration assumes OpenCode (its config, its agent profiles, its permission system). All server calls go through OpenCode's v2 API (`/api/*`, `@opencode-ai/sdk/v2`). The legacy API is used only where v2 has no equivalent, from one adapter module, with each use marked for removal (§3.1).
8. **Reuse the agent runtime for model access.** One-shot model calls go through OpenCode too (its providers, auth and catalog), so there is exactly one place where models are configured.

## 3. The system

```
                 Claude Code / any MCP harness (orchestrator model)
   ┌────────────┬─────────────┬──────────────┬──────────────┐
   │ opencode   │ verify      │ board        │ context      │   stdio MCP servers
   │ spawn/wait │ gate/audit  │ plan/brief/  │ map/symbol/  │   (orchestrator mode)
   │ steer/stop │ run/detect  │ accept/recall│ tests/pack   │
   └─────┬──────┴──────┬──────┴──────┬───────┴──────┬───────┘
         │ v2 API      │ lib         │ files        │ lib
         ▼             ▼             ▼              ▼
   opencode serve  ◄── gate runs in the agent's directory when it settles
     │  (shared, one per machine; config injected via OPENCODE_CONFIG_CONTENT)
     │  sessions = agents, each in its own git worktree on branch horde/<name>
     ▼
   worker model (DeepSeek …) with tools: bash, edit, read …
     └── worker-side access through bash: the `horde` CLI (board, verify, context);
         the fleet auto-approves exactly those commands (v2 runners offer no MCP tools yet)
                                              │
                                              ▼
                      ~/.local/state/mcp-horde/<project>/   (board state: tasks, findings, memory, locks, events)
```

Package dependency graph (npm workspaces, all TypeScript, Node 20+):

```
core ─┬─ verify ─── opencode      (opencode imports verify's library for gates)
      ├─ context ── board         (board imports context's library for briefs)
      └─ playbook (Claude Code plugin: .mcp.json + skill; no code)
```

`opencode` and `board` stay decoupled in v1; the orchestrator composes them. A later optimization lets `opencode_spawn` take a task id directly (see §10).

### 3.1 API policy: the v2 series

The target is OpenCode's v2 API: the `/api/*` endpoints served by `opencode serve` and typed by `@opencode-ai/sdk/v2`. The v2 surface of the current release (1.19.3) and of today's `dev` build are identical, so there is no newer shape to chase yet; the policy is about staying on it as it grows.

What v2 provides that the horde uses or will use: sessions (create with `agent`, `model`, `location`; list; get; active; interrupt; switch model; switch agent; prompt with `steer`/`queue` delivery; durable history and per-session events; messages), permissions and questions (per-session list and reply, global request lists, **saved permission rules** list and remove), `session.compact` and `session.context` (context management for long-running workers), `session.revert.stage/clear/commit` (undo a turn's file changes), `model`, `provider`, `agent`, `skill`, `command`, `fs.read/list/find`, `health`, and the SSE event stream.

What v2 does not provide, and how each case is handled:

| Need | v2 status | Handling |
| --- | --- | --- |
| health check | `GET /api/health` | use it; the current `global.health` call is replaced |
| rename a session (`horde: <name>` titles) | missing | legacy `session.update` through the adapter; cosmetic, dropped if it ever breaks |
| delete a session | missing | legacy `session.delete` through the adapter; without it, `opencode_dispose` leaves the session in history (acceptable degradation) |
| release a directory before deleting a worktree | missing (`instance.dispose` is legacy) | legacy through the adapter, best effort; removal retries cover the failure case |
| one-shot call with no tools, structured output | per-call `tools`/`format` exist only on the legacy prompt | **not used.** One-shot calls run as a v2 session with a tool-less agent profile; JSON is requested in the prompt and validated client-side (§4.2c) |
| worktrees | `/experimental/project/{id}/copy` (experimental, not `/api`) | keep the horde's own worktrees (baseline commits, links, setup, scoped profiles); revisit when project copies reach `/api` |
| block until a session settles | `GET /api/session/{id}/wait` exists but returns 503 in 1.19 | keep polling history plus the event stream; switch when it works |

Every legacy call lives in `packages/opencode/src/compat.ts`, with the v2 gap it covers named in a comment. A unit test fails if any other source file touches the legacy client, so the list cannot grow silently. CI runs the suite against the pinned `opencode-ai` release and, in a non-blocking job, against the `dev` tag, so v2 changes show up before users hit them.

### Verified facts about OpenCode 1.19.3 this design relies on

Checked against the installed binary and its SDK types during this pass:

- `OPENCODE_CONFIG_CONTENT` (inline JSON) **merges** with the project's `opencode.json`: the project's providers and the injected `mcp` entries are both present in the resolved config. **Agents defined in it do not register** (the agent list ignores them), while agents in the project's `opencode.json` or `.opencode/agent/*.md` do. So MCP mounts can be injected into the server we start; agent profiles cannot.
- `mcp` config supports `type: "local"` with `command`, `cwd`, `environment` (OpenCode spawns the stdio server) and `type: "remote"` with headers.
- Agent config supports `tools: {name: boolean}`, `maxSteps`, `prompt`, `mode`, and `permission` with **glob maps per action**: `edit: {"src/auth/**": "allow", "*": "deny"}`.
- The v2 prompt body is `{prompt: {text, files, agents}, delivery, resume}`: no per-call tools, system prompt or output format. Those belong to agent profiles.
- Agent `.md` files load when OpenCode first opens a directory (already relied on by `opencode` for worktree profiles).
- **Compaction and revert (probed in M4, 1.19.3).** `/api/session/{id}/compact` answers 503 "Session compact is not available yet", and the legacy `session.summarize` returns OK without touching the v2 conversation (the next request still carries every message), so there is no working compaction for v2 sessions; `opencode_compact` says so and works unchanged once the endpoint does. `session.revert.stage { messageID, files: true }` + `commit` works: it keeps everything up to and including that message, removes the rest and restores the files the removed turns changed (the staged diff lists them). Undoing a turn therefore stages at the message just before the turn's prompt. Messages list newest first by default; `cursor` cannot be combined with `order`.
- **The v2 session runner does not offer MCP tools to agents** (1.19.3 and `dev` 0.0.0-dev-202610161232, probed in M2). An injected `mcp` local server does connect (`/mcp` reports `connected`), OpenCode starts **one process per project directory** lazily on its first request, with that directory as the working directory and the configured `environment` merged over the inherited one, and the **legacy** runner offers its tools (`horde_echo`). The v2 runner offers only built-in tools (and no `task` subagent tool either). So worker-side horde access goes through `bash` (§4.4), and a canary test watches for the day v2 gains MCP tools.
- OpenCode's v2 runner reports every step as `cost: 0`; `opencode` prices steps from the catalog. Cost figures across the horde come from that estimate.

## 4. Package designs

### 4.1 `@mcp-horde/core` (library, not a server)

Shared by every package. Extracted from `opencode`, which currently owns these:

- `Store`: one JSON file per entity, atomic write (tmp + rename, EPERM retry on Windows), `update()` deleting `undefined` keys.
- `lock(name, fn)`: cross-process lock with heartbeat, stale takeover, and release-only-your-own.
- Process helpers: `killTree`, detached spawn, `pidAlive` (EPERM counts as alive), supervisor pattern.
- Paths: XDG state/data dirs, `projectKey(repoRoot)` (hash of the real path), `horde.json` loader (§5).
- Rendering: `truncate`, `truncateHead`, `formatUsd`, `formatTokens`, `estimateTokens` (chars/4), a `Budget` helper that trims a list of sections to a character cap keeping the most important first.
- Git helpers from `worktree.ts` that are not worktree-specific: `gitRaw` with `GIT_TERMINAL_PROMPT=0`, timeouts, `repoRoot`, `changedFiles(base)`, `-z` parsing.

Internal package: published alongside the others so `npx @mcp-horde/verify` resolves it, but with no stability promise.

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
Requires `isolation: "worktree"` (the only place a per-agent profile can be installed). The generated profile gets `permission.edit` as a glob map: scope paths `allow`, `*` as `outside`. With `"ask"`, an out-of-scope edit surfaces as a permission request the orchestrator (or the human) answers; with `"deny"`, OpenCode refuses it and the model is told why. `verify_audit` independently reports out-of-scope changes in the diff, so an agent without a profile is still caught after the fact. (`edit` covers OpenCode's edit/write/patch tools; `bash` can still write files. The audit is the backstop for that; a `bash` glob map that denies `>`/`tee`/`sed -i` is not attempted because it is unenforceable in general.)

**c. One-shot calls (`opencode_ask`).**
```
opencode_ask { prompt, model?, variant?, files?, schema?: JSONSchema } → text | JSON
```
Runs as a v2 session in a horde-owned directory (`<data dir>/ask/`) that carries one agent profile, `horde-ask`: every tool disabled, a fixed system prompt ("answer directly; no tools are available"). The directory never changes, so OpenCode loads the profile once. The call creates a session there with `agent: "horde-ask"` and the requested model, sends one prompt, waits for the single step through history, returns the text with its cost, and deletes the session (adapter). With `schema`, the prompt asks for JSON matching the schema, the reply is parsed and validated client-side, and one retry with the validation error is attempted before giving up. No agent loop, no worktree. Uses: classification, summarizing a long log or diff for the orchestrator, judging between candidates, drafting a brief. Best-of-N is `opencode_spawn` ×N + `verify` + `opencode_ask` as judge; the playbook describes it rather than a dedicated tool.

To verify before building: whether `tools: {"*": false}` is honoured in a profile (otherwise the profile enumerates every tool id from `/api/agent`'s build agent).

**f. Context management (`opencode_compact`, context in status).** Long tasks on small-context models hit the window. `session.context` gives the usage; the snapshot shows it (`ctx 71%`) so the orchestrator can see a worker about to lose its thread; `opencode_compact` calls `session.compact` on an idle agent before messaging it again. The playbook's rule: compact instead of re-spawning when the task is mid-way and the worktree holds good work.

**g. Undo a turn (`opencode_revert`).** `session.revert.stage` to a message id rolls the worker's files back to that point and marks the later messages reverted; `revert.commit` makes it permanent, `revert.clear` abandons it. `opencode_revert { id, to?: messageID }` defaults to the start of the last turn. Cheaper than discarding a worktree when one bad turn ruined a good run, and it keeps the worker's context consistent with its files, which a manual `git checkout` would not.

**h. Saved permission rules (`opencode_permissions`).** An "always" reply saves a rule in OpenCode. `opencode_permissions { action: "list" | "remove", id? }` shows and removes those rules so the orchestrator can see what has been permanently allowed for a project and undo it.

**d. `opencode_worktree action: "sync"`.** Merges the base branch into the agent's branch inside the agent's worktree, so conflicts with other merged work land where a cheap model (with a gate) can resolve them, instead of at the orchestrator's merge. Refused while the agent is running; after a sync the playbook says to message the agent "resolve the conflicts and run the gate".

**e. Worker access to the horde (revised in M2).** v2 runners offer no MCP tools (§3.1), so workers reach the board, verify and context through a `horde` CLI they run with `bash`; the brief contains the exact command. The fleet auto-approves a `bash` permission request only when the command is exactly that CLI with plain arguments (a shell-word check rejects `;`, `&&`, `||`, pipes, redirects, `$`, backticks and newlines anywhere outside single quotes), whatever the agent's policy, so board plumbing never prompts the human and a hijacked worker cannot chain anything onto a trusted command. The rest of this item describes the MCP route, kept for when v2 runners load MCP tools:

When `opencode` starts the shared or private server it sets `OPENCODE_CONFIG_CONTENT` with `mcp` entries for the worker-side horde servers that are installed and enabled (`HORDE_WORKER_TOOLS=board,context,verify`, default: whichever are resolvable next to this package). Each is `type: "local"` with `command: [process.execPath, <bin>, "--worker"]` and `environment` carrying the state dir. In attach mode the server is the user's; the README gives the `opencode.json` snippet. The injected config never changes agents or permissions (the shared server is also the human's TUI server).

Also: the snapshot rendering gains a `task:` line when a board binding exists (§10), `HORDE_OPENCODE_MAX_RUNNING` becomes a horde-wide `maxRunning` in `horde.json` with the env var as override, and the health check moves to `v2.health`.

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
  - hygiene: binaries, files over 1 MB, generated directories, secret-looking strings (common key prefixes, private key headers)
  - git: merge commits on the branch, commits that touch only `.horde`/`.opencode`
  Each finding has `severity: block | warn`, a file, a line when known, and one line of text. Which categories block is configurable (`horde.json` `verify.audit`); defaults: scope, test deletion/skips, secrets and binaries block; suppressions and dependency changes warn.
- `verify_gate { directory, base, checks?, related?, allowed?, budget_chars? (default 1500) }` (`related` derives the changed files from `base`) → `PASS` or `FAIL` with `blockers` (failing checks, blocking audit findings) and `warnings`, rendered within the budget. This is what `opencode` calls.
- `verify_logs { directory, check }` → the last run's full output for one check, head-truncated to a requested size. Available, never automatic.

**Output extraction without a model.** Per-runner extractors run on captured stdout+stderr: TAP (`not ok` blocks with their YAML), jest/vitest (`●`/`FAIL` blocks, `AssertionError`, `expected`/`received` lines), pytest (`FAILED path::test - message` and the `E ` lines), cargo (`---- name stdout ----` to `failures:`), go (`--- FAIL` to the next `===`), tsc (`path(line,col): error TSxxxx`), eslint/ruff/biome (path:line rule lines), generic (`Error:`/`Traceback`/`panicked at` with 6 lines of context). Each failure keeps: the test or file name, the assertion text (up to 300 chars), and the first stack frame inside the project (not `node_modules`, not `node:internal`). Fallback when nothing matches: the last 40 lines. Counts are always exact (`14 failed, 212 passed`) even when details are truncated. For logs that still exceed the budget, the playbook's option is `opencode_ask` with a cheap model summarizing them: cheap compresses for expensive.

**Execution.** Each check runs through the shell in the directory with a timeout (default 600 s, from config), in its own process group, killed as a tree on timeout or abort; `OPENCODE_SERVER_*` and `HORDE_*` are stripped from the environment; `CI=1` is set; output is capped at 8 MB per check with the head and tail kept. Checks run sequentially by default (shared `node_modules`, ports); `parallel: true` in config opts in.

**Cache.** A verdict is keyed by (directory, HEAD, working-tree hash, checks). Re-running a gate on an unchanged tree returns the cached verdict instantly; `opencode_wait` polling never re-runs tests.

### 4.4 `@mcp-horde/board`

The shared task graph. One server, two modes: orchestrator (default) and `--worker` (reduced, worker-safe tool set). State in `~/.local/state/mcp-horde/<projectKey>/board/`: `tasks/<id>.json`, `findings.jsonl`, `memory.jsonl`, `locks/<slug>.json`, `events.jsonl`. Multiple processes (one orchestrator, N worker-side instances started by OpenCode) share it through `core`'s store and locks.

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
  cost: number,              // sum over attempts (from opencode snapshots the orchestrator passes in)
  parent?: string,           // epic / feature grouping
  token: string,             // the worker quotes it; weak identity, not security
  createdAt, updatedAt
}
```
`Report` (worker-filed, ≤ 2k chars total): `{ summary, filesChanged[], testsAdded[], decisions[], questions[], unverifiedClaims[], confidence: low|medium|high }`. `unverifiedClaims` is where the brief tells the worker to put anything it did not actually run or check. The orchestrator reads reports; it does not read transcripts unless a gate failed twice.

**Orchestrator tools**
- `board_plan { tasks: [{title, goal, acceptance, scope, deps(by title or id), tier?, parent?}] }` → ids, plus warnings for overlapping scopes and dependency cycles.
- `board_next { limit? }` → ready tasks (all deps done, unclaimed), one line each.
- `board_brief { id, budget_tokens? (default 6000) }` → the full worker prompt: goal, acceptance, scope, the reporting protocol (file a report with `board_report` before finishing; put unverified work in `unverifiedClaims`; run `verify_gate` yourself first), relevant findings and memory (tag and path overlap), and a `context.pack()` of the scoped files, trimmed to the budget. The orchestrator passes this to `opencode_spawn` unchanged.
- `board_assign { id, agent }` records which `opencode` agent works it (so `board_summary` and the task page show it).
- `board_accept { id, verdict, cost? }` / `board_fail { id, reason, escalate?: boolean }` / `board_block { id, on }` / `board_update { id, patch }`.
- `board_summary { }` → ≤ 1500 chars: counts by status, running tasks with their agents, blocked tasks and why, unanswered worker questions, cost so far, next ready tasks.
- `board_task { id, detail?: "brief" | "full" }` → one task; `full` includes reports and attempts.
- `board_findings { since?, tags?, paths? }`, `board_remember { text, tags, confidence? }`, `board_recall { query, limit? }`, `board_forget { id }`.
- `board_locks { }`, `board_unlock { path }` (orchestrator can break a lease).
- `board_archive { }` moves done/failed tasks out of the active set.

**Worker commands** (the `horde` CLI over the same library; see §4.2e for why not MCP tools today. Each tool below maps to a subcommand: `horde task <id> <token>`, `horde progress <id> <token> "<note>"`, `horde report <id> <token> --summary "…" …`, `horde finding "<text>" --paths a,b`, `horde findings`, `horde recall "<query>"`, `horde lock|unlock <id> <token> <paths…>`.)
- `board_task { id, token }` → the task as the worker should see it (goal, acceptance, scope, open questions' answers), never other tasks' internals beyond titles.
- `board_progress { id, token, note }` → one-line status, renews the lease.
- `board_report { id, token, report }` → files the structured report; status becomes `review`. Does **not** complete the task.
- `board_finding { text, tags?, paths? }` → shared fact ("the auth middleware expects `req.user` set by …"). Findings are capped (500 chars) and deduplicated by hash.
- `board_findings { tags?, paths? }` and `board_recall { query }` → read shared facts and project memory.
- `board_lock { paths, id, token }` / `board_unlock { paths, id, token }` → advisory leases (TTL 30 min, renewed by `board_progress`). `board_lock` fails with the holder's task id if another task holds the path; the brief tells the worker to lock before touching anything outside its scope and to report instead of fighting over a lock.

Worker questions go through OpenCode's own question tool (they already surface as `needs_input` on the parent agent in `opencode`), so the board has no `ask`.

**Memory.** Entries `{ id, text, tags, confidence, source: {task, attempt}, createdAt, verifiedAt? }`. `board_recall` ranks by tag and path overlap, then recency; stale entries (older than 90 days, never re-verified) are marked `(stale)` in output. The brief includes memory under a "Project notes" heading with the caveat that notes may be outdated.

**Events.** Every mutation appends to `events.jsonl`. `npx @mcp-horde/board status` prints the summary from the command line; a TUI is a later addition (§11).

### 4.5 `@mcp-horde/context`

Precise briefs instead of exploration. Fast models are weakest at navigating large codebases and spend most of their tokens doing it; the orchestrator should not spend its tokens doing it for them either. Library + MCP; mounted by both sides.

**v1 (built in M3, no native dependencies):** git's file list (so `.gitignore` applies) scanned in-process with content-keyed caches, plus language-aware regexes for definitions, block extents and imports in TypeScript/JavaScript, Python, Go, Rust, Java/Kotlin, C#. Ripgrep turned out unnecessary at this size (a 100-file repository maps in ~25 ms, a full pack with the import graph in ~0.5 s); it stays an option if large monorepos need it. Import resolution includes workspace packages by name, so monorepo tests are linked to the packages they exercise. **v2:** tree-sitter via `web-tree-sitter` (WASM, portable) for real symbol extraction and call-site resolution.

**Tools**
- `context_map { directory, depth?, budget_chars? }` → directory tree with file counts and languages per directory, entry points, manifests, test directories, the project's own instructions files (`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`) listed, not inlined.
- `context_find { query, kind?: "definition" | "reference" | "text", paths?, limit? }` → `path:line  one-line match`.
- `context_symbol { name, path? }` → definition with signature and doc comment, the enclosing file, and call sites (count plus the first N with one line each).
- `context_file { path, lines?: "a-b", symbols?: string[], budget_chars? }` → an excerpt with line numbers; with `symbols`, only those definitions.
- `context_imports { path, direction: "in" | "out" }` → files this file imports, or files importing it.
- `context_tests_for { files: string[] }` → test files that cover them: naming conventions (`x.test.ts`, `test_x.py`, `x_test.go`), directory mirrors (`src/a/b.ts` → `test/a/b.*`), and tests that import the file (through re-exporting index/lib files; `verify` follows imports transitively). Used by `verify` for related tests.
- `context_pack { goal, files?, symbols?, scope?, budget_tokens }` → an assembled brief section: the scoped files' excerpts (whole file when small, signatures plus relevant regions when large), the symbols the goal mentions with their definitions, the tests that cover the scope, and the conventions section (the first 60 lines of the project's instructions files). Sections are ranked (scope files > named symbols > tests > conventions) and trimmed to the budget with the `core` `Budget` helper.

**Conventions file.** `horde.json` `context.ignore` extends `.gitignore`; `context.entrypoints` names files always worth listing.

### 4.6 `playbook` (Claude Code plugin, no code)

Distribution and procedure. A plugin directory with:

- `.mcp.json` registering `opencode`, `horde-verify`, `horde-board`, `horde-context` (all `npx -y @mcp-horde/<name>`).
- `skills/horde/SKILL.md`: the orchestration procedure the strong model follows. Plan with `board_plan` (small tasks, each with observable acceptance and a scope). For each ready task: `board_brief` → `opencode_spawn` with `gate`, `scope`, `isolation: "worktree"`, model from the task's tier → `opencode_wait` (gated) → read the verdict and the report, not the transcript → `board_accept` or `board_fail` → `opencode_worktree merge` in dependency order, `verify_gate` on the integrated result. Escalation: two failed gates raise the tier; the top tier is "do it yourself". Best-of-N for hard, well-specified tasks: spawn N on cheap tiers, gate filters, `opencode_ask` judges the survivors' diffs. Steer with `opencode_message` when a worker drifts; never let a worker run more than `limits` allow. What not to do: reading transcripts before a gate has failed twice, re-briefing from memory instead of `board_brief`, merging without a gate.
- A worker brief template (the fixed part `board_brief` emits), kept here so humans can read and tune it.

The playbook is also the place for the tier table users edit (`horde.json` `tiers`), with examples for DeepSeek, Kimi, GLM, Qwen and local models.

## 5. Configuration: one `horde.json`

At the repository root (optional; everything auto-detects without it):

```json
{
  "project": "myapp",
  "maxRunning": 8,
  "tiers": [
    { "model": "deepseek/deepseek-v4-flash", "variant": "high" },
    { "model": "moonshot/kimi-k3" },
    { "model": "orchestrator" }
  ],
  "verify": {
    "checks": { "test": "npm test", "typecheck": "npm run typecheck", "lint": "npm run lint" },
    "timeoutSeconds": 600,
    "audit": { "block": ["scope", "tests", "secrets", "binaries"], "warn": ["suppressions", "dependencies"] }
  },
  "context": { "ignore": ["fixtures/**"], "entrypoints": ["src/index.ts"] },
  "board": { "leaseMinutes": 30, "memoryStaleDays": 90 }
}
```

Environment variables remain for machine-level settings (state dirs, the OpenCode binary, server mode, passwords), as `opencode` does today. Project behaviour lives in `horde.json`, so it is versioned with the code and shared by every horde server and both sides.

## 6. Flows

### A single task
1. `board_plan` (one task) → `t-1`.
2. `board_brief t-1` → ~4k tokens of brief, which the orchestrator forwards without reading closely.
3. `opencode_spawn { prompt: brief, model: tier 0, isolation: "worktree", scope, gate: {max_rounds: 2}, limits }`.
4. Worker works; the gate fails on round 1 (a type error); the fleet steers the verdict back; round 2 passes. The worker files `board_report`.
5. `opencode_wait` returns: `t-1 agent IDLE ✓ gate (2 rounds) · $0.04 · report: "Added rate limiting middleware … unverified: none"` (~300 tokens).
6. `board_accept t-1` with the verdict; `opencode_worktree merge`; `opencode_dispose`.

Orchestrator-visible tool output: roughly 1k tokens plus the brief it generated. Without the horde, the same task costs the strong model the whole investigation and the whole diff review.

### A feature with parallel tasks
`board_plan` with four tasks and deps; `board_next` → the two ready ones; both spawned with disjoint scopes. One worker finds that a shared helper has a bug and files a finding; the other worker's brief (generated later) includes it. Merge in dependency order; after each merge `opencode_worktree sync` on still-running workers so they absorb the base; `verify_gate` on the integrated branch before the next merge. `board_summary` is the only status call the orchestrator needs.

### Best-of-N
Three cheap workers on the same brief in three worktrees. `opencode_wait mode: all`. Gates filter; `opencode_ask` with a judge prompt over the survivors' `opencode_worktree diff` outputs (the diffs capped) picks one; the others are disposed with `discard`.

### Escalation
`board_fail { id, escalate: true }` raises the tier; the next spawn uses the next model. When the tier is `"orchestrator"`, the playbook says the strong model does the task itself, with the worker's report and the failed verdict as its starting point, which is usually most of the diagnosis already done.

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
| Worker loops on a failing gate | `max_rounds`, then `IDLE ✗ gate`; the playbook escalates |
| Worker claims success without running anything | the gate runs regardless; the audit compares `testsAdded` in the report with the diff and flags mismatches as `warn: report claims tests not in diff` |
| Two workers need the same file | scope overlap warning at plan time; advisory locks at run time; the audit flags out-of-scope edits; `worktree sync` lets the later worker resolve conflicts |
| Orchestrator process dies mid-feature | board state is on disk; agents keep running on the shared server; `opencode` reclaims ownership on restart; `board_summary` restores the picture |
| Lease expires (worker died) | the task returns to `ready` with the attempt marked `abandoned`; locks are released |
| Stale memory misleads a worker | memory shows confidence and age; `board_forget`; findings carry their source |
| `rg` missing | JS fallback for repos under a size limit; otherwise a clear error naming the dependency |
| Windows file locks during gate or worktree removal | retries and tree kills as `opencode` already does; checks run with `windowsHide` |

## 10. Gaps found in this pass, and the decisions

1. **How do workers get horde tools?** Probed in M2: injected MCP servers connect, one process per project directory, but **v2 runners do not offer MCP tools** (release and `dev`). Decided: a `horde` CLI run through `bash`, auto-approved by the fleet only for exact, metacharacter-free invocations (§4.2e). Same library as the MCP servers, so moving to MCP mounts later changes the transport only. A canary test asserts the current behaviour so the `dev`-tag CI job reports when it changes.
2. **How does a worker identify itself?** No session identity reaches an MCP server OpenCode spawns. Decided: task id + token quoted by the worker, carried in the brief; reduced worker tool set; acceptance only on the orchestrator side.
3. **Call overhead for the orchestrator.** Five calls per task is a lot. Decided: the gate loop lives inside `opencode` (no orchestrator involvement for retries); `board_brief` composes context and memory in one call; later, `opencode_spawn { task }` fetches the brief and records the assignment itself, cutting a task to three calls (`board_plan`, `opencode_spawn`, `opencode_wait` + `board_accept`).
4. **Scope enforcement.** `edit` permission globs in a per-agent profile (worktrees only) plus the audit as backstop. `bash` writes cannot be fenced reliably; accepted and documented.
5. **Test time.** Related tests in the worker gate, full suite at integration, verdict cache so polling never re-runs anything.
6. **Merge conflicts between parallel workers.** Scopes, locks, `worktree sync` so the cheap model resolves conflicts under a gate; integration gate after every merge.
7. **Log compaction without a model.** Per-runner extractors with exact counts and a tail fallback; `opencode_ask` with a cheap model as the optional second stage.
8. **One-shot calls without leaving v2.** Agents cannot be injected via config content (verified) and v2 prompts carry no per-call tool or format options, so `opencode_ask` uses a tool-less agent profile in a horde-owned directory and validates JSON client-side. To verify: wildcard `"*"` in a profile's tools map; otherwise enumerate tool ids.
9. **No daemon.** Everything is files plus locks; stdio only. Cost: no push from board to workers; workers read findings when they start and when the orchestrator steers them to.
10. **Verifying worker claims.** Reports have `unverifiedClaims`; the audit cross-checks claimed tests against the diff; the gate is the only path to done.
11. **Escalation.** Tiers in `horde.json`; attempts record the tier; the playbook escalates after two failed gates; the final tier is the orchestrator.
12. **Cost.** `opencode` estimates from the catalog; `board_accept`/`board_fail` take the cost from the snapshot; `board_summary` totals it. Budget enforcement stays in `opencode` limits (per turn) with a per-task `maxCostUsd` the brief converts into limits.
13. **Observability.** `events.jsonl` plus `board status` on the command line now; a TUI later.
14. **Configuration sprawl.** One `horde.json`; env vars only for machine-level settings.
15. **Many servers in the client.** Claude Code defers tool loading, so eight servers' worth of descriptions do not sit in context; descriptions stay terse; the plugin registers everything in one step.
16. **The shared server is also the human's.** Injected config may add MCP mounts but must never change agents, permissions or models. A horde server mounted into the human's own TUI sessions is harmless: without a task token its worker tools only read.
17. **Staying on v2 as it moves.** Legacy calls are confined to one adapter with a test guarding the boundary; CI also runs against OpenCode's `dev` tag (non-blocking) so v2 changes are seen early; `session.wait` and project copies are watched as replacements for polling and for the horde's own worktrees.

## 11. Open questions to verify empirically before building

- ~~An injected `mcp` local server connects and its tools appear in sessions~~ (answered in M2: connects, but v2 runners do not offer its tools).
- ~~One MCP process per server or per project directory~~ (answered: per directory, started lazily, cwd = the directory).
- `tools: {"*": false}` semantics in an agent profile; whether `/api/agent` exposes the resolved tool list to enumerate from.
- How reliably cheap models return valid JSON when asked in the prompt (drives the retry count in `opencode_ask`).
- `session.compact` behaviour on an idle session and what `session.context` reports; `session.revert.stage` semantics for a turn with several messages.
- `permission.edit` glob semantics: relative to the project root, and whether `write`/`patch` honour the same map.
- Whether `web-tree-sitter` WASM grammars load acceptably fast for the v2 `context`.

Each goes into a `probe/` script in the relevant package, like the probes used while building `opencode`, and becomes an integration test once the behaviour is confirmed.

## 12. Build order

| Milestone | Delivers | Why first |
| --- | --- | --- |
| **M0** ✓ `compat.ts` boundary + v2 health + `dev`-tag CI job | the v2 policy enforced in code | small, and it keeps every later milestone honest |
| **M1** ✓ `core` + `verify` + gates in `opencode` | mechanical verdicts; self-fixing workers (related-test selection moves to M3 with `context`) | the biggest trust and token win, and it needs no worker-side mounts |
| **M2** ✓ `board` (MCP for the orchestrator, an auto-approved CLI for workers) + the `horde` plugin with its skill | shared task graph, reports, findings, memory; the procedure, proven end to end by a mock run (`opencode/test/flow.test.ts`) | turns ad-hoc delegation into a tracked workflow |
| **M3** ✓ `context` v1 + `board_brief` composition + related-test gates | precise briefs; gates that run only the tests reaching the change (transitively through imports), with a full-suite fallback whenever that is not safe | closes most of the quality gap for fast models |
| **M4** `opencode_ask`, `scope`, `worktree sync`, `opencode_compact`, `opencode_revert`, `opencode_permissions`, `opencode_spawn { task }` | one-shot calls and judging; scope enforcement; conflict handling; context and undo for long tasks; fewer calls | refinements once the loop works end to end |
| **M5** tree-sitter `context`, `board` TUI, plugin packaging, npm publish | depth and distribution | after the shape is proven |

Each milestone ships with the same bar as `opencode`: unit tests, integration tests against a real `opencode serve` with the mock LLM, CI on Linux, macOS and Windows on Node 20 and 22, READMEs updated.

## 13. Non-goals

- Replacing OpenCode's agent loop, tools or provider layer. The horde drives OpenCode; it does not reimplement it.
- A web UI or cloud sync. State is local files; the TUI is the most that is planned.
- Security isolation between the orchestrator and workers beyond scope and audit. Sandboxing workers is OpenCode's and the OS's job.
- Supporting agent runtimes other than OpenCode as workers. The orchestrator side is runtime-agnostic through MCP; the worker side is OpenCode.
