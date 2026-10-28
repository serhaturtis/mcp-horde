# Scope 0 — Ground truth and live execution

Part of the 2026-10-28 audit. See [INDEX.md](INDEX.md) for the triage,
method, and caveats. Status legend: `[ ]` open / `[x]` closed
(record the closing commit SHA beside the checkbox).

## Scope summary

Ground truth: ci.sh green in full (427 tests, none skipped), no hosted CI; one test file never runs; live state shows every long-running opencode server's heap climbing to 2-3 GB. Live phase: the five bundled servers were booted in an isolated state directory with a private backend and driven through the new-user journey twice (one broken sample repo, one corrected), an investigation, an impossible task, a detached HEAD, a missing binary, an invalid horde.json, an unwritable state directory and a backend killed mid-task. The core loop, the fail-fast boots, the audit's scope and rule-change catches, the news file and hooks all held; the backend-death recovery and the detached-HEAD start did not.

## LIVE-01 — Every opencode server's heap peaks at 2-3 GB in a day-long session, within reach of the 4.3 GB limit the design note says was handled

- [ ] *(open)*
- **Severity:** high **BLOCKING** · **Confidence:** high · **Also reported by:** boot: Open turns are re-read whole on every refresh (~2 refreshes per step): quadratic churn explains the 1.4-2.7 GB RSS and 'heap 2632 MB' highs of pid 1049645; retention per agent is under 1 MB
- **Location:** `packages/opencode/src/fleet.ts`

**Evidence:** grep 'new high' ~/.local/state/mcp-horde/servers.log (19 lines): pid 1049645 (digicorp session, started 2026-10-26T11:24): heap 570 MB at 11:36, 1426 MB at 14:31, 2163 MB at 17:11, 2632 MB at 21:17 (rss 2430 MB); pid 733930: 3048 MB; pid 3323301: 2051 MB; pid 199613: 1612 MB. `ps -o rss= -p 1049645` now: 1389740 KB after 2 days. docs/DESIGN.md (open questions) says the 2026-10-21 deaths were SIGABRT from a full heap against a 4.3 GB limit, blames signatureOf and ends 'Lines are now cut to 1,000 characters first: 38 MB and 2 s. A test keeps it there.' The live log shows the heap still growing by about 500 MB every few hours after that fix.

