import { formatTokens, formatUsd, indent, oneLine, truncate, truncateHead } from "@mcp-horde/core"
import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import type { Backend } from "./backend.js"
import { POLICIES } from "./config.js"
import type { Fleet, GateView, Snapshot } from "./fleet.js"
import { defined, formatModel, SETTLED, unsupportedReason } from "./fleet.js"
import type { Turn } from "./tracker.js"

type Extra = {
  signal: AbortSignal
  _meta?: { progressToken?: string | number }
  sendNotification: (n: { method: "notifications/progress"; params: Record<string, unknown> }) => Promise<void>
}

export interface Context {
  fleet: () => Promise<Fleet>
  backend: () => Promise<Backend>
  /** The fleet if it is already running (never starts a server). */
  peekFleet: () => Promise<Fleet> | undefined
  /** Stop the server for the current mode and drop the cached connection. */
  stop: () => Promise<string>
  /** Name of the connected MCP client, to pick sensible defaults. */
  clientName: () => string | undefined
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] })
const fail = (err: unknown): CallToolResult => ({
  content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
})

/**
 * Claude Code keeps long tool calls alive (and backgrounds them after 2 min);
 * most other clients time out after 60 s, so default to less there.
 */
function defaultWait(ctx: Context): number {
  return /claude/i.test(ctx.clientName() ?? "") ? 1800 : 50
}

const id = z.string().describe("Agent name (given at spawn) or session id (ses_…).")
const permissions = z
  .enum(POLICIES as [string, ...string[]])
  .describe(
    'Permission requests (shell commands, edits outside the project, …): "user" (default) shows them to the human as a dialog; "ask" hands them to you as needs_input; "allow" approves all; "deny" rejects all.',
  )
const questions = z
  .enum(["user", "ask", "dismiss"])
  .describe(
    'Questions the agent asks: "user" shows them to the human, "ask" hands them to you, "dismiss" makes the agent decide itself. Defaults follow permissions.',
  )
const limits = z
  .object({
    max_steps: z.number().int().min(1).optional().describe("Interrupt after this many agent-loop steps in one turn."),
    max_cost_usd: z.number().positive().optional().describe("Interrupt once a turn has cost this much."),
    timeout_minutes: z.number().positive().optional().describe("Interrupt a turn that runs longer than this."),
  })
  .describe("Safety limits per turn. Hitting one interrupts the agent (state interrupted, with the reason).")
const gate = z
  .union([
    z.boolean(),
    z.object({
      checks: z.array(z.string()).optional().describe("Only these checks (names from verify_detect / horde.json); default all."),
      audit: z.boolean().optional().describe("Audit the agent's diff (scope, test tampering, suppressions, deps, secrets). Default: on in a worktree."),
      allowed: z.array(z.string()).optional().describe('Scope globs, repo-relative, e.g. ["src/auth/**", "test/auth/**"].'),
      max_rounds: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("Gate runs before a failure is reported to you (each failure goes back to the agent first). Default 2."),
      related_only: z
        .boolean()
        .optional()
        .describe(
          "Run only the tests that cover the agent's changes when every change is covered and the runner takes test paths (otherwise the full suite). Default true; the verdict says which ran.",
        ),
    }),
  ])
  .describe(
    "Check the agent's work mechanically when it finishes: the project's tests/typecheck/lint (from horde.json or detected) and a diff audit. A failure goes back to the agent to fix, up to max_rounds; you only hear the outcome. true = defaults.",
  )
/** Base price per million tokens (the cheapest tier), "free" when the catalog says 0, "price unknown" without data. */
export function price(m: { cost: { input: number; output: number; tier?: unknown }[] }): string {
  const base = m.cost.find((c) => !c.tier) ?? m.cost[0]
  if (!base) return "price unknown"
  if (base.input === 0 && base.output === 0) return "free"
  const usd = (n: number) => `$${n < 1 ? n.toFixed(2).replace(/0$/, "") : n % 1 ? n.toFixed(2) : n}`
  return `${usd(base.input)}/${usd(base.output)} per M`
}

