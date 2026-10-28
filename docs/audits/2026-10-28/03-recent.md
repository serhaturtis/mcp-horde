# Scope 3 — Recent work re-review

Part of the 2026-10-28 audit. See [INDEX.md](INDEX.md) for the triage,
method, and caveats. Status legend: `[ ]` open / `[x]` closed
(record the closing commit SHA beside the checkbox).

## Scope summary

Re-reviewed the 45 commits since 5a2606d (36 non-rebundle) by reading every diff, tracing the touched code on HEAD, running git simulations for the landing paths, running the hook and board test suites in isolated state dirs, probing the board CLI, and checking the Claude Code hook contract against its docs. Two medium defects: horde_land's new 'already on the branch' recognition (1ec1700) only covers patch-identical commits, so work the user squash-merged by hand is replayed and fast-forwarded as empty commits (reproduced with the exact rebase flags); and dd75133 moved the gate's rule source from the immutable base commit to the live HEAD ref of the main checkout, which a worker with shell access can advance from inside its worktree (git update-ref / git -C <repo> commit both reproduced), contradicting the code comment 'which the work itself cannot rewrite'. Several low items: the class fix of 4b775d1 misses --repo (an existing non-git directory still creates an empty board), the report check still accepts 'n/a'/'N/A'/'none.' as path claims, the binaries/scope hints parse a budget-trimmed verdict and vanish when audit lines are dropped, the news file lags a gate decision by one refresh interval, and the board test suite breaks under the HORDE_* state-dir overrides the project itself documents. Today's news work (f07ce80, 7c0d791) holds up: CLAUDE_CODE_SESSION_ID reaches the live MCP servers, the Stop hook's background_tasks assumption is documented by Claude Code, writes are deduplicated and atomic, and the hook tests pass; the one documented gap is /clear and --continue, after which the server's spawn-time session id no longer matches the hook's.

## REC-01 — horde_land replays squash-merged work as empty commits and fast-forwards them onto the branch

- [ ] *(open)*
- **Severity:** medium · **Confidence:** high
- **Location:** `packages/opencode/src/fleet.ts:1603`

**Evidence:** fleet.ts:1596-1625 recognises 'work already on the branch' only via `git cherry -v tip HEAD start` (patch-id). Simulation in scratch (squash/): master <- `git merge --squash work; git commit`, then `git cherry -v master work <base>` prints `+ 7f4c1e3 one` / `+ 1374562 two` (not recognised); the exact land rebase `git -c core.editor=true rebase --empty=keep --reapply-cherry-picks --onto master <base> work` (worktree.ts:790) succeeds and `git log master..work` shows `a2e80b1 two` / `dc9dfe4 one` with `git show --name-only` listing 0 files for each. landLoop then counts `rev-list --count tip..judged` = 2, runs the full checks, and `merge --ff-only` lands both empty commits. The horde_land description (horde.ts:322) says 'If you already landed the task's commits yourself, horde_land recognises them by patch-id and closes the task without landing anything', and the 1ec1700 comment at fleet.ts:1596-1599 states the goal is to avoid exactly this replay.

**Why it matters:** Squash-merging a worker branch by hand (git merge --squash, GitHub squash-merge, cherry-pick -n + commit) is the common way to land work outside the horde; patch-ids never match it, so the guard misses the case it was written for and the branch gets N empty commits after minutes of checks. Reordered commits are fine (patch-id is per commit); only squashed or amended ones fail.

**Fix sketch:** In landSync (where workStart already excludes the baseline) rebase with --empty=drop, or after the rebase compare trees: if `git diff --quiet tip HEAD` (nothing to land) treat as 'already', and refuse/strip replays that became empty before running the checks; report 'N of M commits became empty on <target>'.

## REC-02 — horde status/remove --repo <existing non-git dir> still creates an empty board (class of 4b775d1)

- [x] closed in 915ae8b — **Executed evidence:** horde status/remove for a directory that is not a git repository or has no board refuse with the no-board message and create nothing (cli.test.ts, 40 pass)
- **Severity:** low · **Confidence:** high
- **Location:** `packages/board/src/cli.ts:100`

