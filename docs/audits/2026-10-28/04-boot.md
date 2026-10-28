# Scope 4 — Boot, failure modes, wire shapes, resources

Part of the 2026-10-28 audit. See [INDEX.md](INDEX.md) for the triage,
method, and caveats. Status legend: `[ ]` open / `[x]` closed
(record the closing commit SHA beside the checkbox).

## Scope summary

Boot and failure modes of the opencode server are mostly fail-fast with actionable messages (missing binary, stale/hung/unauthorized backend record, unwritable state dir, non-git directory), verified by live probes against the built servers; the four other servers boot without env in under 200 ms and the hooks stay inside their 5 s budget under a 10 s-slow git. The weak spots are around the shared backend's lifecycle: a backend that dies mid-task leaves the in-flight wait spinning for up to 60 s with a wrong diagnosis ('driven by another MCP session (pid undefined)'), and a record whose probe fails for a non-timeout transport reason or whose password is stale is simply forgotten, so a second `opencode serve` is spawned while the first keeps running as an orphan nobody can stop or attach to. The 1.38 GB RSS of pid 1049645 is explained by churn, not retention: every refresh re-reads the whole open turn and ~2 refreshes fire per step, so one 150-step worker with 30 KB tool outputs decodes ~650 MB of message JSON and peaks at ~640 MB heap, while the Fleet retains under 1 MB per agent after dispose (heap-snapshot verified); the server still logged a 2.6 GB heap high after the context-package fix. Worktree hygiene has real gaps: a failure between `git worktree add` and the cleanup `try` leaks the worktree and branch (the on-disk `agent-da39a3ee/t-ab0d` is exactly that, with the repository key computed from an empty top-level that `repoRoot` accepted and every git call silently running in the server's cwd), and nothing sweeps leftovers such as the Docker-recreated `t-0164` directory or empty per-repository folders. Wire shapes (OpenCode events, board report CLI, news file, hooks.json, MCP elicitation) and the ledger's producer/consumer chain check out, with small gaps noted (review cost not counted, opencode_dispose leaving board attempts open, channel pushes never enabled in the plugin install).

## BOOT-01 — A shared-server record that answers 'unauthorized' or fails its probe with a non-timeout transport error is forgotten and a second `opencode serve` is spawned; the first keeps running as an orphan that nothing can stop or attach to

- [ ] *(open)*
- **Severity:** medium · **Confidence:** high
- **Location:** `packages/opencode/src/backend.ts:106`

**Evidence:** Live probe P4 (probe-flow.ts): started backend A (pid 3409688) via `opencode_server info`; rewrote server.json with password 'wrong-password'; new server process: `opencode_models` -> 'answers but is not usable: unauthorized ... stop it with opencode_server stop'; `opencode_server stop` -> 'is not answering with its password ... so nothing was killed ... The record was cleared.'; probe log: 'P4 backend A pid 3409688 alive after stop? true server.json left? false'; next `opencode_server info` started backend B (pid 3409786); 'A still alive (orphan)? true same pid? false'. The probe had to SIGKILL A by hand. Code: backend.ts:106-117 (reachable -> throw; timedOut && pidAlive -> throw; otherwise forgetShared + spawn), backend.ts:227-243 stopServer clears the record without killing when `!probe.ok && !hung`, backend.ts:262-266 forgetShared also deletes the password file (so `opencode attach` is impossible afterwards). probeHealth (backend.ts:294-312) sets reachable=false for every ClientError with reason 'Transport' (ECONNRESET, socket hang-up, EPIPE), not only ECONNREFUSED, so an overloaded live backend that resets one connection takes the same forget-and-respawn path. Live machine: the current backend pid 15315 has 755 MB RSS (ps), so an orphan is not cheap.

**Why it matters:** The record is the only handle on the detached backend; clearing it while the pid is alive converts a recoverable state into a permanent process and memory leak with running agents invisible to every session. The 'nothing was killed (the pid may belong to another process now)' caution is right for a reused pid, but the recorded startedAt plus /proc start time (or the bin name) could tell a reused pid from a live `opencode serve`.