function gateIn(g?: z.infer<typeof gate>) {
  if (g === undefined || typeof g === "boolean") return g
  return { checks: g.checks, audit: g.audit, allowed: g.allowed, maxRounds: g.max_rounds, related: g.related_only }
}
const timeout = z
  .number()
  .int()
  .min(1)
  .max(86_400)
  .describe(
    "Max seconds to block (default 1800 in Claude Code, which backgrounds long calls; 50 elsewhere, to stay under the usual 60 s client timeout). Agents keep working after a timeout.",
  )
const files = z.array(z.string()).describe("Files to attach (paths relative to the agent's directory, or absolute).")

/** Only the keys the caller set: an omitted limit must not erase an existing one. */
function limitsIn(l?: { max_steps?: number; max_cost_usd?: number; timeout_minutes?: number }) {
  if (!l) return undefined
  return defined({ maxSteps: l.max_steps, maxCostUsd: l.max_cost_usd, timeoutMinutes: l.timeout_minutes })
}

/** Strip only the blocks this server injects into prompts, not the user's own markup. */
const INJECTED = /<(instructions|workspace|file)\b[^>]*>[\s\S]*?<\/\1>/g

function renderTurn(t: Turn, chars: number, label: boolean): string {
  const head = label ? `turn "${truncate(oneLine(t.prompt.replace(INJECTED, "")), 60)}":\n` : ""
  const body = t.finalText.trim() || (t.failure ? `(no answer: ${t.failure})` : "(no text answer)")
  return indent(`${head}${truncateHead(body, chars)}`)
}

const GATE_STATE: Record<GateView["state"], string> = {
  pending: "about to run checks",
  running: "running checks",
  retrying: "failed; the agent is fixing it",
  pass: "✓ PASS",
  fail: "✗ FAIL",
}

function renderGate(g: GateView): string {
  const rounds = `round ${Math.max(1, g.round)}/${g.maxRounds}`
  const head = `  gate: ${GATE_STATE[g.state]} (${rounds})`
  // A pass is one line; a final failure carries its verdict (already compact) so the caller can act.
  if (g.state === "fail" && g.text) return `${head}\n${indent(g.text, "    ")}`
  if (g.state === "pass" && g.text) return `${head} · ${g.text.split("\n")[0]!.replace(/^PASS · /, "")}`
  return head
}