**Evidence:** 4b775d1 added knownState() for --state only. Ran `HORDE_BOARD_STATE_DIR=<tmp>/state node packages/board/dist/cli.js status --repo <tmp>/notrepo` (an existing empty directory): output 'The board is empty: plan tasks with board_plan.' and afterwards `find <tmp>/state` lists `state/notrepo-d0326951dc`, `.../locks`, `.../tasks`. A nonexistent --repo fails cleanly ('ENOENT ... realpath') and creates nothing. cli.ts:96-100 humanBoard(): `state ? new Board(state) : await Board.open(repo)`; board.ts:167-179 Board.open creates the keyed directory.

**Why it matters:** Same defect class the commit fixed: a typo in --repo that happens to name an existing directory (or running `horde status` in the wrong cwd) silently creates a board at a new key. Human-only path, so low.

**Fix sketch:** In humanBoard, when --repo (or cwd) is not inside a git repository or its board key directory does not exist, refuse with the same 'no board exists ... boards in <root>:' message instead of calling Board.open.

## REC-03 — Report check still takes 'n/a', 'N/A', 'none.' as file-path claims

- [x] closed in 915ae8b — **Executed evidence:** claimedPath treats none, n/a, nothing, -, ., ... and friends as no claim and requires a slash or an extension (board.test.ts, 40 pass)
- **Severity:** low · **Confidence:** high
- **Location:** `packages/board/src/board.ts:398`

**Evidence:** 9c2b22d: `const claimedPath = (p) => Boolean(p) && (isFile(p) || (!/\s/.test(p) && /[./]/.test(p)))`. node -e with that predicate: "none" false, "n/a" true, "N/A" true, "none." true, "nothing" false, "-" false, "(none)" false, "." true.

**Why it matters:** The commit's test only covers 'none' and 'nothing'. 'n/a' is at least as common from a worker model and yields '⚠ the worker's report names n/a, which its diff does not touch' in READY outcomes.

**Fix sketch:** Treat a short list of placeholders (none, n/a, na, nothing, -, ., ...) case-insensitively as no claim, or require a path to contain a slash or an extension of 1-5 letters after the last dot and not be only punctuation.

## REC-04 — Binaries and scope hints parse the budget-trimmed verdict and silently disappear when audit lines are dropped

- [ ] *(open)*
- **Severity:** low · **Confidence:** high
- **Location:** `packages/opencode/src/horde.ts:632`

**Evidence:** outcome() takes `verdict = record.gateState?.verdict` (horde.ts:431) and feeds `verdict?.text` to scopeFiles (:621-630) and binaryFiles (:632-641); the 900-char `truncate` at :517 is only for display, so the parsed text is the stored one. That stored text is render(verdict, budget) with `budget = opts.budgetChars ?? 1500` (gate.ts:294) and fleet.ts never passes budgetChars (grep: no `budgetChars` in fleet.ts). In render() the audit lines are optional sections grouped 'audit:block' with an `omitted` note (gate.ts:488-495), while failing-check lines and their first failures come earlier and are `required` (:453-477); fitSections (core/src/text.ts:80-91) drops optional sections once the budget is exceeded. So with a failing check whose failure messages fill ~1.5k chars, the `✗ binaries: ...` / `✗ scope: ...` lines are replaced by '… k more blocking findings' and both hints (and the `scope: [...]` suggestion) are omitted, though the blockers still fail the gate. Regex also requires `\S+` so a path with spaces is never hinted.

**Why it matters:** The outcome's guidance depends on text layout, not on the verdict's findings as data; the verdict object already drops the structured audit findings after rendering, so the opencode side cannot do better without a data channel. Degrades guidance only, so low.

**Fix sketch:** Keep the audit findings (category, file, text) on the Verdict/gateState alongside text, and build the hints from them; or render the audit:block group with required: true.

## REC-05 — News file is not republished when a gate decides; it waits for the agent's next scheduled refresh

- [ ] *(open)*
- **Severity:** low · **Confidence:** high
- **Location:** `packages/opencode/src/fleet.ts:2013`