**Fix sketch:** When the pid is alive and its command line is `opencode serve` on the recorded port, treat unauthorized/transport failures as 'ours but unusable': kill it (as the hung path does) before spawning a new one, or refuse to spawn until it is gone; keep the password file until the process is confirmed dead.

## BOOT-02 — createWorktree leaks the worktree and branch when it fails between `git worktree add` and the cleanup try; `repoRoot` accepts an empty top-level, which produced the on-disk `agent-da39a3ee/t-ab0d` and ran every git call in the server's cwd

- [ ] *(open)*
- **Severity:** medium · **Confidence:** high
- **Location:** `packages/opencode/src/worktree.ts:174`

**Evidence:** On disk: ~/.local/share/mcp-horde/worktrees/agent-da39a3ee/t-ab0d (created 2026-10-24 21:11) is a registered worktree of /home/swr/workspace/digicorp (`cat .git` -> 'gitdir: /home/swr/workspace/digicorp/.git/worktrees/t-ab0d'; `git -C digicorp worktree list` shows it on branch horde/t-ab0d; `git branch --list horde/*` still has horde/t-ab0d). repoKey('') (packages/core/src/worktree.ts:18-20) = branchSlug(basename('')) -> 'agent' + sha1('')[:8] = da39a3ee. Board event (board/digicorp-2f5ca2bafc/events.jsonl line 87): '{"type":"fail","task":"t-ab0d","reason":"the agent could not start: ENOENT: no such file or directory, realpath ''"}' = worktree.ts:174 `fs.realpath(repo)` with repo ''. That line (and 173-175) sits after `git worktree add` (line 165) and before the `try` (line 177) whose catch (234-238) removes the worktree and branch, so the failure left both behind; the task record has no workspace (attempt 1 failed, ws None). Node test: `execFile('git', ['rev-parse','--show-toplevel'], {cwd: ''})` -> code null, stdout = the parent's cwd top-level (async execFile inherits cwd for ''), so `git('', 'worktree', 'add', ...)` (line 165) ran in the MCP server's process.cwd(), the digicorp checkout, which is why the worktree landed in that repository. git 2.56 prints a fatal error (exit 128) inside .git dirs, so what made `git rev-parse --show-toplevel` print an empty line with exit 0 for that spawn's directory could not be reproduced (tested: .git dir, linked worktree, symlink, nested repo, core.worktree, GIT_DIR/GIT_WORK_TREE); the code at that bundle (b90b37b) is identical to HEAD for repoRoot (lines 63-69) and createWorktree.

**Why it matters:** Two defects compose: repoRoot() returns whatever git printed without checking it is a non-empty absolute path, and the worktree-path computation that can throw is outside the cleanup block. The result is a leaked checkout (~1 GB for digicorp) and a branch under a nonsense repository key that `horde remove` (cli.ts:120-131) will only find because git still registers it.

**Fix sketch:** In repoRoot, throw unless the output is a non-empty absolute existing directory; move the realpath/sub computation above `git worktree add` (it needs only repo and directory) or inside the try; add a startup/dispose sweep that `git worktree prune`s and removes folders under the worktree root that no live record references.

## BOOT-03 — Leftovers under the worktree root that nothing sweeps: a Docker bind mount recreated the removed t-0164 worktree, empty per-repository folders accumulate, and records of vanished worktrees are hidden but never deleted

- [ ] *(open)*
- **Severity:** low · **Confidence:** high
- **Location:** `packages/opencode/src/worktree.ts:951`