Also reported by boot (medium confidence): Live: /proc/1049645/status VmRSS 1 385 836 kB, VmHWM 2 714 912 kB, RssAnon 1 359 944 kB; servers.log lines 731-738: pid 1049645 started 2026-10-26T11:24 (bundle 45c8f81 of 10-25, which includes the signatureOf fix 1996c9b of 10-21), then 'heap 570 MB', '1426 MB', '2163 MB', '2632 MB (new high) ... rss 2430 MB' the same day; its 4 agent records (state dir agents/*.json) show 4 workers running right now. In-process probe (probe-memory2.ts, dist Fleet + real opencode + mock returning 30 KB per shell step, Fleet.prototype.conversation instrumented): one agent of 150 steps -> final turn 153 messages = 4.7 MB JSON; 317 conversation reads; 21 122 messages re-read in total (~654 MB of message JSON decoded); heap peak 636.9 MB without GC pressure; per-read time grew to 150-476 ms. probe-memory3.ts: heap snapshot after dispose aggregated by agg.mjs: the only large class was 155.3 MB of 'xxxx…' strings n=5050 = 101*100/2, which is the in-process mock's `requests.push(b)` (mock-llm.ts:30) keeping every request body, i.e. the probe's own harness, not Fleet; 'retained by the agent ≈ 0.7 MB' (settled 397.6 MB vs after dispose 396.9 MB, both after gc()). Events: 1 680 events for a 120-step agent (14 per step: step.started/streamed/ended, usage.updated, tool.input.*, tool.called, permission.asked/replied, shell.created/exited, tool.progress), every one delivered to every session's server by the shared backend. Code: fleet.ts:2016-2048 conversation() re-reads from the last `idle` marker (tracker.ts:124-127 stablePrefix) and the comment at fleet.ts:2029 'ponytail: an open turn is re-read whole on every refresh'; fleet.ts:2964-2972 triggers refresh on step/tool/execution/status events; Track.messages (tracker.ts:72) keeps the whole conversation per tracked agent while it lives.

**Why it matters:** A session that runs the horde for a day or two can hit the V8 limit and lose its opencode server mid-task (no exit handler runs, Claude Code does not restart it). The 10-21 signatureOf fix removed one spike; the boot scope found the remaining cause: open turns are re-read whole on every refresh, so transient allocation grows quadratically with a long transcript (654 MB decoded for one 150-step agent), while retention after dispose stays under 1 MB. Peaks, not a leak, but a peak past the limit is the same crash.

**Fix sketch:** Read the open turn's tail incrementally (page from the newest known message id) and coalesce refreshes per step instead of per tool event; add a test that runs one 150-step agent against the mock LLM and asserts a bounded heap peak; consider raising --max-old-space-size for the plugin's server as a stopgap.

## LIVE-02 — A backend that dies mid-task leaves the task stranded behind a misleading 'driven by another MCP session (pid undefined)' answer

- [ ] *(open)*
- **Severity:** high **BLOCKING** · **Confidence:** high · **Also reported by:** boot: Backend death mid-task: the in-flight wait spins on a closed Fleet with a misleading 'driven by another MCP session (pid undefined)' error; recovery only on the next tool call
- **Location:** `packages/opencode/src/fleet.ts:3142`

**Evidence:** Live probe (scratchpad/audit/live/out/backend-dies/journey.log): horde_do t-78bb (worker runs `sleep 120`); after 25 s SIGKILL of the private backend (pid 3245998); horde_wait {ids:[t-78bb]} returned after 60223 ms: 'Could not read: ses_e7dba1c2dffeVOK7BB2b9Llbxk: agent "ses_e7dba1c2dffeVOK7BB2b9Llbxk" is driven by another MCP session (pid undefined); use that session, or close it first'. opencode_status afterwards: '◆ t-78bb — RUNNING · doing: shell: sleep 120' (stale). A following horde_do t-a306 started a new backend transparently and reached READY in 27 s, so new work recovers; the in-flight task never does and only horde_drop clears it. The message comes from Fleet.get (fleet.ts:3142) when the record is in the store but not live and not adopted; owner undefined means close() cleared it (fleet.ts:531-536).

Also reported by boot (high confidence): Live probe PD (probe-flow.ts, built dist server + real `opencode serve` + mock LLM): spawned 'STEPS: 80', SIGKILLed the backend pid 3409932 after 4 s, then `opencode_wait {timeout_seconds: 40}` returned after the full 40 003 ms: 'Timed out after 40s: 0 with news, 0 still running ... Could not read: ses_e7db1baaaffe5W3hXScN4HaAnn: agent "ses_..." is driven by another MCP session (pid undefined); use that session, or close it first'. The record on disk then had owner undefined (cleared by fleet.close()). The next call (`opencode_status`, 1 090 ms) started a new backend (server.json pid 3425413), re-claimed the agent and showed it RUNNING with stale 'doing: starting'; a further `opencode_wait` settled it after 10.8 s as ERROR 'the turn stopped without finishing; OpenCode could not run it ...'. Code path: backend.ts:170-213 pump() marks dead after 3 empty reconnects -> index.ts:63-70 reset() closes the Fleet -> fleet.ts:529-547 close() clears live and writes owner: undefined -> the wait loop (fleet.ts:2805-2866) keeps calling snapshot() on the closed instance -> get() (fleet.ts:3135-3143) finds the ownerless record in the store and throws the 'another MCP session' error; waitedOut() (fleet.ts:152-157) only gives up after UNREADABLE_MS = 60 s.

**Why it matters:** The shared backend restarted at least once during real use this week (its pid went from 4088666 to 15315); every task in flight across the four sessions then shows this answer, which blames another session instead of saying the OpenCode session is gone. The orchestrator cannot tell a crash from a conflict and the status keeps lying.

**Fix sketch:** In get(): when the stored record's session is unknown to the backend (sessions list) or its owner is undefined, answer 'its OpenCode session is gone (the backend restarted at <time>): horde_tell restarts the work from its worktree, horde_drop gives it up' and mark the record settled with an error instead of RUNNING.

## LIVE-03 — packages/opencode/test/support-fixes.test.ts (22 tests) has never run under npm test

- [ ] *(open)*
- **Severity:** medium **BLOCKING** · **Confidence:** high · **Also reported by:** gates: packages/opencode/test/support-fixes.test.ts (22 passing tests) is never run by npm test or ci.sh; e2e.test.ts only with --live
- **Location:** `packages/opencode/package.json:35`

**Evidence:** node -e 'require("./packages/opencode/package.json").scripts.test' lists test/unit, core, modes, flow, dist, plugin, fleet-fixes, horde (8 files); the directory holds 10 *.test.ts (e2e is run by test:e2e, support-fixes by nothing: `git log -S'support-fixes.test.ts' -- packages/opencode/package.json` prints nothing). Run in isolation with the script's flags: '# tests 22 # pass 22 # fail 0 … duration_ms 7278' (scratchpad/audit/support-fixes.log). It covers permission requests, ask schemas, server support and worktree fixes (its describe blocks).

Also reported by gates (high confidence): packages/opencode/package.json test script lists `test/unit.test.ts test/core.test.ts test/modes.test.ts test/flow.test.ts test/dist.test.ts test/plugin.test.ts test/fleet-fixes.test.ts test/horde.test.ts`; `git log -S"support-fixes" -- packages/opencode/package.json` → no commit ever listed it (file added b7f7daa 2026-10-18). Ran it: `node --conditions=source --import tsx --import ../../scripts/test-env.mjs --test --test-concurrency=1 test/support-fixes.test.ts` → `# tests 22 / # pass 22 / # fail 0` in 7.5 s (log scratchpad/audit/gates/support-fixes.log). It covers permission dialogs/approval (hooks.ts), ask schemas and profiles, server attach/password/supervisor process-group stop/bad-config handshake, and worktree fixes (anchored excludes, baseline carry rules, secret-looking files, sync merge-commit refusal, baseline identification, identity fallback, dependencyLinks, createWorktree at a commit). Every other packages/*/test/*.test.ts is listed; plugins/horde/hooks/*.test.mjs run via pretest (28 pass). Test files are typechecked (tsconfig.test.json include [src, test]) and linted (biome.json excludes only dist, node_modules, package-lock, plugins/horde/servers, evals mocks/results).

**Why it matters:** Twenty-two passing tests are not protecting anything: a regression in permission handling, ask schemas or worktree fixes would not fail ci.sh. The root cause is structural: test files are listed by hand (the audit-false-positive on script changes pushes authors to avoid touching the list).

**Fix sketch:** Add the file to the script, or switch the scripts to a glob (`--test 'test/*.test.ts'` minus e2e) so a new file cannot be forgotten.

## LIVE-04 — horde_do starts a paid worker on a detached HEAD although only horde_land refuses it

- [ ] *(open)*
- **Severity:** medium · **Confidence:** high · **Also reported by:** boot: horde_do starts and pays a worker on a detached HEAD; only horde_land refuses, after the work is done
- **Location:** `packages/opencode/src/horde.ts`

**Evidence:** Live probe (scratchpad/audit/live/out/detached/journey.log): `git checkout --detach HEAD` in the sample repo, then horde_do → 't-035f working … worktree horde/t-035f' (1685 ms). grep -n detached packages/opencode/src: only worktree.ts:651, 856, 885 and fleet.ts:1586 throw 'your checkout … is on a detached HEAD; switch to a branch first', all on the sync/land paths.

Also reported by boot (high confidence): Live probe P7 (probe-flow.ts): `git checkout --detach` in the test repo ('## HEAD (no branch)'), then `horde_do {goal: 'say hi'}` -> 530 ms OK: 't-0f69 working: "say hi" · mock/mock (tier 0 of 2) · worktree horde/t-0f69 ... → horde_wait' with no warning. fleet.ts:1585-1586: `const target = await git(wt.repo, 'symbolic-ref', '-q', '--short', 'HEAD').catch(() => ''); if (!target) throw new Error('your checkout ... is on a detached HEAD; switch to a branch first')` runs only in landLoop. horde.ts:131-135 (horde_do) checks for checks and a committed horde.json but not for a branch.

**Why it matters:** The worker runs, costs money and reaches READY, and only then the orchestrator learns the branch cannot take it; the workaround is to check out a branch and land again, which works but is a surprise. horde_do already refuses an uncommitted horde.json before starting; the same check belongs here.

**Fix sketch:** In horde_do (and horde_investigate's spawn path, which needs no branch: leave it), refuse when `git symbolic-ref -q --short HEAD` is empty, with the land message, before any worktree is created.

## LIVE-05 — DESIGN.md §4.2 describes worker-side MCP injection (OPENCODE_CONFIG_CONTENT, HORDE_WORKER_TOOLS) that the source never contained

- [ ] *(open)*
- **Severity:** medium · **Confidence:** high
- **Location:** `docs/DESIGN.md:149`

**Evidence:** docs/DESIGN.md:149: 'When `opencode` starts the shared or private server it sets `OPENCODE_CONFIG_CONTENT` with `mcp` entries for the worker-side horde servers … (`HORDE_WORKER_TOOLS=board,context,verify` …)'. grep -rn 'OPENCODE_CONFIG\|CONFIG_CONTENT\|HORDE_WORKER_TOOLS' packages/*/src → no hits (only a canary in packages/opencode/test/modes.test.ts:163). `git log -S'OPENCODE_CONFIG_CONTENT' -- packages/opencode/src` → nothing: it was never in the source.

**Why it matters:** The design document is listed as canonical truth after the source; a paragraph describing a mechanism that does not exist sends a reader (or a worker briefed with it) looking for config that is never set. §4.2's own §97 note already says workers keep the CLI.

**Fix sketch:** Replace the paragraph with what exists: workers get the board CLI through their brief; no MCP servers are injected into OpenCode.

## LIVE-06 — A worker wrote through the shell what the edit rule refused, and only the gate caught it, one round later

- [ ] *(open)*
- **Severity:** low · **Confidence:** high
- **Location:** `plugins/horde/skills/horde/SKILL.md`

**Evidence:** Journey log (scratchpad/audit/live/out/journey/journey.log), task t-42fa: 'refused outside its scope: edit package.json' and, in the same outcome, 'changed 3 file(s): package.json, src/add.js, test/add.test.js' with a package.json hunk; the audit then blocked on scope and on 'changes the rules the gate checks with: package.json scripts test'. The skill (SKILL.md, horde_do's scope line) says 'Edits elsewhere are refused (the outcome lists any it tried)', which reads as prevention.

**Why it matters:** Scope confines OpenCode's edit tools only; a shell write lands in the tree and is caught at the gate, so the worker spends a round and the orchestrator reads a contradictory outcome (refused, yet changed). Defence in depth works; the wording and the brief do not say so.

**Fix sketch:** Brief: 'a shell write outside your scope fails the audit just the same'; outcome: 'changed through the shell after the edit was refused: package.json'.

## LIVE-07 — Observation: a task that failed its gate twice stays in board state 'review' and holds a lock on a path outside its scope

- [ ] *(open)*
- **Severity:** low · **Confidence:** medium
- **Location:** `packages/opencode/src/fleet.ts`

**Evidence:** Journey log, board_summary after t-42fa FAILED (checks failed after 2 rounds): '3 tasks: 1 done, 1 review, 1 failed · review t-42fa …; locks package.json → t-42fa'. t-42fa's scope was src/add.js, test/add.test.js; the lock names package.json, the file it changed through the shell.

**Why it matters:** 'review' is defensible (the task is open for horde_tell) but the summary reads as if a verdict were pending, and the lock blocks other tasks from a file this one may not touch. Low: a drop clears both.

**Fix sketch:** Show gate-failed tasks as 'failed (open)' in board_summary, and lock only paths inside the task's scope.

## LIVE-08 — Verified clean: cold-start failure modes fail fast with exact messages

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `packages/opencode/src/index.ts`

**Evidence:** scratchpad/audit/live/out/{nobin,badjson,unwritable}/journey.log: HORDE_OPENCODE_BIN=/nonexistent → horde_do answers in 39 ms 'failed to launch /nonexistent/opencode: spawn … ENOENT'; a horde.json with a trailing comma → 'misconfigured: <path>/horde.json is not valid JSON: Expected double-quoted property name … (line 1 column 49)' in 4 ms; state dir mode 500 → 'misconfigured: EACCES: permission denied, mkdir …/agents' in 7 ms. Each also goes to stderr once.

**Why it matters:** Classification: fail-fast with a named cause in all three; no hang, no silent degradation.

## LIVE-09 — Verified clean: a private backend dies with its server, no orphans

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `packages/opencode/src/supervisor.ts`

**Evidence:** After each probe's client closed, `ps` showed the probe's `opencode serve` gone within seconds (supervisor.ts: SIGTERM to the group, SIGKILL after 5 s); servers.log: 'opencode pid 3214659: stdin closed by the client … exited with code 0 after 451s'. The only leftover backends during the audit were the shared one (pid 15315, port 44879) and the journey that was still running.

**Why it matters:** Resource hygiene for private mode holds.

## LIVE-10 — Verified clean: the new-user journey on the bundled servers

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `plugins/horde/servers/opencode.js`

**Evidence:** scratchpad/audit/live/out/journey/journey.log and journey2 (fresh repo, private backend, real deepseek/deepseek-flash): five servers boot in 200-500 ms with 14/5/7/2/24 tools; verify_detect finds `npm test`; context_map maps the repo; horde_do → horde_wait → outcome with cost ($0.05, 4m28s); horde_investigate → REPORT in 19 s ($0.0033) with three checked citations (and it diagnosed the broken test script); the impossible task failed on scope after 2 rounds; horde_land on a FAILED task answers 'not ready to land: its checks failed. horde_tell it to finish, or horde_drop it'; horde_do warns 'both touch src/** and may run in parallel'; the news file was written during the run and removed at close; both hooks answered correctly against the live file. Journey total $0.07.

**Why it matters:** The product's core loop works from the shipped bundles without a clone; costs are as advertised.

## LIVE-11 — Verified clean: ci.sh green in full, nothing skipped; install URL serves the committed installer

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `ci.sh`

**Evidence:** ./ci.sh (scratchpad/audit/ci-full.log, 3315 lines, exit 0): lint, typecheck, bundle check, mock check, build, tests: 28+35+41+24+8+182+14+95 = 427 tests, 0 skipped, 0 todo (opencode suite 461 s). curl raw.githubusercontent.com/…/master/install.sh → HTTP 200, byte-identical to the local install.sh.

**Why it matters:** Ground truth matches the project's claims for the gates that do run.