**Evidence:** publishNews() call sites: fleet.ts:1030 (task start), 2266/2279 (maybePush), 2785 (markReported), 3106 (dropLive). maybePush is called only from doRefresh (:2013). The gate's completion path stores the verdict (updateRecord gateState, ~:2202) and then `finally { release(); this.wake() }` (:2253-2255), which wakes waiters but publishes nothing. For an idle agent whose gate is running, working() (:701-703) is false, so tick() refreshes it only when `now - lastRefresh > SETTLED_REFRESH_MS` (60 s) or DORMANT_REFRESH_MS (10 min) when lastNewEventAt is over an hour old (:2984-2987). Without a horde_wait in flight the file therefore shows the task under working for up to 60 s (10 min after a >1 h gate) after it became READY/FAILED.

**Why it matters:** The Stop and UserPromptSubmit hooks only read the file; in the window the Stop hook lets the agent stop and the prompt hook says 'still working' for a finished task. Usually a waiter exists, so low.

**Fix sketch:** Call this.maybePush(live) (or publishNews) after the gate verdict is recorded in runGateFor, and after a fix round is delivered.

## REC-06 — Board test suite fails under the HORDE_* state-dir overrides the project tells auditors and users to use

- [x] closed in 9bfba96 — **Executed evidence:** HORDE_BOARD_STATE_DIR and HORDE_VERIFY_STATE_DIR pointed at scratch dirs: npm test -w @mcp-horde/board → tests 35 pass 35 fail 0 (was 33/35); scripts/test-env.mjs deletes the four HORDE_* state overrides before any test runs
- **Severity:** low · **Confidence:** high
- **Location:** `packages/board/test/board.test.ts`

**Evidence:** Ran the package's own test command with HORDE_VERIFY_STATE_DIR, HORDE_BOARD_STATE_DIR, HORDE_OPENCODE_STATE_DIR, HORDE_OPENCODE_WORKTREE_DIR, XDG_STATE_HOME, XDG_DATA_HOME all pointed into a temp dir: '# tests 35 / pass 33 / fail 2', both in the 'horde remove' suite ('/tmp/horde-board-guUgBg/mcp-horde/worktrees/... is listed' while the Would-remove output shows worktrees '(none)' and board dirs under the test's own XDG dir). Rerun with only XDG_STATE_HOME/XDG_DATA_HOME set: '# tests 32 / pass 32 / fail 0'. The tests set XDG_STATE_HOME for the child process but inherit the HORDE_* overrides (board.ts:148 and the worktree/verify dirs take HORDE_* first).

**Why it matters:** Not a product defect, but it means `npm test` is not hermetic: a developer or CI box that keeps HORDE_OPENCODE_WORKTREE_DIR or HORDE_BOARD_STATE_DIR set (the README documents them) sees spurious failures in `horde remove`.

**Fix sketch:** In scripts/test-env.mjs delete HORDE_BOARD_STATE_DIR, HORDE_VERIFY_STATE_DIR, HORDE_OPENCODE_STATE_DIR and HORDE_OPENCODE_WORKTREE_DIR (or point them under HORDE_TEST_STATE_HOME) before the tests run.

## REC-07 — News reminders stop after /clear or --continue: the server keeps its spawn-time session id

- [x] closed in 0f05cad — **Executed evidence:** plugins/horde/hooks/news.mjs falls back to the news file of a live server whose parent is this Claude Code process when the session id's file is missing (test in news.test.mjs, 33 pass)
- **Severity:** low · **Confidence:** medium
- **Location:** `packages/opencode/src/news.ts:35`

**Evidence:** news.ts:35 names the file after `process.env.CLAUDE_CODE_SESSION_ID` read once at construction; news.mjs readNews() opens `<stateDir>/news/<input.session_id>.json`. Claude Code env-vars doc (via the claude-code-guide check, code.claude.com/docs/en/env-vars.md): 'For Bash, PowerShell, and hooks this matches the session_id field in the hook JSON input and is updated on /clear. An MCP server subprocess retains the ID it was spawned with. ... On --continue or --resume without an explicit ID it may receive the initial startup ID instead.' Live check: the four running opencode.js servers each carry CLAUDE_CODE_SESSION_ID in /proc/<pid>/environ, one per Claude Code session.

**Why it matters:** After /clear the server writes <old>.json while the hooks read <new>.json, so unread outcomes are no longer named and the old file lingers until the server exits (it is removed at close, and the hook ignores it once the pid dies). Silent degradation, not a wrong reminder. DESIGN.md §4.2 'Outcome delivery' does not mention it.

