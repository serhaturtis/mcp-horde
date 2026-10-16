# Audit: @mcp-horde/opencode

Merged findings from a full audit (one manual pass plus three independent reviews). `[x]` = fixed, with a regression test where feasible.

## State tracking (tracker.ts)

- [x] T1. The interrupt detection regex `/interrupt|abort/i` matches ordinary tool errors (e.g. "operation was aborted"), which ends turns early and reports finished work as interrupted. Match OpenCode's exact interrupt messages instead.
- [x] T2. An interrupted tool (e.g. a rejected question) leaves the loop "open" (`inLoop` stays true), so the next prompt is merged into the dead turn as a steer. Close the turn on an interrupt, and start a new turn after an interrupted or failed one.
- [x] T3. `step.ended` ends the turn whenever `turn.interrupted` is set, even if the loop continues. Remove that clause.
- [x] T4. `openTool` is a single slot, so parallel tool calls show the wrong activity. Use a map keyed by call ID.
- [x] T5. The `turn` transcript starts at the `prompted` time, which drops queued prompts that were admitted earlier. Record the admitted time on the turn.
- [x] T6. Interrupted state compares a local `Date.now()` with server timestamps (clock skew in attach mode). Track interruptions by history sequence number.

## Fleet logic (fleet.ts)

- [x] F1. Limits are checked against the previous, already-ended turn, so resuming after a limit or a long idle period is killed immediately. Only enforce limits on an open turn.
- [x] F2. Pause-after-step fires on child sessions and on the final step (a finished agent is reported as interrupted). The flag also persists into later turns, and the call has no `.catch` (an unhandled rejection crashes the server).
- [x] F3. `prompt()` writes `live.state` outside the refresh lock, so a stale in-flight refresh sends a spurious "settled" push.
- [x] F4. `markReported` reads live data instead of the snapshot that was shown, so a turn that ends concurrently is marked as reported without ever being shown.
- [x] F5. Limit enforcement can flap (repeated interrupts and duplicate pushes) while the session still looks active.
- [x] F6. Cost, token and step limits ignore child sessions.
- [x] F7. Every event queues a full refresh (refresh storm). Coalesce refreshes.
- [x] F8. Children are never pruned, and requests are polled for every child that ever existed.
- [x] F9. A dialog that times out, fails or can't be shown is asked again forever, and a dialog that never resolves blocks the request permanently. Fall back to the caller, use a long timeout, check form capability, and let `respond` override a pending dialog.
- [x] F10. A needs_input → idle/error/interrupted transition sends no push, because `respond` doesn't mark the agent running.
- [x] F11. An admitted entry that is never promoted pins the agent to "error" forever. The grace period is also too short for a fresh worktree to boot.
- [x] F12. The 404 path leaves `childToRoot` entries behind. One failing agent makes the whole `status` / `wait` call throw, and a 404'd id is re-adopted on every call.
- [x] F13. Adopting a session mid-turn hides that turn's result. A failed first refresh leaves `reportedSeq` at `MAX_SAFE_INTEGER` forever.
- [x] F14. Adoption applies the default policy to a human's TUI session (auto-approving its permission prompts), records the wrong directory, and adopts child session ids as root agents.
- [x] F15. Multiple MCP processes drive the same agents (double dialogs, stolen results, stale policies). Add an ownership model.
- [x] F16. Spawn errors:
  - attachments are only read after the session already exists;
  - a failure leaves a zombie record and leaks the session;
  - a failing snapshot after a successful prompt tears down a running agent, and a retry duplicates it.
- [x] F17. The capacity check isn't atomic (concurrent spawns exceed the cap), and agents in the `undefined` state aren't counted.
- [x] F18. `opencode_message` merges limits with explicit `undefined` values, which erases the other limits.
- [x] F19. A variant-only switch fails when the model came from the configured default (no fallback to `track.model`).
- [x] F20. `onEvent` can throw (`addChild` on a removed root), which tears down the event stream.
- [x] F21. The `handled`, `reportedRequests` and `handedToCaller` sets grow without bound.
- [x] F22. Every agent ever recorded is refreshed every 15 s. Settled agents should rely on events plus a slow poll.
- [x] F23. An empty model catalog is cached for 60 s.
- [x] F24. The default name `agent-<time>` collides when two spawns land in the same millisecond. Add a random suffix.
- [x] F25. A relative `directory` is resolved against the process cwd instead of `HORDE_OPENCODE_DIRECTORY`.
- [x] F26. A disposed agent can be silently re-adopted through a stale id.
- [x] F27. `resume` sends "You were interrupted" even to idle or running agents.
- [x] F28. When `wait` times out, results that were already shown aren't marked as reported, and the header says "no news" anyway.
- [x] F29. Limits aren't enforced while no MCP process is running (shared mode). Catch up on startup and document the gap.

- [x] F30. A prompt can be answered before its admission is readable in history, so a wait right after `opencode_message` returned the previous (settled) turn. Track sent prompts until history shows them.
- [x] F31. After a restart, agents whose state is not known yet count as working, so they block the running limit. Refresh them before reserving a slot.
- [x] F32. An interrupt we issue settles the agent without a refresh, so `opencode_wait` sometimes treated the interrupted agent as already reported. Record the settle time on interrupt.

## Persistence (state.ts)

- [x] S1. Read-modify-write on `state.json` races between processes (lost updates). Use one file per agent, written atomically.
- [x] S2. Lock problems:
  - non-EEXIST errors cause an infinite synchronous loop;
  - stale-lock stealing races;
  - a live holder can be stolen from after 60 s;
  - release deletes another process's lock.
- [x] S3. Records are keyed by server URL, which has a random port. Every server restart orphans all agents and worktrees. Use a stable server identity.

