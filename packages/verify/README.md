# @mcp-horde/verify

An MCP server that judges code changes mechanically and answers in a few hundred characters. It runs a project's own checks (tests, typecheck, lint), audits the diff for the ways cheap models fake success, and returns PASS or FAIL with only what someone needs to act on.

It exists so that an orchestrating model (Claude in Claude Code, or any MCP harness) never has to read raw test logs or whole diffs to know whether a worker's change is done. `@mcp-horde/opencode` uses it as a library to gate its agents.

```text
FAIL · 1 check failed, 2 blocking findings, 2 warnings · 513ms
✗ test · 1 failed, 0 passed, 1 skipped · 281ms
✓ lint · ok · 177ms
  ✗ test: adds — test/math.test.js:4
    Expected values to be strictly equal:

    -1 !== 3
audit: 4 files changed, 0 commits since de5399ad
  ✗ scope: TODO.txt adds a file outside the allowed scope
  ✗ tests: test/math.test.js:5 skips a test
  ! dependencies: package.json adds left-pad@^1.3.0
  ! suppressions: src/math.js:1 silences the type checker (@ts-ignore/@ts-nocheck)
```

## Tools

| Tool | What it does |
| --- | --- |
| `verify_gate` | Runs the checks and, given `base`, audits base → working tree. PASS only when every check passed and nothing blocking was found. |
| `verify_run` | Runs checks without the audit (e.g. after merging several branches). |
| `verify_audit` | The audit alone, one line per finding. |
| `verify_detect` | Which checks would run and where each comes from. |
| `verify_logs` | The full output of a check's latest run, for when the excerpt is not enough. |

## Related tests

`verify_gate { base, related: true }` (and `verify_run { related_to: [files] }`) runs only the tests that cover what changed, using `@mcp-horde/context` to map files to tests: tests named after them (next to them or in a mirrored test directory) and every test that reaches them through imports, at any depth, including workspace package names. It narrows only when that is safe, and the verdict says what happened:

```text
✓ test · 12 passed · 3.1s · related tests only (2 files)
✓ test · 412 passed · 48s · full suite: 1 changed file(s) without related tests (package.json)
! tests: no test covers 1 changed source file(s): src/rate.ts
```

- The full suite runs when any changed file is not a source file with a known test (config, manifests, fixtures, untested code), or when the runner cannot take test paths.
- Runners that can: pytest, vitest, jest, `go test ./...` (narrowed to packages), and `npm test` when the script is a plain vitest or jest call. Other checks (typecheck, lint) always run in full.
- A test check whose directory has neither changes nor related tests (another package in a monorepo) is skipped.
- Changed source files that no test covers are a warning, never a blocker.

`@mcp-horde/opencode` gates use related tests by default (`related_only: false` to turn it off). Run the full suite yourself after merging (`verify_run`).

An unchanged tree is never re-run: the key is HEAD, the working-tree diff, untracked files, and the exact checks and audit settings, so polling a gate is free.

## What the verdict contains

**Checks.** Each check's outcome with exact counts when the runner prints them (`40 failed, 212 passed`). For each failure: the test name, file and line, the assertion text, and the first stack frame in project code (dependency and runtime frames are skipped). Extractors understand:

- test runners: node:test (TAP and spec reporters), jest, vitest, pytest, cargo test, go test
- compilers and type checkers: tsc, rustc/cargo build, mypy
- linters: Biome, ESLint, ruff

Anything else gets a generic excerpt around the first error, or the end of the output. A check that fails without its runner naming a failure (a coverage threshold, a crash, a timeout) still says why. When failures exceed the budget, the verdict says how many were not shown, so counts are never lost.

**Audit** (base → working tree, committed and uncommitted, plus untracked files):

| Category | Finds | Default |
| --- | --- | --- |
| `scope` | changed files outside the `allowed` globs | block |
| `tests` | deleted test files, tests moved out of the suite, `.skip`/`.only`/`xit`/`@pytest.mark.skip`/`t.Skip`/`#[ignore]`; removed assertions and rewritten snapshots (always warnings) | block |
| `secrets` | access keys, private keys, tokens, hard-coded credentials (the value is never printed) | block |
| `binaries` | binary files, files over 1 MB | block |
| `suppressions` | `@ts-ignore`, lint disables, `# type: ignore`, `# noqa`, casts through `any`, empty `catch`, `except: pass` | warn |
| `dependencies` | added, removed or changed packages (package.json, requirements, Cargo.toml, pyproject.toml, go.mod), lockfile changes | warn |
| `git` | merge commits on the branch | warn |

## Where checks come from

From `horde.json` at the repository root when it defines them; otherwise detected from the nearest project root (walking up from the directory to the repository root):

| Found | Checks |
| --- | --- |
| `package.json` | `typecheck` (or `type-check`, `check-types`, `tsc`), `lint` (or `check`), `test`; `build` only when there is no typecheck script. npm's placeholder `test` script is ignored. pnpm, yarn and bun are detected from their lockfiles. |
| `pyproject.toml`, `pytest.ini`, `setup.cfg`, … | mypy and ruff when configured, pytest when configured or a `tests/` directory exists; a local `.venv` is used when present |
| `Cargo.toml` | `cargo test` |
| `go.mod` | `go vet ./...`, `go test ./...` |
| `Makefile` (only when nothing else is found) | `make lint`, `make check`, `make test` |

```json
{
  "verify": {
    "checks": {
      "typecheck": "npm run typecheck",
      "unit": { "command": "npm test -- --run", "kind": "test" },
      "api": { "command": "pytest -q", "cwd": "services/api" }
    },
    "timeoutSeconds": 600,
    "audit": {
      "allowed": ["src/**", "test/**"],
      "block": ["scope", "tests", "secrets", "binaries"],
      "warn": ["suppressions", "dependencies", "git"],
      "off": []
    }
  }
}
```

Checks run one at a time, in their own process group (killed as a whole on timeout or cancel), with `CI=1` and colour disabled. These inherited variables are removed: `FORCE_COLOR` (some tools treat any value as "force colour on"), `NODE_TEST_CONTEXT` (a `node --test` that inherits it reports to a parent that is not listening and exits 0), `OPENCODE_SERVER_*` and `HORDE_*`.

## Setup

```sh
claude mcp add verify -- node /path/to/mcp-horde/packages/verify/dist/index.js
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `HORDE_VERIFY_DIRECTORY` | current directory | Default project directory for the tools. |
| `HORDE_VERIFY_STATE_DIR` | `~/.local/state/mcp-horde/verify` | Where check logs are kept (latest run per check and directory). |

## Known limits

- **Related tests are found by naming and static imports**, not coverage data. A test that reaches the changed code only at run time (dynamic `import(variable)`, dependency injection by name, a subprocess) is not selected; that is why gates say "related tests only" and the full suite still runs after merging.
- **The audit reads lines, not syntax.** It flags suppressions and skipped tests by pattern, so an unusual spelling can slip through or a harmless string can match. Blocking categories are chosen to be the ones where false positives are rare.
- **`bash` can write anywhere.** Scope is checked after the fact from the diff; preventing out-of-scope edits up front is the job of the agent's permission profile.
