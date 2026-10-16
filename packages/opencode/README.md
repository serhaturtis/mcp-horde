# @mcp-horde/opencode

An MCP server that lets any harness delegate work to [OpenCode](https://opencode.ai) agents. It works the way Claude Code's own subagents do, but each agent can run any model OpenCode supports. For example, a Claude model in Claude Code can run several DeepSeek agents in parallel, check on them, redirect them, and collect their results.

It is built on OpenCode's **v2 server API** (`/v2/session/*`, through `@opencode-ai/sdk/v2`).

## What the orchestrator can do

| Capability | Tool |
| --- | --- |
| Discover models, effort variants and agent profiles | `opencode_models`, `opencode_agents` |
| Spawn an agent with a chosen model, effort level (`variant`), agent profile and directory, either in the background or blocking | `opencode_spawn` |
| Run agents in parallel, each in its own git worktree if needed | `opencode_spawn` with `isolation: "worktree"` |
| Block until the first agent finishes, or until all of them do, and get their final answers | `opencode_wait` (`mode: "any" \| "all"`) |
| See what an agent is doing right now | `opencode_status` |
| Interact while it runs: `steer` lands at the agent's next step, `queue` lands after its current turn. Can also switch model, effort, agent profile or permission policy | `opencode_message` |
| Pause, then resume | `opencode_interrupt`, `opencode_resume` |
| Answer permission requests and questions | `opencode_respond` |
| Read the transcript (final answer, summary, or full with tool outputs) | `opencode_output` |
| Clean up (and optionally remove the worktree) | `opencode_dispose` |

Each agent is an ordinary OpenCode session. You can address it by its `ses_…` id or by the `name` you gave it at spawn. Ids stay valid across restarts of this server: `opencode_status include_untracked:true` lists earlier sessions, and you can pass their ids to any tool. If you attach to a long-running server (see `HORDE_OPENCODE_URL` below), you can also watch an agent live with `opencode attach <url>`.

### Agent states

| State | Meaning |
| --- | --- |
| `running` | Working, or about to start on a prompt it just received |
| `needs_input` | Blocked on a permission request (`per_…`) or a question (`que_…`). Answer it with `opencode_respond` |
| `idle` | Finished its turn; the result is included in the `opencode_wait` output |
| `interrupted` | Paused by `opencode_interrupt`. Messages it had not picked up yet are delivered when it resumes |
| `error` | The last turn failed (for example a provider error). Use `opencode_resume` to retry |

### Permissions

OpenCode asks before running risky tools, based on your opencode config. Each agent has a policy, set per spawn (`permissions`) or as a default (`HORDE_OPENCODE_PERMISSIONS`):

- `ask` (default): the request shows up as `needs_input`, and you answer it with `opencode_respond` (`once`, `always` or `reject`).
- `allow`: every request is approved automatically. Use this only for trusted tasks, ideally together with `isolation: "worktree"`.
- `deny`: every request is rejected automatically, and the agent is told to find another way.

## Setup

1. Install OpenCode (`npm i -g opencode-ai`) and configure at least one provider, for example `opencode auth login` or a `provider` block in `opencode.json`.
2. Build this package (`npm install && npm run build` at the repository root).
3. Register it with your harness.

**Claude Code**

```sh
claude mcp add opencode -e HORDE_OPENCODE_MODEL=deepseek/deepseek-chat -- node /path/to/mcp-horde/packages/opencode/dist/index.js
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "opencode": {
      "command": "node",
      "args": ["/path/to/mcp-horde/packages/opencode/dist/index.js"],
      "env": { "HORDE_OPENCODE_MODEL": "deepseek/deepseek-chat" }
    }
  }
}
```

Any other MCP client takes the same command over stdio.

### Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `HORDE_OPENCODE_URL` | none | Attach to a running `opencode serve` instead of spawning a private one |
| `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME` | random / `opencode` | Basic-auth credentials for that server |
| `HORDE_OPENCODE_BIN` | `opencode` | Binary used to spawn `opencode serve` |
| `HORDE_OPENCODE_DIRECTORY` | the current working directory | Default working directory for agents |
| `HORDE_OPENCODE_MODEL` | opencode's default | Default `provider/model` |
| `HORDE_OPENCODE_VARIANT` | none | Default effort variant, used only with the default model |
| `HORDE_OPENCODE_AGENT` | `build` | Default agent profile |
| `HORDE_OPENCODE_PERMISSIONS` | `ask` | Default permission policy: `ask`, `allow` or `deny` |

Without `HORDE_OPENCODE_URL`, the server starts a private `opencode serve` on a free localhost port the first time a tool is called. It protects that server with a random password and stops it on exit.

## Example session (Claude Code orchestrating DeepSeek)

```text
opencode_spawn  name:"api-tests"  model:"deepseek/deepseek-chat" variant:"high" isolation:"worktree"
                prompt:"Add integration tests for src/api/users.ts covering ..."
opencode_spawn  name:"docs"       model:"deepseek/deepseek-chat" agent:"build"
                prompt:"Update docs/api.md to describe ..."
opencode_wait   mode:"any"                      → docs IDLE, result: "Updated docs/api.md …"
opencode_status ids:["api-tests"]               → RUNNING, doing: bash: npm test
opencode_message id:"api-tests" message:"Use the fixtures in test/fixtures, not new mocks."
opencode_wait   ids:["api-tests"]               → NEEDS_INPUT, needs permission per_…: bash ["npm install supertest"]
opencode_respond id:"api-tests" request_id:"per_…" decision:"once"
opencode_wait   ids:["api-tests"]               → IDLE, result: "Added 12 tests …" (branch horde/api-tests)
opencode_dispose id:"api-tests" remove_worktree:true   → keeps the branch if it has commits
```

## Notes and limits

- OpenCode's `POST /v2/session/{id}/wait` endpoint returns 503 in opencode 1.19, so this server waits on its own. It listens to `/v2/event` and also polls, so if the event stream drops, waits are only slower.
- `opencode_wait` defaults to a 300 s timeout and sends MCP progress notifications while it waits. When it times out, the agents keep working; call it again.
- Worktrees are created at `.git/horde-worktrees/<name>` on branch `horde/<name>`, so they never show up as untracked files in your checkout. Merging the results is up to the orchestrator.
- The permission policy and agent names are kept in this server's memory. After a restart, address agents by `ses_…` id; they get the default policy.

## Development

```sh
npm run build
npm test   # starts a real `opencode serve` from devDependencies against a mock OpenAI-compatible LLM
```

The integration tests (`test/integration.test.ts`) drive the server over stdio, the same way a real harness does. Set `SHOW_OUTPUT=1` to print every tool call and its response.