## Server lifecycle (backend.ts, supervisor.ts, index.ts)

- [x] B1. The server lock doesn't reload the server record, so two MCP processes can each spawn a shared server.
- [x] B2. `opencode_server stop`:
  - doesn't verify the PID before killing it;
  - doesn't kill the process group;
  - ignores the current mode;
  - reads stale state and isn't locked;
  - leaves the cached backend dead, so every later call fails.
- [x] B3. The health check has no timeout. An alive but unhealthy recorded server causes a duplicate spawn.
- [x] B4. Event stream: `streaming` is set before a connection exists, the backoff never grows, and a 401 makes it spin.
- [x] B5. A server that dies after startup is never detected. Reset the cached backend so the next call restarts it.
- [x] B6. Readiness accepts any response (even another process's 401), and the server record is persisted before the health check.
- [x] B7. The supervisor never escalates to SIGKILL and reports a signal death as exit code 0.
- [x] B8. `resolveBinary` can pick `node.exe` from an `IF EXIST` line in the shim.
- [x] B9. The loopback check accepts names like `127.example.com`.
- [x] B10. `opencode_server info` prints the password into the model's context.
- [x] B11. A shared server keeps the binary and environment of whichever process started it. Warn when the version or binary differs.
- [x] B12. There's no global `unhandledRejection` handler.
- [x] B13. OpenCode 1.19's v2 runner reports every step as free (`cost: 0`, even for priced models), so cost limits never tripped and costs showed $0. Estimate step costs from catalog pricing (context tiers, cache and reasoning tokens) when OpenCode reports none.

## Worktrees (worktree.ts)

- [x] W1. `link` paths aren't validated: `..` recursively deletes other worktrees, and `.` or tracked paths break isolation.
- [x] W2. `fs.cp` turns relative untracked symlinks into absolute links into the main checkout.
- [x] W3. `runSetup`:
  - only kills the shell, not the command's children;
  - can lose output (`exit` fires before `close`);
  - leaks `OPENCODE_SERVER_*` variables to the command;
  - has no abort or progress.
- [x] W4. `git diff` follows user config (noprefix, color, external diff) and can produce a corrupt patch.
- [x] W5. Untracked nested repos get copied together with their `.git` and committed as gitlinks.
- [x] W6. Large untracked trees are copied without a cap; the 256 MB patch buffer can fail.
- [x] W7. Linked paths aren't git-excluded, so the agent commits the symlink. The trailing-slash pathspec misses it too.
- [x] W8. On Windows, a file symlink fails with EPERM. Fall back to copying.
- [x] W9. No `commit.gpgsign=false`, git timeouts or `GIT_TERMINAL_PROMPT=0`, so commits and merges can hang.
- [x] W10. `commitAll` trusts `git status`, which respects `showUntrackedFiles=no`, so new files can be lost on remove.
- [x] W11. `commitAll` doesn't verify HEAD is on the agent's branch, or that no merge, rebase or cherry-pick is in progress.
- [x] W12. Merge picks up commits through a merge's second parent, which duplicates the user's own commits.
- [x] W13. A second merge replays the first batch again (`--keep-redundant-commits`). Remember the last merged commit.
- [x] W14. A failed merge aborts the user's own in-progress cherry-pick. Squash doesn't require a clean index.
- [x] W15. Merging into a detached HEAD is silently accepted.
- [x] W16. Branch names git rejects (`a..b`, `.x`, `x.lock`). Sanitize them.
- [x] W17. Concurrent creates race on the same branch or path. Retry on collision.
- [x] W18. The agent's directory may not exist in the new worktree (an untracked or ignored subdirectory).
- [x] W19. Submodules are not initialized. Dropped gitlink changes are silently ignored.
- [x] W20. `worktreeDiff` buffers the whole diff before truncating it.
- [x] W21. A `rev-list` error is treated as "0 commits", which leads to a wrong "deleted branch" message.
- [x] W22. `-z` output is trimmed, which corrupts a leading-space filename.
- [x] W23. A CRLF `info/exclude` file gets duplicate lines.

## MCP tools, hooks and rendering (tools.ts, hooks.ts, render.ts)

- [x] M1. The resource `list` callback starts the OpenCode server.
- [x] M2. The 1800 s default wait breaks in clients with a 60 s timeout. Pick the default per client.
- [x] M3. `result_chars` isn't a maximum (it has a floor of 500 per turn).
- [x] M4. The turn-label regex removes real prompt text.
- [x] M5. Question dialogs:
  - comma splitting for multi-select;
  - no `required` field for `custom: false`;
  - legacy `enumNames` and empty descriptions.
- [x] M6. `readOnlyHint` is wrong for `opencode_wait`, which marks results as reported.
- [x] M7. Description mismatches:
  - agent default;
  - absolute directory;
  - an empty `opencode_agents` list;
  - the README says tools are never killed.
- [x] M8. A long spawn (worktree setup) sends no progress and can't be cancelled.

## Packaging, CI and tests

- [x] P1. `main` points at the CLI. Use `exports` instead, ship sources for the source maps, and read `VERSION` from package.json.
- [x] P2. Test files are never type-checked.
- [x] P3. CI tests only Node 22 (add 20) and sets no job timeout.
- [x] P4. The built package (`dist/index.js`, `supervisor.js`) is never run in tests.
- [x] P5. Tests depend on each other's order, and the graceful-pause test is timing-sensitive.
- [x] P6. Tests are missing for all of the fixes above.
- [x] P7. The config `bool` parser is case-sensitive, and a missing `HORDE_OPENCODE_DIRECTORY` gives a misleading error.
- [ ] P8. No license (left to the owner).
