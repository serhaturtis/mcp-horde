# Scope 1 — Deploy path, docs-as-instructions, env plumbing

Part of the 2026-10-28 audit. See [INDEX.md](INDEX.md) for the triage,
method, and caveats. Status legend: `[ ]` open / `[x]` closed
(record the closing commit SHA beside the checkbox).

## Scope summary

Checked the deploy path (install.sh line by line and in --dry-run on this machine, from another cwd, in the curl|bash shape and against a fresh isolated CLAUDE_CONFIG_DIR; marketplace.json, plugin.json, .mcp.json, hooks.json; bundle-plugin.mjs and eval-tools.mjs --check; the clone and GitHub install/update instructions walked against `claude plugin ... --help` of Claude Code 2.1.312 and then executed for real in an isolated config dir: marketplace add from GitHub with and without SSH, install at user scope, update with and without a new commit, and all five bundled servers booted from the resulting cache), docs-as-instructions (every tool name in README.md, plugins/horde/README.md, the three skills, DESIGN.md and evals/README.md against the 52 tools registered in packages/*/src and listed by the bundles; every horde.json example run through validateHordeFile; the eval command's flags against `claude plugin eval --help`), env plumbing (every HORDE_*/OPENCODE_*/CLAUDE_* read in packages/*/src and the hooks against what the docs name; boot defaults for the repository and ports; the live servers' cwd and env read from /proc) and external claims (OpenCode pin vs install.sh, model ids vs models.dev and `opencode models`, the channel flag, the raw GitHub URL). Overall posture: the central flow holds. A user on another machine can install from GitHub with the documented one-liner, the servers run from the cache, and `claude plugin marketplace update mcp-horde && claude plugin update horde@mcp-horde` really ships new commits (the plugin version is the commit sha, so no version bump is needed). Nothing blocking was found; the defects are doc drift that leads a reader astray: the clone-path `claude mcp add` list misses the ledger server, the example `moonshot/kimi-k3` names a provider id the OpenCode catalog does not have, the skill tells the orchestrator about a `horde watch` command that is not on PATH for plugin users, DESIGN.md describes a `verify.parallel` key the validator rejects and eight board_* tools that do not exist, and the environment variables a plugin user can set are documented only in package READMEs the GitHub install does not carry. Running a real task on a second machine was not exercised (it needs a provider login and live state).

## DEP-01 — Clone-path instructions (`claude mcp add`) omit the ledger server and the hooks

- [ ] *(open)*
- **Severity:** medium · **Confidence:** high
- **Location:** `plugins/horde/README.md:85`

**Evidence:** plugins/horde/README.md:85-88 lists four `claude mcp add` lines: opencode, board, verify, context. plugins/horde/.mcp.json registers five servers: opencode, board, verify, context, ledger. `claude plugin details horde@mcp-horde` → "MCP servers (5) opencode, board, verify, context, ledger" and "Hooks (5) SessionStart, SubagentStart, PostToolUse, UserPromptSubmit, Stop". grep -n ledger plugins/horde/README.md → only lines 5 and 48 (description), no `claude mcp add ledger`.

**Why it matters:** A reader following the 'From a clone instead' section gets no ledger_stats/ledger_suggest tools and none of the hooks (the Stop/UserPromptSubmit outcome reminders the README's outcome paragraph relies on), with no error telling them so. `claude mcp add <name> -- <command>` itself is valid per `claude mcp add --help`.

**Fix sketch:** Add `claude mcp add ledger -- node "$PWD/plugins/horde/servers/ledger.js"` and say that this path has no hooks (or point at `claude --plugin-dir plugins/horde`, which `claude --help` lists and which loads the whole plugin from a directory).

## DEP-02 — Example tier `moonshot/kimi-k3` names a provider id the OpenCode catalog does not have (it is `moonshotai`)

- [ ] *(open)*
- **Severity:** medium · **Confidence:** medium
- **Location:** `plugins/horde/README.md:33`

**Evidence:** grep -rn 'moonshot/kimi-k3' → plugins/horde/README.md:33, docs/DESIGN.md:319, packages/board/README.md:70, packages/opencode/README.md:195, packages/ledger/README.md:12,13,19, packages/review/README.md:9. curl https://models.dev/api.json parsed: `moonshot: (no such provider)`; `moonshotai: kimi-k3.1-pro-highspeed, kimi-k3, kimi-k2.7-code-highspeed, kimi-k3.1-pro, kimi-k2.7-code, kimi-k2.6`. `opencode models` on this machine lists providers deepseek, opencode, zai-coding-plan only. packages/core/src/config.ts:183 validates tiers only by shape (/^[^/\s]+\/\S+$/), so the example passes validateHordeFile (proved: 'plugin README example → accepted').

**Why it matters:** The plugin README's horde.json example is the one users copy. Its second tier is accepted by the validator and fails only when a task escalates and opencode_spawn asks for a model that does not exist, i.e. at the worst moment. Confidence is medium rather than high because a user can define a custom provider named `moonshot` in OpenCode's config, and the provider id in models.dev was checked today rather than on the day the docs were written.

**Fix sketch:** Use `moonshotai/kimi-k3` (or another id `opencode models` prints) in every example; optionally have horde_do's first answer check tier models against `opencode_models` and warn.

## DEP-03 — The skill tells the orchestrator about `horde watch`, a command plugin users do not have

- [ ] *(open)*
- **Severity:** low · **Confidence:** high
- **Location:** `plugins/horde/skills/horde/SKILL.md:45`

**Evidence:** plugins/horde/skills/horde/SKILL.md:45: "`horde watch` in a terminal shows the board live." docs/DESIGN.md:228 and :454 likewise (`horde status`, `horde watch`). `which horde` → "horde not on PATH". The `horde` bin exists only in packages/board/package.json ("bin": {"horde": "dist/cli.js"}), and README.md:40 says the packages are not published to npm. plugins/horde/README.md:48 gives the working form: `node <plugin dir>/servers/cli.js watch`.

**Why it matters:** The skill is what the orchestrating model reads; it will tell the user to run `horde watch`, which fails on every plugin install. The remove skill (plugins/horde/skills/remove/SKILL.md:10) already spells out the `node <plugin>/servers/cli.js` form, so the two skills disagree.

**Fix sketch:** In the horde skill write `node <plugin dir>/servers/cli.js watch` (the plugin dir is `${CLAUDE_PLUGIN_ROOT}`), as the remove skill does.

## DEP-04 — DESIGN.md documents a `parallel: true` verify option that the validator rejects

- [ ] *(open)*
- **Severity:** low · **Confidence:** high
- **Location:** `docs/DESIGN.md:177`

**Evidence:** docs/DESIGN.md:177: "Checks run sequentially by default (shared `node_modules`, ports); `parallel: true` in config opts in." grep -rn parallel packages/verify/src → no output. packages/core/src/config.ts:8 KNOWN.verify = ["checks", "audit", "timeoutSeconds"]. Run through the real validator: `{verify:{parallel:true}}` → `horde.json: unknown key "verify.parallel"`.

**Why it matters:** A horde.json written from this sentence stops every server's next call with an unknown-key error (loadHordeFile throws). The real concurrency controls are `slots` and `exclusive`, which the setup skill documents.

**Fix sketch:** Replace the sentence with the `slots`/`exclusive` semantics or delete it.

## DEP-05 — DESIGN.md §4.4 lists eight board tools that are not registered anywhere

- [ ] *(open)*
- **Severity:** low · **Confidence:** high
- **Location:** `docs/DESIGN.md:209`

**Evidence:** Names in docs but not in packages/*/src (comm of the two sorted lists): board_archive board_assign board_finding board_lock board_locks board_progress board_report board_update, at docs/DESIGN.md:209,210,211,215,216,220,221,222,224,353. The board server registers 14 tools (packages/board/src/index.ts; bundle lists: board_plan board_next board_brief board_accept board_fail board_block board_edit board_summary board_task board_findings board_remember board_recall board_forget board_unlock). The worker side is the CLI (packages/board/src/cli.ts:70: task|progress|report|finding|findings|recall|lock|unlock), which DESIGN.md:219 itself says. README.md, plugins/horde/README.md, the three skills and evals/README.md name only tools that exist.

**Why it matters:** DESIGN.md's header (line 3) presents it as the status of what is built, and §6 flow A (line 353) still says the worker 'files `board_report`'. Harmless for the orchestrator (the skills are correct) but it is the document the README sends readers to for 'the whole horde'.

**Fix sketch:** Rewrite the §4.4 tool list from the registered set (board_edit replaced board_update/board_assign; locks are CLI-only; no archive) or mark the list as the original design.

## DEP-06 — Every documented horde.json example passes the validator; `context.*` and `when: "always"` are known to code but absent from plugin-facing docs

- [ ] *(open)*
- **Severity:** low · **Confidence:** high
- **Location:** `packages/core/src/config.ts:6`

**Evidence:** Run through validateHordeFile from packages/core/src/config.ts: DESIGN.md §5 example → accepted; setup SKILL.md example → accepted; plugin README example → accepted; user-level {tiers:["deepseek/deepseek-flash"]} → accepted; the repository's own horde.json → accepted. KNOWN (config.ts:6-16): top context/opencode/tiers/verify/workers; verify checks/audit/timeoutSeconds; check command/kind/cwd/env/when/slots/exclusive; audit block/warn/off/allowed/generated; workers link/setup/brief/land; land command/message; opencode maxRunning; context ignore/entrypoints; tier model/variant. `context.ignore`/`context.entrypoints` appear only in docs/DESIGN.md:247,329 and packages/context/src/files.ts:19, not in plugins/horde/README.md or the skills. packages/verify/src/detect.ts:111 accepts `when: "always"`; grep '"always"' over docs and READMEs → no mention as a `when` value. Unknown-to-code keys in docs: only `verify.parallel` (separate finding).

**Why it matters:** The copy-paste examples are sound. The gap is small: a plugin user cannot learn `context.ignore`/`entrypoints` from the plugin README or the setup skill, and `when: "always"` is an undocumented accepted value (harmless, it is the default).

**Fix sketch:** Mention `context` in the setup skill's horde.json bullet list.

## DEP-07 — Environment variables: 13 server settings documented only in package READMEs that a GitHub install does not carry; no doc says how to set env for plugin MCP servers

- [ ] *(open)*
- **Severity:** low · **Confidence:** high
- **Location:** `plugins/horde/README.md:53`

**Evidence:** Read in packages/*/src (grep, scratchpad/audit/deploy): HORDE_OPENCODE_{SERVER,URL,BIN,DIRECTORY,PERMISSIONS,MAX_RUNNING,CHANNEL,DIALOG_TIMEOUT,STATE_DIR,WORKTREE_DIR,ALLOW_INSECURE} (opencode/src/config.ts:78-109, core/src/worktree.ts:25), OPENCODE_SERVER_{USERNAME,PASSWORD} (config.ts:98-99), HORDE_BOARD_{DIRECTORY,STATE_DIR} (board/src/index.ts:19, board.ts:148), HORDE_VERIFY_{DIRECTORY,STATE_DIR} (verify/src/index.ts:22, gate.ts:99), HORDE_CONTEXT_DIRECTORY (context/src/index.ts:22), HORDE_LEDGER_DIRECTORY (ledger/src/index.ts:18), CLAUDE_CODE_SESSION_ID (opencode/src/news.ts:35), HORDE_SUPERVISED_CWD (supervisor.ts:18, set by backend.ts:491), XDG_*; hooks/news.mjs:53-54 reads HORDE_OPENCODE_STATE_DIR and XDG_STATE_HOME. Documented in plugins/horde/README.md: HORDE_OPENCODE_BIN (:53), HORDE_TASK/HORDE_WORKTREE (:40); README.md: HORDE_OPENCODE_CHANNEL (:42); setup skill: HORDE_OPENCODE_WORKTREE_DIR (:50). All the others are documented only in packages/opencode/README.md:168-178, board/README.md:77-88, verify/README.md:120-121, context/README.md:63, ledger/README.md:39-40. The GitHub install's cache dir holds .claude-plugin .mcp.json README.md evals hooks servers skills and no packages/. plugins/horde/.mcp.json has no env block; plugins/horde/README.md:53 says 'Set HORDE_OPENCODE_BIN in the server's environment' without saying where. Classification of the mandate's list: missing doc at plugin level: HORDE_BOARD_DIRECTORY HORDE_BOARD_STATE_DIR HORDE_CONTEXT_DIRECTORY HORDE_LEDGER_DIRECTORY HORDE_VERIFY_DIRECTORY HORDE_VERIFY_STATE_DIR HORDE_OPENCODE_ALLOW_INSECURE HORDE_OPENCODE_DIALOG_TIMEOUT HORDE_OPENCODE_DIRECTORY HORDE_OPENCODE_PERMISSIONS HORDE_OPENCODE_SERVER HORDE_OPENCODE_URL OPENCODE_SERVER_USERNAME (all in package READMEs). Internal, not config: HORDE_SUPERVISED_CWD (backend→supervisor plumbing), CLAUDE_CODE_SESSION_ID (set by Claude Code; verified present in a live server's /proc environ). Not env vars at all: HORDE_VERSION (esbuild define, bundle-plugin.mjs:41, config.ts:124-131), HORDE_INSTRUCTIONS (a TS constant, horde.ts:34; evals/README.md:44 refers to it as such). Docs-only: HORDE_WORKER_TOOLS and OPENCODE_CONFIG_CONTENT at DESIGN.md:149 are inside a paragraph that says 'not built, kept for when OpenCode offers agents MCP tools'; OPENCODE_CONFIG_CONTENT is also used by the canary test DESIGN.md:97 promises (packages/opencode/test/modes.test.ts:163). Dead config: none. Test-only: HORDE_TEST_STATE_HOME (scripts/test-env.mjs).

**Why it matters:** No variable is dead and none of the doc-only ones is drift. The usability gap is that a plugin user who needs `HORDE_OPENCODE_SERVER=private`, a custom worktree dir or the dialog timeout has to find packages/opencode/README.md on GitHub, and nothing says the variables must be exported in the shell that starts `claude` (plugin .mcp.json cannot carry env).

**Fix sketch:** Add a short variables table (or a link to packages/opencode/README.md#configuration) and one sentence on how to set them (export before `claude`, or `claude mcp add -e` on the clone path) to plugins/horde/README.md.

## DEP-08 — `--dangerously-load-development-channels` is accepted but hidden; its argument form differs between two READMEs

- [ ] *(open)*
- **Severity:** low · **Confidence:** low
- **Location:** `packages/opencode/README.md:134`

**Evidence:** claude --help | grep -i 'dangerously|channel' → only --allow-dangerously-skip-permissions and --dangerously-skip-permissions. `claude --dangerously-load-development-channels plugin:horde@mcp-horde --version` → "2.1.312 (Claude Code)", exit 0 (an unknown option would have failed). README.md:42 and docs/DESIGN.md:439 use `plugin:horde@mcp-horde`; packages/opencode/README.md:134 uses `server:opencode`.

**Why it matters:** The flag exists in this Claude Code build. Whether both argument forms are valid (and which one the plugin's server needs) cannot be checked without starting an interactive session with HORDE_OPENCODE_CHANNEL=1 and watching for the <channel> message; the feature is opt-in and marked research preview, so the risk is a confusing failure for a curious user, not a broken flow.

**Fix sketch:** Use one form in all three places; add the observed Claude Code version next to it.

## DEP-09 — bundle-plugin.mjs --check compares only files the fresh build produces and builds from whatever node_modules is present

- [x] closed in 9bfba96 — **Executed evidence:** scripts/bundle-plugin.mjs --check now also flags orphans: with a planted plugins/horde/servers/zz-orphan.js it exits 1 naming it, and passes after removal; ci.sh runs scripts/check-install.mjs (node_modules versus package-lock.json, npm ci when they differ): 'node_modules matches package-lock.json'
- **Severity:** low · **Confidence:** high · **Also reported by:** gates: Bundle check is one-directional and compares against whatever node_modules holds
- **Location:** `scripts/bundle-plugin.mjs:62`

**Evidence:** scripts/bundle-plugin.mjs:62-74: builds into a tmp dir and reports `stale` = files of the tmp build that are missing or byte-different in plugins/horde/servers; it never lists files present only in plugins/horde/servers. ci.sh:23 runs `npm ci` only when node_modules is missing or --install is passed; the check at ci.sh:26 therefore bundles from the developer's current node_modules. esbuild is pinned exactly (package.json devDependencies "esbuild": "0.28.2"), so the byte comparison is deterministic for a given node_modules. scripts/eval-tools.mjs:26 starts the committed bundle plugins/horde/servers/opencode.js (not the sources) and compares its six horde_* definitions with evals/mocks/opencode/_tools.json; ci.sh:27 orders it after the bundle check.

Also reported by gates (high confidence): bundle-plugin.mjs:60-66 `stale = readdirSync(tmp, {recursive: true}) ... .filter((f) => !existsSync(out/f) || !equals(...))`: only files produced by the fresh build are compared, so a file left in plugins/horde/servers (a removed entry or grammar) is never reported. ci.sh:23 `if [[ $install || ! -d node_modules ]]; then npm ci; fi`: without --install an existing node_modules is used as is, so after a package-lock.json bump the local check compares two bundles built from the same stale dependencies and passes, while a fresh clone's `npm ci && node scripts/bundle-plugin.mjs --check` would fail.

**Why it matters:** A stale bundle cannot pass when node_modules matches the lockfile: every entry is rebuilt and compared byte for byte. Two edges remain: a stray extra file under servers/ passes, and a developer whose node_modules drifted from package-lock.json can commit (and pass) a bundle built from the drifted dependencies; `./ci.sh --install` closes the second. Neither is blocking.

**Fix sketch:** Also flag files in plugins/horde/servers that the fresh build did not produce; have ci.sh compare node_modules/.package-lock.json with package-lock.json (or always `npm ci`) before the bundle check.

## DEP-10 — plugin.json and the marketplace entry carry no version: validator warns, clone installs show 0.1.0 forever

- [x] closed in 9bfba96 — **Executed evidence:** plugins/horde/.claude-plugin/plugin.json carries version 0.2.0, checked equal to packages/opencode/package.json by bundle-plugin.mjs --check; claude plugin validate plugins/horde → 'Validation passed' with no version warning
- **Severity:** low · **Confidence:** high
- **Location:** `plugins/horde/.claude-plugin/plugin.json:1`

**Evidence:** `claude plugin validate .` → "plugins[0] plugin.json → version: No version specified" (and ICON_MISSING for the plugin directory); `claude plugin validate plugins/horde` → same warning; both 'Validation passed with warnings'. `claude plugin list --json` on this machine: the directory-marketplace install reports "version": "0.1.0" with readFromFolder /home/swr/workspace/mcp-horde/plugins/horde; the GitHub install reports the commit sha. scripts/bundle-plugin.mjs:16 comment: 'plugin.json has none, so installs follow new commits'.

**Why it matters:** Deliberate and, for GitHub installs, effective (see the first finding). The cost is cosmetic: `claude plugin list` cannot tell two clone installs apart, and `claude plugin tag` (listed in `claude plugin --help`) has nothing to tag. Not a defect for the milestone.

## DEP-11 — GitHub install, update and boot verified end to end in an isolated Claude config dir

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `install.sh:13`

**Evidence:** CLAUDE_CONFIG_DIR=<scratch>/cfg-gh claude plugin marketplace add serhaturtis/mcp-horde --json → {"outcome":"ok",..."Cloning via SSH: git@github.com:serhaturtis/mcp-horde.git ... Successfully added marketplace: mcp-horde"}; claude plugin install horde@mcp-horde --scope user --json → {"outcome":"ok","scope":"user"}; claude plugin list --json → "version": "2551820d4b37" (the commit sha), installPath .../plugins/cache/mcp-horde/horde/2551820d4b37 containing .claude-plugin .mcp.json README.md evals hooks servers skills, servers/ holding board.js cli.js context.js ledger.js opencode.js supervisor.js verify.js package.json and grammars/*.wasm.gz. claude plugin marketplace update mcp-horde --json → "Successfully updated marketplace"; claude plugin update horde@mcp-horde --json → "updateOutcome":"up_to_date" (2551820d4b37); after one commit in the marketplace clone: "updateOutcome":"updated","oldVersion":"2551820d4b37","newVersion":"5bdba3eee82d" ... Restart to apply changes, and the new cache dir carries the changed README. With GIT_SSH_COMMAND=false: "SSH clone failed, retrying with HTTPS: https://github.com/serhaturtis/mcp-horde.git ... Successfully added marketplace". Booting the five bundles from the cache with XDG_* pointed at scratch (scratchpad/audit/deploy/boot-from-github-cache.txt): opencode 24 tools (horde_do horde_investigate horde_wait horde_tell horde_land horde_drop opencode_* review_task), board 14, verify 5, context 7, ledger 2, each in ~200 ms, server version 0.2.0. ~/.claude/plugins/installed_plugins.json and known_marketplaces.json mtimes unchanged before/after. Transcripts: scratchpad/audit/deploy/gh-install-experiment.txt, gh-update-experiment.txt, gh-nossh-experiment.txt.

**Why it matters:** This is the milestone's central question (install from GitHub on another machine, run, update, following only the docs). The documented commands exist in `claude plugin --help` / `claude plugin marketplace --help` / `claude plugin update --help` of Claude Code 2.1.312, succeed as written, and the bundler's comment that installs follow new commits because plugin.json has no version (scripts/bundle-plugin.mjs:16) is true for GitHub-sourced marketplaces: the plugin version is the commit sha and `claude plugin update` copies on a new one.

## DEP-12 — install.sh: dry runs, idempotence, fresh-config path and the curl|bash shape all behave

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `install.sh:75`

**Evidence:** ./install.sh --dry-run → "horde@mcp-horde is already installed for every project" + note about the project-local install, exit 0; ./install.sh --github --dry-run → "the mcp-horde marketplace already points at /home/swr/workspace/mcp-horde; keeping it", exit 0; CLAUDE_CONFIG_DIR=<empty> ./install.sh --github --dry-run → "+ claude plugin marketplace add serhaturtis/mcp-horde" / "+ claude plugin install horde@mcp-horde --scope user"; (cd /tmp && bash .../install.sh --dry-run) → "+ claude plugin marketplace add /home/swr/workspace/mcp-horde"; bash -s -- --github --dry-run < install.sh (the curl|bash shape) → same two commands, exit 0. On an empty config dir `claude plugin marketplace list --json` and `claude plugin list --json` print `[]` (exit 0) and json_find prints nothing, so `existing=$(...)` is empty under set -euo pipefail. printf '...claude plugin marketplace list --json >/dev/null\necho AFTER...' | bash -s → AFTER-MARKETPLACE / AFTER-LIST (the claude subcommands do not swallow the script from stdin). The --github comparison key works: marketplace list JSON has "repo": "serhaturtis/mcp-horde" for GitHub sources and "path": "/home/swr/workspace/mcp-horde" for directory sources, matching `x.path ?? x.repo ?? x.url` at install.sh:75. Transcripts: scratchpad/audit/deploy/install-dry-run.txt, install-fresh-probe.txt, fresh-config-probe.txt.

**Why it matters:** Every branch of the installer that can be reached without changing this machine's state was exercised; the JSON shapes it depends on were observed rather than assumed.

## DEP-13 — Model ids `deepseek/deepseek-flash`, `deepseek/deepseek-v4-pro`, `deepseek/deepseek-v4-flash` exist in the catalog

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `plugins/horde/README.md:45`

**Evidence:** Cited: deepseek/deepseek-flash ×16, deepseek/deepseek-v4-flash ×5, deepseek/deepseek-v4-pro ×2 (grep over README.md, plugin README, skills, DESIGN.md, install.sh, ci.sh, package READMEs). models.dev api.json → deepseek: deepseek-v4-flash, deepseek-v4-pro, deepseek-v4-flash-vision-exp, deepseek-flash. `opencode models` here → deepseek/deepseek-flash, deepseek/deepseek-v4-pro (deepseek-v4-flash not offered by this machine's provider config, which is a local matter).

**Why it matters:** Verified-clean record for the DeepSeek ids install.sh --default-model, the user-level horde.json example, ci.sh --live and the setup skill use.

## DEP-14 — Tool names and horde_* parameters in the user-facing docs match the registered tools

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `plugins/horde/skills/horde/SKILL.md:12`

**Evidence:** 52 names found in packages/*/src (scratchpad/audit/deploy/tools-src.txt) == the 52 names the five bundles list from the GitHub cache (24+14+5+7+2). comm -23 src docs → empty (every registered tool is documented somewhere); comm -13 → only the eight DESIGN.md names above. The skill's parameter names (horde_do {goal, done, scope}; horde_investigate {question, want, focus}; horde_tell approve/model/scope/done; horde_land message; verify_gate fresh) match packages/opencode/src/horde.ts and packages/verify/src/index.ts:110-133 (base, checks, allowed, fresh, related, budget_chars).

**Why it matters:** Verified-clean record for the docs-as-instructions sub-scope.

## DEP-15 — Boot defaults: repository from cwd (correct under Claude Code), no fixed localhost port

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `packages/opencode/src/backend.ts:427`

**Evidence:** Defaults: board/src/index.ts:19, verify/src/index.ts:22, context/src/index.ts:22, ledger/src/index.ts:18, opencode/src/config.ts:95 all resolve HORDE_*_DIRECTORY || process.cwd(); CLAUDE_PROJECT_DIR is never read (grep). Live check: readlink /proc/<pid>/cwd for the 20 running `node .../plugins/horde/servers/*.js` processes → each equals its session's project dir (/home/swr/workspace/loracraft, digicorp, mcp-horde, /home/swr/tools/open-design); a server's environ carries CLAUDE_PROJECT_DIR, CLAUDE_PLUGIN_ROOT=/home/swr/workspace/mcp-horde/plugins/horde, CLAUDE_CODE_SESSION_ID. Ports: freePort() binds 127.0.0.1:0 (backend.ts:375-384), serveArgs → ["serve","--hostname","127.0.0.1","--port",port] (backend.ts:427-429), three attempts (backend.ts:435); HORDE_OPENCODE_URL defaults to none (config.ts:97) and a non-loopback URL is refused without a password unless HORDE_OPENCODE_ALLOW_INSECURE (backend.ts:57-67). State under $XDG_STATE_HOME/mcp-horde (config.ts:94-106, board.ts:148, gate.ts:99), worktrees under $XDG_DATA_HOME/mcp-horde/worktrees (worktree.ts:24-25).

**Why it matters:** Nothing requires a variable at boot; the only localhost binding uses an OS-chosen free port, so another listener on this machine cannot collide (the freePort→spawn window is a TOCTOU retried three times, acceptable).

## DEP-16 — OpenCode pin, install hints and the GitHub raw URL agree with reality

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `install.sh:69`

**Evidence:** packages/opencode/package.json: "@opencode/client": "2.1.1", devDependencies "@opencode/cli": "2.1.1"; node_modules/@opencode/cli/package.json name @opencode/cli version 2.1.1, node_modules/.bin/opencode --version → "opencode v2.1.1" (so `npm i -g @opencode/cli@2.1.1` at install.sh:71 names a real package and version). Machine binary: `opencode v2.1.4` at /home/swr/.opencode/bin/opencode; install.sh:69 regex (^|[^0-9.])v?2\. accepts it; backend.ts:17 TESTED_OPENCODE {2,1} warns only outside 2.1.x; plugins/horde/README.md:53 'tested with 2.1.1' is consistent. curl -sI https://opencode.ai/v2/install → HTTP/1.1 200, text/plain. curl -o /dev/null -w %{http_code} https://raw.githubusercontent.com/serhaturtis/mcp-horde/master/install.sh → 200; git ls-remote origin master → 2551820 == local HEAD (the bundles in the GitHub clone are the committed ones).

**Why it matters:** Verified-clean record for the external-reality sub-scope.

## DEP-17 — In-app commands `/plugin marketplace add`, `/plugin install`, `/reload-plugins` not verifiable from the CLI

- [ ] *(open)*
- **Severity:** info · **Confidence:** low
- **Location:** `README.md:38`

**Evidence:** README.md:38, plugins/horde/README.md:17 (`/plugin marketplace add serhaturtis/mcp-horde`, `/plugin install horde@mcp-horde`), install.sh:102 (`/reload-plugins`). The CLI equivalents (`claude plugin marketplace add`, `claude plugin install`) exist and were executed; the slash-command forms need an interactive session.

**Why it matters:** Marked for completeness. Confirming them takes one interactive session: type `/plugin` and `/reload-plugins` in Claude Code 2.1.312.

## DEP-18 — Clone path: Claude Code reads the plugin in place, so `git pull` updates it as the README says

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `README.md:32`

**Evidence:** `claude plugin list --json` for the user-scope install: "readFromFolder": "/home/swr/workspace/mcp-horde/plugins/horde" (installPath is a cache entry); a live server's environ (/proc/<pid>/environ of servers/board.js) has CLAUDE_PLUGIN_ROOT=/home/swr/workspace/mcp-horde/plugins/horde and the process cmdline is `node /home/swr/workspace/mcp-horde/plugins/horde/servers/board.js`.

**Why it matters:** The README.md:32 and install.sh:11 claim holds; a pull changes what the next session runs (running servers keep the old code until restart, which the README's 'New Claude Code sessions' wording covers).

## DEP-19 — evals/README.md command is valid against `claude plugin eval --help`; the pinned scaffold commit exists

- [ ] *(open)*
- **Severity:** info · **Confidence:** high
- **Location:** `plugins/horde/evals/README.md:26`

**Evidence:** Flags used at evals/README.md:26-27: --runs --ablation --model --scaffold --trust-plugin --allow-tools --max-cost-usd --no-publish; all appear in `claude plugin eval --help` (2.1.312). git cat-file -t 7caae37 → commit; evals/scaffold.sh pins 7caae37275c68988fdc6828151307813c1787c6e and clones `git -C <plugin>/evals rev-parse --show-toplevel`, i.e. the enclosing checkout — which the README's 'From the repository root' covers (the GitHub cache copy is not a git repository, so --scaffold would not work from an installed-plugin target).

**Why it matters:** Verified-clean record; the scaffold's dependence on a checkout is consistent with the README's instruction.