export function renderSnapshot(s: Snapshot, opts: { resultChars?: number; mode?: "news" | "last" } = {}): string {
  const stats = [`${s.steps} steps`, formatUsd(s.cost), `${formatTokens(s.tokens.input + s.tokens.output + s.tokens.reasoning)} tok`].join(" · ")
  const lines = [`◆ ${s.name ? `${s.name} (${s.id})` : s.id} — ${s.state.toUpperCase()} · ${stats}`]
  if (s.title && !s.title.startsWith("New session") && !s.title.startsWith("horde: ")) lines.push(`  title: ${s.title}`)
  const lim = [
    s.limits.maxSteps && `${s.limits.maxSteps} steps`,
    s.limits.maxCostUsd && `$${s.limits.maxCostUsd}`,
    s.limits.timeoutMinutes && `${s.limits.timeoutMinutes} min`,
  ].filter(Boolean)
  lines.push(
    `  model: ${formatModel(s.model)} · agent: ${s.agent ?? "default"} · permissions: ${s.policy}/${s.questionPolicy}${lim.length ? ` · limits: ${lim.join(", ")}` : ""}`,
  )
  lines.push(`  dir: ${s.directory}${s.worktree ? ` (worktree, branch ${s.worktree.branch})` : ""}`)
  if (s.children.length) lines.push(`  subagents: ${s.children.join(", ")}`)
  if (s.activity) lines.push(`  doing: ${s.activity}`)
  if (s.retry) lines.push(`  ${s.retry}`)
  if (s.error) lines.push(`  ${s.state === "interrupted" ? "reason" : "error"}: ${truncate(s.error, 500)}`)
  if (s.gate) lines.push(renderGate(s.gate))
  for (const p of s.pending.permissions) {
    lines.push(
      `  needs permission ${p.id}${p.sessionID !== s.id ? ` (subagent ${p.sessionID})` : ""}: ${p.action} ${JSON.stringify(p.resources)} → opencode_respond once|always|reject`,
    )
  }
  for (const q of s.pending.questions) {
    q.questions.forEach((item, i) => {
      const opts = item.options.map((o) => o.label).join(" | ")
      lines.push(
        `  needs answer ${q.id}${q.questions.length > 1 ? ` #${i + 1}` : ""}: ${item.question}${opts ? ` [${opts}]` : ""}${item.multiple ? " (multi)" : ""}`,
      )
    })
  }
  const chars = opts.resultChars ?? 0
  if (chars > 0 && SETTLED.has(s.state) && s.state !== "needs_input") {
    // With a gate, the turns in between were fix-up rounds the gate line already accounts for: show the last answer only.
    const news = s.gate ? s.unreported.slice(-1) : s.unreported
    const turns = opts.mode === "news" && news.length ? news : s.lastTurn?.endedAt ? [s.lastTurn] : []
    // `chars` caps the total; the latest turns matter most.
    if (turns.length) {
      const per = Math.max(1, Math.floor(chars / turns.length))
      lines.push(`  result:\n${turns.map((t) => renderTurn(t, per, turns.length > 1)).join("\n")}`)
    }
  }
  return lines.join("\n")
}

/** Progress notifications for long single operations (e.g. worktree setup). */
function progressMessage(extra: Extra) {
  const token = extra._meta?.progressToken
  if (token === undefined) return undefined
  let n = 0
  return (message: string) => {
    void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++n, message } }).catch(() => undefined)
  }
}

function progress(extra: Extra) {
  const token = extra._meta?.progressToken
  if (token === undefined) return undefined
  let n = 0
  return (snaps: Snapshot[], elapsed: number) => {
    const running = snaps.filter((s) => !SETTLED.has(s.state)).map((s) => `${s.name ?? s.id}${s.activity ? ` (${truncate(s.activity, 60)})` : ""}`)
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: ++n, message: `${Math.round(elapsed / 1000)}s · ${running.join(", ")}` },
      })
      .catch(() => undefined)
  }
}

