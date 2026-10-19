# @mcp-horde/review

Checks a worker's work against its task's acceptance criteria. The gate proves the code builds and its tests pass; a review asks whether the change does what the task asked, one criterion at a time.

It is a library: the `review_task` tool of [`@mcp-horde/opencode`](../opencode) runs it, because that server owns the models (a review is a one-shot `opencode_ask` with a checked JSON answer).

```text
review_task id:"t-3fa2"
  review t-3fa2 "Rate limit login" by moonshot/kimi-k3: 1/3 met, 1 not met
  ✓ 1. 429 after 5 failures per minute — src/api/login.ts:40-52, test/api/login.test.ts:12
      returns 429 once the window holds 5 failures
  ✗ 2. the limit is configurable — src/api/login.ts:8
      the limit is a constant (LIMIT = 5); nothing reads it from config
  ? 3. failures are logged
      said met, but cited no line of the change
  ($0.004)
```

## How it works

- **What is reviewed:** the task's acceptance criteria (its goal, when it has none) and the latest attempt's change. That is the attempt's worktree diff from the commit it started at, with uncommitted and untracked files included, as recorded by `opencode_spawn { task }`. Pass `path` and `base` to review another checkout.
- **What the reviewer sees:**
  - the diff, with new-file line numbers (`L42 +code`);
  - the definitions the change touches;
  - a budget (60k characters by default): files that do not fit are listed as not reviewed, never silently dropped.
- **Evidence is checked:**
  - Every criterion needs a verdict (met, not met, unclear) and a note.
  - "Met" needs cited lines. Each citation is checked against the lines the diff actually shows.
  - A "met" with no real line becomes "unclear", and invented citations are dropped and counted.
  - A criterion the reviewer skipped is "unclear".
  - So a cheap reviewer's confident guess cannot pass as evidence.
- **Who reviews:** by default the cheapest `horde.json` tier model other than the one that did the work. Two or three `models` cross-check each other, and the output lists where they disagree.
- **Where it is kept:** the first reviewer's outcome is stored on the attempt; `board_task` shows "review 2/3 met (1 not met) by …".