**Evidence:** ~/.local/share/mcp-horde/worktrees/rp-integration-497e8607/t-0164 is not a git worktree (`git rev-parse` -> 'not a git repository'); it contains only two *directories* named infrastructure/nats/nats.conf and permissions.generated.conf, all with mtime 2026-10-26 15:25:21, while the board accepted t-0164 at 1793017510962 = 15:11:50 local (events.jsonl line 195) and removeWorktree had deleted the tree. `docker inspect` of the running container 703d35feec19 (/condescending_rubin, created 2026-10-28T11:44:18Z) shows bind mounts of .../rp-integration-497e8607/t-83d7/infrastructure/nats/nats.conf and permissions.generated.conf, i.e. the project's checks start a container that mounts files from the worktree (digicorp/agent-runtime/tests/conftest.py and infrastructure/docker-compose.yml reference them); a container (re)started after the worktree is gone makes Docker create the mount sources as directories. Empty folders left by removeWorktree (it removes wt.root, never its parent): mcp-horde-b18050dd, digicorp-4fd3e73e, loracraft-976761e2, dsh-su-68eaef0c, repo-61361613, rp-cf349335, wl165-summary-30837722, wl375-search-b30a94df (ls -la). `horde remove` (packages/board/src/cli.ts:120-131, 212-218) only removes entries `git worktree list` reports and the now-empty parent of those, so the t-0164 directory survives it. state.ts:196-197 skips records whose worktree root vanished but never unlinks the file. No startup or shutdown sweep exists (index.ts:117-125 shutdown only closes; fleet.close() hands agents over). OpenCode's own per-directory MCP servers (duckduckgo-mcp-server, one per live worktree, ppid 15315) are evicted correctly: none with a deleted cwd was found.

**Why it matters:** Each item is small, but together they mean the worktree root only grows across weeks of daily use on several repositories, and a check that starts containers can resurrect deleted paths. The horde cannot know about external resources a check created, but it could warn when a removed worktree path reappears or when a check leaves processes/containers behind, and it could prune empty repository folders.

**Fix sketch:** removeWorktree: rmdir the per-repository folder when empty; a startup sweep under config.worktreeDir removing folders with no record and no git registration (after `git worktree prune`), logged to stderr; `horde remove`: also delete unregistered directories under the repository's folder; Store.agents: delete records whose worktree root is gone.

## BOOT-04 — horde_do in a non-git directory fails fast but creates a board for the plain directory, records a failed task, and records the start failure twice

- [ ] *(open)*
- **Severity:** low · **Confidence:** high
- **Location:** `packages/opencode/src/horde.ts:157`

**Evidence:** Live probe P6 (probe-flow.ts): `horde_do {goal, directory: <plain dir with horde.json>}` -> 152 ms ERR 'isolation "worktree" needs a git repository, but .../pflow/plain is not inside one'; afterwards the board state root contained 'plain-3a328ff7dc/t-8a1d status=failed attempts=1 note=the agent could not start: isolation "worktree" needs a git repository...'. board.ts:128-144 projectOf falls back to the directory's realpath when git fails, so a board is created for any directory. Double recording: fleet.ts:1022 `board.fail(taskId, {reason: 'the agent could not start: ...'})` and then horde.ts:157-159 `board.fail(task.id, {reason: 'could not start: ...', retry: false})`; the digicorp board shows both for t-ab0d (events.jsonl lines 87-88: two consecutive 'fail' events 3 ms apart).

**Why it matters:** The error is right and immediate (fail-fast), but the side effects leave a stray board directory keyed by a non-repository and duplicate failure events that the ledger and `horde watch` show as history.

**Fix sketch:** Check `git rev-parse --show-toplevel` in horde_do before board.plan (as detectChecks already needs it), and let only one layer close the attempt (fleet.ts:1022 already does; horde.ts could skip when the task is already failed).

## BOOT-05 — opencode_dispose of a task-bound agent never closes its board attempt: the task stays 'working' and the ledger learns nothing

- [ ] *(open)*
- **Severity:** low · **Confidence:** high
- **Location:** `packages/opencode/src/fleet.ts:1415`