export function registerTools(server: McpServer, ctx: Context) {
  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    run: (args: z.infer<z.ZodObject<S>>, fleet: Fleet, extra: Extra) => Promise<string>,
    annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean } = {},
  ) => {
    server.registerTool(name, { description, inputSchema: shape, annotations: { openWorldHint: false, ...annotations } }, (async (
      args: z.infer<z.ZodObject<S>>,
      extra: Extra,
    ) => {
      try {
        const fleet = await ctx.fleet()
        const text = await run(args, fleet, extra)
        const warnings = (await ctx.backend()).info.warnings
        return ok(warnings.length && name === "opencode_status" ? `${text}\n\n⚠ ${warnings.join("\n⚠ ")}` : text)
      } catch (err) {
        return fail(err)
      }
    }) as never)
  }

  const waitAndRender = async (fleet: Fleet, ids: string[], mode: "any" | "all", seconds: number | undefined, extra: Extra, chars: number) => {
    const secs = seconds ?? defaultWait(ctx)
    const r = await fleet.waitFor(ids, mode, secs * 1000, { signal: extra.signal, onTick: progress(extra) })
    const news = r.snapshots.filter((s) => r.news.has(s.id))
    const running = r.snapshots.filter((s) => !SETTLED.has(s.state))
    const quiet = r.snapshots.filter((s) => SETTLED.has(s.state) && !r.news.has(s.id))
    const head = r.timedOut
      ? `Timed out after ${secs}s: ${news.length} with news, ${running.length} still running (they keep working; wait again).`
      : r.nothingToWaitFor
        ? "Nothing new: no listed agent is running, and their results were already reported."
        : `${news.length} with news, ${running.length} still running.`
    const parts = [head, ...news.map((s) => renderSnapshot(s, { resultChars: chars, mode: "news" })), ...running.map((s) => renderSnapshot(s))]
    if (quiet.length) parts.push(`Already reported: ${quiet.map((s) => `${s.name ?? s.id} (${s.state})`).join(", ")}`)
    if (r.errors.length) parts.push(`Could not read: ${r.errors.join("; ")}`)
    return parts.join("\n\n")
  }

  tool(
    "opencode_models",
    "List models OpenCode agents can run (any provider: DeepSeek, Kimi, GLM, Qwen, GPT, Claude, local …) with context size, price (USD per million input/output tokens, or free) and effort variants. Use the ids with opencode_spawn model/variant.",
    {
      provider: z.string().optional().describe("Only this provider id (e.g. deepseek, openrouter)."),
      query: z.string().optional().describe("Case-insensitive substring filter on the model id or name."),
      include_unsupported: z.boolean().optional().describe("Also list models the v2 agent runner cannot use."),
      directory: z.string().optional().describe("Project directory whose opencode config applies."),
    },
    async (a, fleet) => {
      const q = a.query?.toLowerCase()
      const all = (await fleet.models(a.directory)).filter(
        (m) => m.enabled && (!a.provider || m.providerID === a.provider) && (!q || `${m.providerID}/${m.id} ${m.name}`.toLowerCase().includes(q)),
      )
      const usable = all.filter((m) => !unsupportedReason(m))
      const shown = a.include_unsupported ? all : usable
      if (!shown.length) {
        return all.length
          ? `${all.length} model(s) match, but none can run agents (pass include_unsupported to see why).`
          : "No matching models. Configure providers in OpenCode (opencode auth login, or opencode.json)."
      }
      const lines = shown.map((m) => {
        const variants = m.variants.map((v) => v.id)
        const why = unsupportedReason(m)
        return `${m.providerID}/${m.id} — ${m.name} · ctx ${Math.round(m.limit.context / 1000)}k · ${price(m)} · ${variants.length ? `effort variants: ${variants.join(", ")}` : "no effort variants"}${why ? ` · UNSUPPORTED: ${why}` : ""}`
      })
      const hidden = all.length - usable.length
      return `${shown.length} model(s)${!a.include_unsupported && hidden ? ` (${hidden} unsupported hidden)` : ""}:\n${lines.slice(0, 300).join("\n")}${lines.length > 300 ? "\n… (narrow with provider/query)" : ""}`
    },
    { readOnlyHint: true },
  )

  tool(
    "opencode_agents",
    'List OpenCode agent profiles usable with opencode_spawn agent (e.g. "build" edits and runs commands, "plan" is read-only, plus custom ones from the project config).',
    { directory: z.string().optional().describe("Project directory whose opencode config applies.") },
    async (a, fleet) => {
      const lines = (await fleet.agents(a.directory))
        .filter((x) => !x.hidden && x.mode !== "subagent")
        .map(
          (x) =>
            `${x.id}${x.model ? ` · ${formatModel(x.model)}` : ""}${x.steps ? ` · max ${x.steps} steps` : ""}${x.description ? ` — ${truncate(x.description, 200)}` : ""}`,
        )
      return lines.length ? lines.join("\n") : "No agent profiles found (is OpenCode configured?)."
    },
    { readOnlyHint: true },
  )

  tool(
    "opencode_spawn",
    "Spawn an OpenCode agent on a task with any model and effort level. Returns immediately (it runs in the background) unless wait is set. Spawn several for parallel work, then opencode_wait. The agent does not see your conversation: make the prompt self-contained (put shared context in instructions).",
    {
      prompt: z.string().min(1).describe("The task."),
      name: z.string().optional().describe("Unique short name to address it by (letters, digits, . _ -)."),
      model: z.string().optional().describe('"provider/model" from opencode_models, chosen for this task. Omitted = OpenCode\'s configured default.'),
      variant: z.string().optional().describe('Effort level / model variant, e.g. "low", "high", "max" (see opencode_models; requires model).'),
      agent: z
        .string()
        .optional()
        .describe('Existing agent profile (opencode_agents), e.g. "build" or "plan" (read-only). Omitted = OpenCode\'s default profile.'),
      instructions: z.string().optional().describe("Role, constraints and context for the agent, prepended to the prompt (like a subagent system prompt)."),
      profile: z
        .object({
          tools: z.record(z.string(), z.boolean()).optional().describe('Enable/disable tools, e.g. {"bash": false, "webfetch": false}.'),
          steps: z.number().int().min(1).optional().describe("Max agent-loop steps per turn (enforced by OpenCode)."),
          description: z.string().optional(),
        })
        .optional()
        .describe('A custom agent profile created for this agent. Requires isolation "worktree" unless OpenCode has not opened the directory yet.'),
      directory: z.string().optional().describe("Working directory (absolute, or relative to the server's default directory, which is used when omitted)."),
      isolation: z
        .enum(["none", "worktree"])
        .optional()
        .describe('"worktree": own git worktree + branch horde/<name>, so parallel agents never collide. Merge with opencode_worktree.'),
      worktree: z
        .object({
          include_uncommitted: z.boolean().optional().describe("Copy your uncommitted and untracked changes into the worktree (default true)."),
          link: z.array(z.string()).optional().describe('Paths to symlink from the main checkout, e.g. ["node_modules", ".env"].'),
          setup: z.string().optional().describe('Shell command to run in the worktree before the agent starts, e.g. "npm ci" (killed after 15 min).'),
          submodules: z.boolean().optional().describe("Initialize submodules in the worktree (default: when the repo has any)."),
        })
        .optional(),
      permissions: permissions.optional(),
      questions: questions.optional(),
      limits: limits.optional(),
      files: files.optional(),
      gate: gate.optional(),
      wait: z.boolean().optional().describe("Block until it settles. Default false."),
      timeout_seconds: timeout.optional(),
    },
    async (a, fleet, extra) => {
      const { snapshot, notes } = await fleet.spawn({
        prompt: a.prompt,
        name: a.name,
        model: a.model,
        variant: a.variant,
        agent: a.agent,
        instructions: a.instructions,
        profile: a.profile,
        directory: a.directory,
        isolation: a.isolation,
        worktree: a.worktree && {
          includeUncommitted: a.worktree.include_uncommitted,
          link: a.worktree.link,
          setup: a.worktree.setup,
          submodules: a.worktree.submodules,
        },
        permissions: a.permissions as never,
        questions: a.questions,
        limits: limitsIn(a.limits),
        files: a.files,
        gate: gateIn(a.gate),
        signal: extra.signal,
        onProgress: progressMessage(extra),
      })
      const noteText = notes.length ? `\n${notes.map((n) => `  · ${n}`).join("\n")}` : ""
      if (a.wait) return `Spawned.${noteText}\n${await waitAndRender(fleet, [snapshot.id], "all", a.timeout_seconds, extra, 8000)}`
      return `Spawned.${noteText}\n${renderSnapshot(snapshot)}\nIt runs in the background: opencode_wait to collect the result.`
    },
  )

  tool(
    "opencode_message",
    'Talk to an agent. delivery "steer" (default) reaches it at its next step even mid-turn — use it to correct course; "queue" is handled after the current turn. An idle, interrupted or failed agent starts working again. Can also switch model, effort, agent profile, policies or limits first.',
    {
      id,
      message: z.string().min(1),
      delivery: z.enum(["steer", "queue"]).optional(),
      model: z.string().optional().describe('Switch to "provider/model" from now on.'),
      variant: z.string().optional().describe("Switch effort level from now on."),
      agent: z.string().optional().describe("Switch agent profile from now on."),
      permissions: permissions.optional(),
      questions: questions.optional(),
      limits: limits.optional(),
      files: files.optional(),
      gate: gate.optional(),
      wait: z.boolean().optional(),
      timeout_seconds: timeout.optional(),
    },
    async (a, fleet, extra) => {
      const snap = await fleet.message(a.id, a.message, {
        delivery: a.delivery,
        model: a.model,
        variant: a.variant,
        agent: a.agent,
        files: a.files,
        permissions: a.permissions as never,
        questions: a.questions,
        limits: limitsIn(a.limits),
        gate: gateIn(a.gate),
      })
      if (a.wait) return waitAndRender(fleet, [snap.id], "all", a.timeout_seconds, extra, 8000)
      return `Delivered (${a.delivery ?? "steer"}).\n${renderSnapshot(snap)}`
    },
  )

  tool(
    "opencode_wait",
    'Block until agents have news and return it (final answers, failures, pending requests). mode "any" (default) returns at the first agent with news and marks it seen, so call it again for the next one; "all" waits until every agent is settled. In Claude Code a long wait becomes a background task automatically.',
    {
      ids: z.array(z.string()).optional().describe("Agents to wait on. Default: all tracked agents."),
      mode: z.enum(["any", "all"]).optional(),
      timeout_seconds: timeout.optional(),
      result_chars: z
        .number()
        .int()
        .min(0)
        .max(100_000)
        .optional()
        .describe("Max chars of final answers per agent (default 6000; 0 = states only, read answers with opencode_output)."),
    },
    async (a, fleet, extra) => {
      const ids = a.ids?.length ? a.ids : fleet.ids()
      if (!ids.length) return "No agents. Start one with opencode_spawn."
      return waitAndRender(fleet, ids, a.mode ?? "any", a.timeout_seconds, extra, a.result_chars ?? 6000)
    },
  )

  tool(
    "opencode_status",
    "Peek at agents without blocking: state, what they are doing right now, pending requests, cost, last answer. With no ids: every agent this MCP session drives.",
    {
      ids: z
        .array(z.string())
        .optional()
        .describe('Agents to show. A session id this server does not track yet is adopted (with permissions/questions "ask").'),
      include_untracked: z
        .boolean()
        .optional()
        .describe("Also list recent OpenCode sessions in `directory` that are not tracked (pass their id to adopt one)."),
      directory: z.string().optional(),
    },
    async (a, fleet) => {
      if (a.ids?.length) {
        const ids = a.ids
        const results = await Promise.allSettled(ids.map((i) => fleet.snapshot(i)))
        return results
          .map((r, i) =>
            r.status === "fulfilled" ? renderSnapshot(r.value, { resultChars: 800, mode: "last" }) : `✗ ${ids[i]}: ${(r.reason as Error).message}`,
          )
          .join("\n\n")
      }
      const { snapshots, errors, untracked } = await fleet.list({ includeUntracked: a.include_untracked, directory: a.directory })
      const parts = snapshots.map((s) => renderSnapshot(s, { resultChars: 800, mode: "last" }))
      if (errors.length) parts.push(`Could not read: ${errors.join("; ")}`)
      if (untracked.length) {
        parts.push(
          `Untracked sessions (pass an id to adopt):\n${untracked.map((s) => `  ${s.id} — ${s.title} (${new Date(s.time.updated).toISOString()})`).join("\n")}`,
        )
      }
      return parts.length ? parts.join("\n\n") : "No agents yet. Start one with opencode_spawn."
    },
  )

  tool(
    "opencode_output",
    'Read an agent\'s transcript. detail "final" = last answer, "summary" (default) = messages plus one line per tool call, "full" = also tool outputs and reasoning. scope "turn" (default) = current turn, "all" = whole session.',
    {
      id,
      detail: z.enum(["final", "summary", "full"]).optional(),
      scope: z.enum(["turn", "all"]).optional(),
      max_chars: z.number().int().min(500).max(200_000).optional().describe("Default 20000; older content is cut first."),
    },
    async (a, fleet) => truncateHead(await fleet.transcript(a.id, { scope: a.scope ?? "turn", detail: a.detail ?? "summary" }), a.max_chars ?? 20_000),
    { readOnlyHint: true },
  )

  tool(
    "opencode_interrupt",
    'Stop or pause an agent. when "now" (default) aborts immediately, killing a running tool; "after_step" lets the current step (and its tool call) finish first. Context is kept: continue with opencode_resume or opencode_message. Pending messages are delivered on resume.',
    { id, when: z.enum(["now", "after_step"]).optional() },
    async (a, fleet) => renderSnapshot(await fleet.interrupt(a.id, a.when ?? "now")),
    { idempotentHint: true },
  )

  tool(
    "opencode_resume",
    "Resume an interrupted, failed or idle agent. Without a message it is told to continue (interrupted), retry (failed) or carry on (idle).",
    { id, message: z.string().optional(), wait: z.boolean().optional(), timeout_seconds: timeout.optional() },
    async (a, fleet, extra) => {
      const current = await fleet.snapshot(a.id)
      if (current.state === "running" || current.state === "needs_input") {
        throw new Error(`${current.name ?? current.id} is ${current.state}; use opencode_message to steer it or opencode_respond to answer it`)
      }
      const fallback =
        current.state === "interrupted"
          ? "You were interrupted. Continue the task from where you left off."
          : current.state === "error"
            ? `Your last turn failed (${current.error ?? "error"}). Retry and continue the task.`
            : "Continue."
      const snap = await fleet.message(a.id, a.message ?? fallback)
      if (a.wait) return waitAndRender(fleet, [snap.id], "all", a.timeout_seconds, extra, 8000)
      return `Resumed.\n${renderSnapshot(snap)}`
    },
  )

  tool(
    "opencode_respond",
    "Answer an agent in needs_input: approve or reject a permission request (per_…), or answer or dismiss a question (que_…).",
    {
      id,
      request_id: z.string(),
      decision: z
        .enum(["once", "always", "reject"])
        .optional()
        .describe(
          'Permissions: "once" (default) approves this call, "always" also matching future calls, "reject" denies. Questions: "reject" stops the agent\'s turn; omit answers to let it decide itself.',
        ),
      message: z.string().optional().describe("Feedback to the agent when rejecting a permission."),
      answers: z.array(z.array(z.string())).optional().describe("Question answers: per question, the selected option labels (or free text)."),
    },
    async (a, fleet) => renderSnapshot(await fleet.respond(a.id, a.request_id, { decision: a.decision, message: a.message, answers: a.answers })),
  )

  tool(
    "opencode_worktree",
    'Work with an isolated agent\'s git worktree: "diff" shows the agent\'s commits and changes, "commit" commits its leftover changes, "merge" replays the agent\'s own commits onto your checkout\'s current branch (carried-over changes excluded; aborted cleanly on conflicts; strategy "squash" stages them without committing).',
    {
      id,
      action: z.enum(["diff", "commit", "merge"]),
      strategy: z.enum(["merge", "squash"]).optional(),
      max_chars: z.number().int().min(500).max(200_000).optional(),
    },
    async (a, fleet) => fleet.worktree(a.id, a.action, { strategy: a.strategy, maxChars: a.max_chars }),
  )

  tool(
    "opencode_dispose",
    'Stop and forget an agent. worktree: "keep" (default; leftover changes are committed to its branch), "remove" (commit leftovers, remove the worktree, keep the branch if it has commits), "discard" (drop uncommitted changes). delete_session removes it from OpenCode history.',
    {
      id,
      worktree: z.enum(["keep", "remove", "discard"]).optional(),
      delete_session: z.boolean().optional(),
    },
    async (a, fleet) => fleet.dispose(a.id, { worktree: a.worktree, deleteSession: a.delete_session }),
    { destructiveHint: true },
  )

  server.registerTool(
    "opencode_server",
    {
      description:
        'The OpenCode server behind the agents: "info" shows its URL, version and the command to watch agents live in the OpenCode TUI; "stop" stops the server this MCP server manages (and every agent on it); the next call starts a fresh one.',
      inputSchema: { action: z.enum(["info", "stop"]) },
      annotations: { openWorldHint: false },
    },
    (async (a: { action: "info" | "stop" }) => {
      try {
        if (a.action === "stop") return ok(await ctx.stop())
        const b = await ctx.backend()
        const i = b.info
        // Never echo the password into the conversation: point at where it is.
        const attach = i.passwordFile
          ? `OPENCODE_SERVER_PASSWORD="$(cat ${i.passwordFile})" opencode attach ${i.url}`
          : i.password
            ? `opencode attach ${i.url}  (with your OPENCODE_SERVER_PASSWORD set)`
            : `opencode attach ${i.url}`
        return ok(
          [
            `${i.mode} server ${i.url} (opencode ${i.version}${i.pid ? `, pid ${i.pid}` : ""})`,
            `watch agents live: ${attach}`,
            i.mode === "shared" ? "The shared server outlives this MCP process, so running agents survive restarts." : "",
            ...i.warnings.map((w) => `⚠ ${w}`),
          ]
            .filter(Boolean)
            .join("\n"),
        )
      } catch (err) {
        return fail(err)
      }
    }) as never,
  )

  // Transcripts as resources, for clients that let the user @-mention them.
  server.registerResource(
    "agent-transcript",
    new ResourceTemplate("opencode://agents/{id}/transcript", {
      // Listing must never start a server: only list when one is already running.
      list: async () => {
        const fleet = await ctx.peekFleet()?.catch(() => undefined)
        if (!fleet) return { resources: [] }
        return { resources: fleet.ids().map((i) => ({ uri: `opencode://agents/${i}/transcript`, name: `transcript ${i}`, mimeType: "text/markdown" })) }
      },
    }),
    { description: "Full transcript of an OpenCode agent", mimeType: "text/markdown" },
    async (uri, vars) => {
      const fleet = await ctx.fleet()
      const text = await fleet.transcript(String(vars.id), { scope: "all", detail: "summary" })
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] }
    },
  )
}

export const INSTRUCTIONS = `opencode: delegate coding work to OpenCode agents running any model (DeepSeek, Kimi, GLM, Qwen, GPT, Claude, local, …), in parallel, like your own subagents.

1. Pick a model per task: opencode_models (provider/model + effort variants). opencode_agents lists profiles.
2. opencode_spawn with a self-contained prompt (shared context in instructions). It runs in the background. Use isolation "worktree" when several agents edit one repo.
3. opencode_wait returns the next agent with news (final answer, failure or a request for you). Call it again for the next one.
   Pass gate: true (or settings) to have the agent's work checked when it finishes (tests, typecheck, lint, diff audit). Failures go back to the agent; you hear "gate ✓ PASS" or the final failing verdict.
4. While they run: opencode_status to peek, opencode_message to steer or queue, opencode_interrupt to stop or pause, opencode_resume to continue.
5. needs_input = waiting on you: opencode_respond. Permission prompts go to the human by default.
6. Isolated agents: opencode_worktree diff/merge, then opencode_dispose.
If channel notifications are enabled, a <channel source="opencode"> message arrives whenever an agent settles; then you do not need to wait.`