**Fix sketch:** Have the hook also look for a file whose pid is a live MCP server child of this Claude Code process, or let the server derive the session from each request (clientName/extra) and write both files; at least document the /clear gap.

## REC-08 — publishNews builds a snapshot of every task-bound agent on every refresh of every agent

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `packages/opencode/src/fleet.ts:2286`

**Evidence:** maybePush (:2259-2280) now calls publishNews() on both the early-return path and the push path, once per doRefresh of each agent; publishNews (:2286-2308) iterates this.live and calls this.build(live) for each task-bound agent (snapshot: turnsSince, child track sums, contextOf). News.update (news.ts:52-56) dedups by JSON key so the file is rewritten only when the lists change, and writes are serialised and atomic (temp + rename).

**Why it matters:** O(agents^2) snapshot builds per tick; with maxRunning 8 and POLL_MS 1000 that is at most ~64 cheap in-memory builds per second, and no extra I/O. Recorded as verified-acceptable, not a defect.

## REC-09 — Verified clean: today's news file and hooks (f07ce80, 7c0d791, 3a47ca6, dc129b3)

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `plugins/horde/hooks/news.mjs:121`

**Evidence:** Hook contract checked against Claude Code docs: Stop input carries `background_tasks` with entries {id,type,status,description,...,server,tool} and type 'MCP task' for backgrounded MCP calls; `/horde_wait$/` on `task.tool` (news.mjs:121-123) matches either a bare or mcp__-prefixed name; UserPromptSubmit `hookSpecificOutput.additionalContext` and Stop `{decision:'block', reason}` are the documented shapes; stop_hook_active plus the 8-continuation cap bound loops. `node --test plugins/horde/hooks/news.test.mjs plugins/horde/hooks/delegate.test.mjs`: 28/28 pass. close() now returns news.remove(): index.ts:121 awaits it in Promise.allSettled before process.exit, reset() (:68) fire-and-forgets it, which is fine since News serialises writes and clear() resets `last`. index.ts:44-46 clears a stale file at startup. DESIGN.md:153 and README:42 describe the mechanism accurately.

**Why it matters:** No defect beyond the /clear gap and the refresh lag recorded separately.

## REC-10 — Verified clean: reviewer never falls back to OpenCode's default when tiers exist (8be2f9c, 6022770, b59a3eb)

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `packages/opencode/src/fleet.ts:798`

**Evidence:** review(): `const models = input.models?.length ? input.models : [tier ?? worker]`; reviewForGate: `first = at < 0 ? worker : tiers[at].model`, retry `next ?? (no-answer ? worker : first)`. Test 'tiers naming only the worker's model (once/twice) are reviewed by that model' asserts the mock request's model is 'pricey' while the harness default is mock/mock, so it fails if the fallback regresses. Remaining undefined case (no tiers and no recorded attempt model) is acknowledged in the comment and uses the default by necessity. Class sweep: no other ask() call site in horde.ts/fleet.ts picks a model from tiers.

**Why it matters:** Change does what it says; test cannot pass for an unrelated reason.

## REC-11 — Verified clean: audit settings precedence after dd75133 (warn-only leaves default block, block wins, off wins over both)

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `packages/verify/src/detect.ts:131`

**Evidence:** detect.ts:129-147: `block = categories(audit.block) ?? DEFAULT_BLOCK.filter(c => !warned?.includes(c))`, then `audit.block = block.filter(c => !off.includes(c))`, `audit.warn = warn.filter(c => !block.includes(c) && !off.includes(c))`; audit.ts:624 severityOf checks block first. So `{off:['binaries']}` silences, `{warn:['binaries']}` warns, and a category in both explicit lists blocks, matching DESIGN.md:337 and the c4a5eed hint text. verify.test 'a worktree gate reads the rules from the commit the work will land on' and the fleet-fixes test prove rulesAt end to end.

**Why it matters:** Hypothesis tested: the 1578c67 doc claim and the c4a5eed hint are both true of the code.

## REC-12 — Verified clean: carried-over files, generated-conflict landing and deletion counting (6d964e1, c924f61, f1d1bdd)

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `packages/opencode/src/worktree.ts:824`