**Evidence:** fleet.ts:1415-1462 disposeHeld() interrupts, records activity (recordTaskActivity), commits/removes the worktree and forgets the record; there is no board.accept/board.fail. horde_drop (horde.ts:367-371) and horde_land (fleet.ts:1609, 1734) close attempts themselves before calling dispose. ledger.ts:80 `if (!a.endedAt || (a.outcome !== 'accepted' && a.outcome !== 'failed') || neverRan(a)) continue` skips open attempts. tools.ts:714-724 exposes opencode_dispose for any agent id, including task-bound ones (the instructions at tools.ts:790 recommend it for isolated agents).

**Why it matters:** A user or model that disposes a horde task through the lower-level tool leaves the board showing a STALE working task until something reassigns it (board.ts:351 endAttempt 'abandoned' only on the next assign), and the attempt's model/cost never reach the ledger's statistics.

**Fix sketch:** In disposeHeld, when record.task is set and the attempt is still open, call board.fail(..., {reason: 'disposed', retry: false}) (or 'abandoned' through a board method) before forgetting the record.

## BOOT-06 — Backend lifecycle: started lazily, stopped by nobody, reused across plugin and opencode versions with only a bin-string comparison and an 'untested' warning shown by opencode_status

- [ ] *(open)*
- **Severity:** low · **Confidence:** high
- **Location:** `packages/opencode/src/backend.ts:89`

**Evidence:** Who starts it: index.ts:72-88 getBackend on the first tool call (never at boot, index.ts:57-59), spawnShared backend.ts:427-472 detached + unref. Who stops it: only stopServer (backend.ts:227-260) via opencode_server stop; shutdown (index.ts:117-125) and Backend.close (216-220) leave a shared server running. Live: server.json {pid 15315, startedAt 1792966769047 (2026-10-26 01:19), version '2.1.4', bin 'opencode'}; `ps` shows pid 15315 `opencode serve --hostname 127.0.0.1 --port 44879` up 2-13:04 with 755 MB RSS, parent 1509 (init), serving four Claude sessions' servers. Compatibility: backend.ts:89-91 warns only when `known.bin !== bin.command` (the string 'opencode'), backend.ts:158-162 compares the server's major.minor with TESTED_OPENCODE {2,1} and pushes a warning that tools.ts:255-257 appends only to opencode_status output. On this machine PATH `opencode --version` = v2.1.4 while the plugin's SDK/CLI (packages/opencode/package.json: @opencode/client 2.1.1, node_modules/.bin/opencode v2.1.1) differ at the patch level; an `opencode` upgrade or a plugin upgrade changes nothing about the running backend until someone runs opencode_server stop. The record carries `version` but it is never compared with a fresh `opencode --version`.

**Why it matters:** By design the backend outlives sessions so agents survive restarts, which is good; but after a plugin or OpenCode upgrade the orchestrator silently keeps talking to the old server (and old OpenCode code) for days, and the only hint is a warning on a tool most flows never call.

**Fix sketch:** Record the binary's version at spawn and, on reconnect, compare with `opencode --version` of the configured bin (or the SDK's expected version); surface the warning on horde_do/horde_wait results once per process; optionally stop an idle shared server (no live sessions on it) after a grace period.

## BOOT-07 — News file: `at` is refreshed only when the lists change, so the hook's 24 h staleness rule silences a session whose outcomes waited a day; the file is removed when the backend dies

- [ ] *(open)*
- **Severity:** low · **Confidence:** high
- **Location:** `packages/opencode/src/news.ts:57`

