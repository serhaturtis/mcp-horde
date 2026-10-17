# @mcp-horde/board

A shared task board for an orchestrating model and its workers. The orchestrator (Claude in Claude Code, or any MCP harness) plans tasks, hands each worker a brief, and reads structured reports instead of transcripts. Workers report progress, share findings, take file locks and file their report through a small CLI.

One board per repository, shared by every worktree of it, stored as plain files under your state directory. There is no daemon: the orchestrator's MCP server and every worker's CLI read and write the same files under a cross-process lock.

## The loop

```text
board_plan     → t-3fa2 "Rate-limit login", t-9c1e "Document the limit" (after t-3fa2)
board_brief    t-3fa2 agent:"limiter"   → the worker's prompt, with its reporting commands
opencode_spawn name:"limiter" prompt:<brief> isolation:"worktree" gate:true
opencode_wait  → limiter IDLE · gate: ✓ PASS (round 1/2)
board_task     t-3fa2 → report: "Added a sliding-window limiter…" · tests added: … · unverified: "did not load-test"
board_accept   t-3fa2 → done. Now ready: t-9c1e
```

`board_summary` is the one status call the orchestrator needs:

```text
3 tasks: 1 done, 1 working, 1 review · $0.06
review  t-9c1e "Document the limit": Updated docs/api.md… (confidence high)
working t-77ab "Client retries" (agent retry, attempt 1, last seen 2m ago: "writing tests")
next    t-41d0 "Expose the limit in settings"
locks   src/shared/rate.ts → t-77ab
```

## Orchestrator tools (MCP)

| Tool | What it does |
| --- | --- |
| `board_plan` | Adds tasks: title, goal, acceptance criteria, scope (paths), dependencies (by id, or by title within the plan), starting tier. Refuses cycles; warns when tasks that could run in parallel have overlapping scopes. |
| `board_next` | Tasks that are ready: open, with every dependency done. |
| `board_brief` | Starts an attempt and returns the worker prompt: goal, done criteria, scope, relevant project notes and findings, and the exact commands to report with (including a token for this attempt). A new brief ends the previous attempt. |
| `board_task` | One task with its latest report (changes, tests added, unverified claims, questions). |
| `board_accept` / `board_fail` | Close the attempt. Failing reopens the task by default; `escalate` raises its tier, `retry: false` gives it up. |
| `board_block` / `board_edit` | Park a task on an outside decision; change or reopen it. |
| `board_summary` | Counts, reviews, running and stale attempts, blocked/failed, what is next, held locks. |
| `board_remember` / `board_recall` / `board_forget` | Project notes, included in later briefs by path and word overlap. |
| `board_findings` | Facts workers shared while working. |
| `board_unlock` | Break a dead worker's lock (locks also expire 30 minutes after the worker's last activity). |

## Worker commands (CLI)

The brief contains the exact commands, so workers never have to construct them:

```sh
<horde> --state <board> task t-3fa2 <token>                    # read the task (marks the attempt as working)
<horde> --state <board> progress t-3fa2 <token> "writing tests" # optional; renews locks
<horde> --state <board> finding "login reuses the session middleware" --paths "src/api/login.ts" --task t-3fa2 --token <token>
<horde> --state <board> lock t-3fa2 <token> "src/shared/rate.ts" # before editing outside the scope
<horde> --state <board> report t-3fa2 <token> --summary "…" --changed "a.ts,b.ts" --tests "a.test.ts" \
        --unverified "did not load-test" --question "…" --confidence medium
```

The token ties a worker to its attempt: after a new `board_brief` for the same task, the old worker's commands are refused. Planning, accepting and failing are not reachable from the CLI.

### Why a CLI and not MCP tools for workers

OpenCode's v2 session runner does not offer MCP tools to agents yet (verified on 1.19.3 and the `dev` build): an MCP server configured for OpenCode connects, but only the legacy runner shows its tools. Workers therefore use their `bash` tool. `@mcp-horde/opencode` approves exactly these commands without asking anyone, whatever the agent's permission policy, and nothing else: a command is trusted only if it is this installation's CLI, with a worker subcommand and plain arguments. `;`, `&&`, `||`, pipes, redirects, `$`, backticks, backslashes and newlines anywhere make it untrusted, and it goes through the normal policy. (So a board command run by a different installation of the horde, or with a different Node binary, simply asks for permission as usual.) A canary test watches for v2 runners gaining MCP tools.

## Storage

`~/.local/state/mcp-horde/board/<repo>-<hash>/` (`HORDE_BOARD_STATE_DIR` changes the root): one JSON file per task, append-only `findings.jsonl`, `memory.jsonl` and `events.jsonl`, and `locks/`. The `<hash>` comes from the main checkout's real path, so all worktrees of a repository share a board.

## Setup

```sh
claude mcp add board -- node /path/to/mcp-horde/packages/board/dist/index.js
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `HORDE_BOARD_DIRECTORY` | current directory | Repository whose board the tools use (each tool also takes `directory`). |
| `HORDE_BOARD_STATE_DIR` | `~/.local/state/mcp-horde/board` | Where boards are stored. |

## Known limits

- Briefs include project notes and findings, but not code context yet: `@mcp-horde/context` (milestone M3) adds the relevant files and symbols.
- Stale attempts (no worker activity for 30 minutes) are shown, never changed automatically: the orchestrator decides whether to re-brief, fail or wait.