**Evidence:** During a rebase `--ours` is the side being rebased onto (the target + replays so far), so `git checkout --ours -- file` (worktree.ts:824) takes the target's version as the comment claims; the horde.test 'a conflict confined to generated files is resolved by the land step' asserts dist/out.txt becomes 'worker-master', which only holds if master's copy was taken and then regenerated. `rebase --skip` for an all-generated commit (worktree.ts:832) only runs in landSync, where `start = workStart(wt)` = the baseline commit (worktree.ts:38-40 `merged ?? baseline ?? base`) so the baseline is excluded and the syncWorktree invariant 'first replay is the baseline' is not affected. c924f61: `git diff --name-only --diff-filter=D <workStart>` (horde.ts:698) lists a carried file the worker deleted because the baseline commit added it; `cat-file -e base:file` then fails, so it counts; the only other numstat reader (audit.ts:197-205) handles '-' explicitly and horde.ts:686 maps '-' to 0 via `Number(x) || 0`. f1d1bdd: CapacityError is thrown before reserve()/any board write (fleet.ts:703-712), so unplan() finds no attempt; unplan refuses tasks with attempts (board.ts:314-321, unplan.test 2/2). Minor: landSync reads `generated` from HEAD's horde.json but `land` from the working-tree horde.json (worktree.ts:893-894).

**Why it matters:** Instances fixed and their immediate classes hold; the squash case is reported separately as medium.

## REC-13 — Verified clean: request deadlines, gate verdict cache, rule-file audit, horde.json key validation (0b99a26, b6c7174, 49f2844, 9e69306, 008e0d8, 5a2606d)

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `packages/opencode/src/fleet.ts:312`

**Evidence:** grep `this\.api\.` in fleet.ts without timed()/within( on the same line yields only the two multi-line session.create/session.prompt calls, both passing timed(LONG_REQUEST_MS) (fleet.ts:1119-1130, 1276-1287); backend.ts:328 uses AbortSignal.timeout(5000); req()'s dedup message (fleet.ts:312) matches within()'s format (:332). b6c7174 removed a check immediately followed by an identical one (:1923-1928). 49f2844: gate.ts:386-390 caches only `verdict.pass`; other caches are the model list (fleet.ts:493) and the 15-minute baseline comparison (by design, DESIGN.md:302), neither stores a verdict. 9e69306/008e0d8: checkDirs/CHECK_CONFIG/vitestAt read as described with tests for root, cwd, out-of-cwd and vitest-suppressed vite config. 5a2606d: every horde.json reader (core tiers/workers, opencode.maxRunning, verify.checks/audit/timeoutSeconds, context.ignore/entrypoints; grep of loadHordeFile callers) is covered by KNOWN, and this repository's horde.json (03322ac: timeoutSeconds 1800, test slots 1) loads.

**Why it matters:** Nothing contradicting the commit messages; tests exercise the stated behaviour.

## REC-14 — Verified clean: landing by hand, board --state refusal, report placeholders, hook hand-edit notes, docs (1ec1700 by-hand path, 4b775d1, 9c2b22d, bf8e26e, 4667b4d, 2345359, 1812a1f, 5519b9d, 66c55c4, 1578c67, f4f92a9, df8b773, eb2313b, 6ecda5e, 85c3dc4)

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `packages/opencode/src/horde.ts:322`

**Evidence:** horde.test covers the by-hand rebase with and without a carried-over baseline, the cherry-pick 'already' close, the partial 'already' refusal and horde_drop {landed:true}; board cli.test proves the --state typo refusal and that no directory is created. Delegate hook: 28/28 tests pass with the per-piece reset on HEAD change and the in-repository filter (realpath through symlinks). Docs: DESIGN.md:268/297 reviewer default, :337 rule source, SKILL.md:17 binaries guidance, README:42 outcome delivery all match the code on HEAD. 03322ac horde.json keys (timeoutSeconds, slots) are in KNOWN.verify/KNOWN.check. DESIGN.md's landing paragraph (:300) still says a conflict 'leaves your branch untouched' without mentioning that a generated-only conflict is now resolved automatically when workers.land is set (6d964e1); minor doc gap.

**Why it matters:** Verified-clean record for the remaining commits.