**Evidence:** news.ts:55-59 update(): `const key = JSON.stringify([waiting, working]); if (key === this.last) return` — the body (with `at: Date.now()`, line 64) is only rewritten on a change. plugins/horde/hooks/news.mjs:14 `STALE_MS = 24 * 60 * 60 * 1000` and :47 `if (typeof saved.at !== 'number' || Date.now() - saved.at > STALE_MS) return undefined`. fleet.ts:546 close() returns this.news.remove() and index.ts:63-70 reset() calls close() when the backend dies, so the file disappears while tasks are still recorded as in flight. Field shapes otherwise match (writer: {pid, at, waiting:[{id,title,kind}], working:[{id,title}]}; reader news.mjs:46-48, 67-76), as do the stateDir rule (config.ts:106 vs news.mjs:52-56) and the session id source (CLAUDE_CODE_SESSION_ID env of the server process, seen in /proc/1049645/environ, vs the hook's input.session_id).

**Why it matters:** A session left overnight with an uncollected outcome is exactly when the reminder is useful; the writer and reader disagree on what `at` means (last change vs last confirmation).

**Fix sketch:** Treat `at` as a heartbeat: rewrite the file at least every few hours while lists are non-empty (or drop the 24 h rule and rely on the pid check), and keep the file across a backend restart.

## BOOT-08 — Test harness leaves a temp git repository per run under /tmp: 763 'horde-oc-*' directories, 1.6 GB, in two days

- [x] closed in 9bfba96 — **Executed evidence:** packages/opencode/test/harness.ts removes every makeRepo temp dir at process exit: running test/plugin.test.ts left the count of /tmp/horde-oc-* directories unchanged (793 before, 793 after; the 793 predate the fix and are the user's to delete)
- **Severity:** low · **Confidence:** high
- **Location:** `packages/opencode/test/harness.ts:31`

**Evidence:** `ls -d /tmp/horde-oc-* | wc -l` -> 763; `du -sch /tmp/horde-oc-*` -> 1.6 GB total; oldest 2026-10-26 13:55. harness.ts:31 `fs.mkdtempSync(path.join(os.tmpdir(), 'horde-oc-'))` with no matching removal; `grep -rn 'rmSync(tmp' packages/opencode/test/*.ts | wc -l` -> 1 (only one test file cleans its tmp). scripts/test-env.mjs removes only the state home it creates.

**Why it matters:** Not a product defect, but on the development machine (and CI runners that persist /tmp) the test suite is a steady disk leak; the probes in this audit added five more.

**Fix sketch:** Return the tmp from makeRepo and remove it in each suite's after(), or register it on process exit like test-env.mjs does for the state home.

## BOOT-09 — Channel notifications never fire in the plugin install: HORDE_OPENCODE_CHANNEL is off by default and .mcp.json sets no env, yet the instructions describe them

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `packages/opencode/src/config.ts:108`

**Evidence:** config.ts:108 `channel: bool(env.HORDE_OPENCODE_CHANNEL, ...)` (false unless set); plugins/horde/.mcp.json passes only command/args, no env; hooks.ts:128-139 settled() returns early `if (!config.channel)`; index.ts:53 declares the `claude/channel` capability only when config.channel. tools.ts:791 INSTRUCTIONS still say 'If channel notifications are enabled, a <channel source="opencode"> message arrives whenever an agent settles'. /proc/1049645/environ has no HORDE_OPENCODE_CHANNEL.

**Why it matters:** Harmless, but the only push path from workers to the session is dead in the shipped configuration; the news-file hook is the de-facto replacement.

**Fix sketch:** Either set HORDE_OPENCODE_CHANNEL in the plugin's .mcp.json once Claude Code's channels leave research preview, or drop the sentence from the instructions.

## BOOT-10 — Wire shapes verified: OpenCode events, board report CLI, hooks.json contract, MCP elicitation, ledger chain

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `packages/opencode/src/fleet.ts:2919`

**Evidence:** (a) Events: every type string in fleet.ts:2919-2967 (session.created, session.text.delta/started, session.step.started/ended/failed, session.retry.scheduled, session.inbox.delivered, session.tool.success/failed, session.execution.*, session.idle, session.status, session.revert.committed, session.compaction.ended/failed, permission.*, form.*) exists in node_modules/@opencode/client/dist/effect/client.d.ts (grep of `type: "..."` literals, 100 types); payload fields used match: session.text.delta data {sessionID, delta} (d.ts:1147-1157), session.step.ended data.finish (1054-1057), session.retry.scheduled data.attempt (1471-1475), permission.asked data.sessionID (1902-1904), form.created data.form.sessionID (2213-2216), session.created data.parentID/sessionID. Ignored but relevant: session.deleted (d.ts:557-569; a deletion is only noticed when a refresh gets 404, fleet.ts:1905-1911) and server.connected (2551-2552; could detect a backend restart). (b) Board report: brief render.ts:92-99 emits `report <id> <token> --summary ... --changed a,b --tests ... --unverified ... --confidence high`; cli.ts:26-41 VALUE_FLAGS and 263-278 parse --changed/--tests as CSV into filesChanged/testsAdded, --unverified/--decision/--question repeated, --confidence validated; board.ts:550-591 caps the report; command.ts:97-106 trusts only the exact argv prefix + `--state <this board dir>` + a worker subcommand (fleet.ts:2384-2398). (c) hooks.json: SessionStart matcher 'startup|resume|clear|compact|fork' — all five valid per code.claude.com/docs/en/hooks; PostToolUse matcher 'Edit|Write|MultiEdit|NotebookEdit|Bash|mcp__plugin_horde_opencode__horde_do' is an exact-name list by the documented rule; Stop output {decision:'block', reason} and UserPromptSubmit/SubagentStart/PostToolUse hookSpecificOutput.additionalContext are documented; Stop input documents background_tasks[] with a `tool` field for MCP tasks, which news.mjs:122 matches by /horde_wait$/ (tolerant to bare or prefixed names); SubagentStart additionalContext was observed delivered in this very session. (d) Elicitation: @modelcontextprotocol/server 2.3.1 implements LATEST_PROTOCOL_VERSION '2025-11-25' (core/dist/auth-BNDyLTqp.mjs:4); hooks.ts:80-101 sends {message, requestedSchema} without `mode`, which the SDK fills as 'form' (mcp-DIH4cS6P.mjs:1512-1516); live probe PE with a client declaring the bare `elicitation: {}` capability still received the permission dialog ('PE elicitation dialogs the client saw: 1'), so hooks.ts:73-77 canElicit() matches SDK behaviour. (e) Ledger: model/cost reach the attempt via fleet.ts:2308-2338 recordTaskActivity -> board.ts:417-427 recordActivity; closures: land accept (fleet.ts:1734; 1609 for already-on-branch), horde_drop fail or accept with landed:true (horde.ts:367-371), start failures excluded by ledger.ts:71 neverRan. Gap: the gate review's cost (record.gateState.verdict.review.cost) is only added for display (horde.ts:659-663) and never to the attempt's cost, so ledger costPerAccepted undercounts by the reviewer's spend.

**Why it matters:** Producers and consumers agree on every field inspected; the two gaps (review cost, session.deleted) are small.

## BOOT-11 — Failure-mode classification matrix (live probes against the built servers, plus code bounds)

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `packages/opencode/src/backend.ts:53`

**Evidence:** Probes in scratchpad/audit/boot/probe-boot.log, probe-flow.log (built dist servers via the MCP client, isolated state dirs, mock LLM): [opencode binary missing] FAIL-FAST: 31 ms 'Failed to launch `/nonexistent/opencode`: spawn ENOENT. Install opencode or set HORDE_OPENCODE_BIN / HORDE_OPENCODE_URL' on every tool call, server stays up (backend.ts:448-449, 468). [stale server.json, dead pid, closed port] SELF-HEALING: probe fails -> forgetShared -> spawn attempt; server.json removed (backend.ts:117; P2 'server.json still there? false'). [recorded backend hung: pid alive, port accepts, never answers] BOUNDED 5 s: 'is not responding. Stop it with opencode_server stop, then retry' (backend.ts:112-116, probeHealth timeout 5 000 ms); `opencode_server stop` killed the pid and cleared the record (P3: 'sleeper alive after stop? false'). [recorded backend unauthorized / non-timeout transport error] FAIL-FAST with remedy but ORPHANING on stop (finding 2). [state dir unwritable] FAIL-FAST: stderr at boot '[mcp-horde/opencode] mcp-horde/opencode is misconfigured: EACCES ... mkdir .../state/agents' and the same text as the error of every tool call (index.ts:26-41); handshake still succeeds. [directory not a git repo] FAIL-FAST 152 ms with side effects (finding 7). [detached HEAD] LATE FAILURE at land (finding 6). [backend dies mid-task] BOUNDED min(timeout, 60 s) with a wrong diagnosis, recovery on next call, records re-claimed and derived ERROR after GRACE_MS 10 s (finding 1). [board/verify/context/ledger without HORDE_* env, cwd not a repo] CLEAN: connect in 119-187 ms; board_summary 'The board is empty', verify_detect 'no checks found: add verify.checks to horde.json', context_map 'plain: 0 files', ledger_stats 'No closed attempts' (P9). [hooks with a 10 s-slow git] BOUNDED: delegate.mjs PostToolUse 3.03 s (3 s git budget, delegate.mjs:53-60; it then silently reports no edits), SessionStart 0.02 s, news.mjs Stop 0.02 s, all under the 5 s hooks.json timeout; real digicorp `git status --porcelain -z --untracked-files=all` takes 0.02 s. [refresh/poll loops] per request REQUEST_MS 30 s + 5 s grace (fleet.ts:82-84, 307-335), directory-scoped LONG_REQUEST_MS 120 s (86), REFRESH_MS and TICK_MS 120 s (90-92, 1888-1895, 2991-2998), waits end at their deadline via untilDeadline even with a request hanging (2869-2893, forced >= 1 s round), unreadable agents give up after UNREADABLE_MS 60 s (152-157), models()/agents() catalog retry 20 x 250 ms (613-617, 656-660), compact 120 s (2610), untilInactive 10 s (1854), gate review 600 s + one retry (88, 850-864), event stream reconnect backoff 250 ms -> 10 s and death after 3 empty reconnects (backend.ts:170-206), spawnShared 3 x 60 s (430-470), waitForCatalog 20 s (325-332), cross-process locks 120 s / lockSync 1 s with 200 ms budget for record updates (state.ts:216-229, 267-332; core/files.ts:74-136), git child processes 120 s (core/git.ts:7-9), check commands 600 s default (core/process.ts:158, verify). No unbounded hang was found; the only silent degradations are the hook's no-op under a slow git and the news-file gaps (finding 10).

**Why it matters:** Boot paths are deliberately lazy (the MCP handshake never waits on OpenCode) and every blocking call has a local deadline; the matrix is the reference for the other findings.

## BOOT-12 — Log and state growth is bounded or slow: servers.log append-only (~68 KB/week), backend log per server lifetime, verify logs replaced per run and removed with their worktree, board events append-only, reports never pruned

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `packages/core/src/process.ts:15`

**Evidence:** process.ts:15 'ponytail: the log only grows'; ~/.local/state/mcp-horde/servers.log is 60 974 bytes after a week (ls -la). opencode-server.log is opened with 'w' per backend start (backend.ts:432) and has 651 lines after 2.5 days (grep -c), no error lines. verify: run.ts:57-60 one log dir per directory 'the latest run replaces the previous one', fleet.ts:1455 removes a disposed worktree's log dir, gate.ts:214 removes baseline log dirs; `du -sh` verify 2.3 MB, 152 files, 27 dirs. board: board.ts:190-192 events.jsonl appended per event, never compacted; digicorp board 30 016 bytes for 45 tasks; `du -sh board` 3.3 MB. opencode/reports: horde.ts:846-857 writes one JSON per investigation, nothing deletes them (21 files, 364 KB). Node fatal-error reports go next to servers.log (process.ts:28-31); none present.

**Why it matters:** None of these will matter for months of daily use; noted so the 'ponytail' remains a conscious choice.
