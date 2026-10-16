import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import type { Fleet, Snapshot } from "./fleet.js"
import { SETTLED, formatModel } from "./fleet.js"
import { truncate, truncateHead } from "./render.js"

type Extra = {
  signal: AbortSignal
  _meta?: { progressToken?: string | number }
  sendNotification: (n: { method: "notifications/progress"; params: Record<string, unknown> }) => Promise<void>
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] })
const fail = (err: unknown): CallToolResult => ({
  content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
})

const id = z.string().describe("Agent session id (ses_…) or the name given at spawn.")
const permissions = z
  .enum(["ask", "allow", "deny"])
  .describe(
    'How to handle the agent\'s permission requests (shell commands, edits outside the project, …). "ask" surfaces them as needs_input for you to answer with opencode_respond; "allow" approves each one automatically; "deny" rejects them automatically.',
  )
const timeout = z
  .number()
  .int()
  .min(1)
  .max(3600)
  .describe("How long to block, in seconds (default 300). On timeout you get the current status; the agents keep working.")
const files = z.array(z.string()).describe("File paths (relative to the agent's directory or absolute) to attach to the prompt.")

export function renderSnapshot(s: Snapshot, fleet: Fleet, resultChars = 0): string {
  const head = `◆ ${s.name ? `${s.name} (${s.id})` : s.id} — ${s.state.toUpperCase()}`
  const lines = [head, `  model: ${formatModel(s.model)} · agent: ${s.agent ?? "default"} · permissions: ${s.policy}`, `  dir: ${s.directory}`]
  if (s.title && !s.title.startsWith("New session")) lines.splice(1, 0, `  title: ${s.title}`)
  if (s.worktree) lines.push(`  worktree branch: ${s.worktree.branch} (base ${s.worktree.base.slice(0, 10)})`)
  if (s.activity) lines.push(`  doing: ${s.activity}`)
  if (s.error) lines.push(`  error: ${truncate(s.error, 400)}`)
  for (const p of s.permissions) {
    lines.push(`  needs permission ${p.id}: ${p.action} ${JSON.stringify(p.resources)} → opencode_respond decision once|always|reject`)
  }
  for (const q of s.questions) {
    q.questions.forEach((item, i) => {
      const opts = item.options.map((o) => o.label).join(" | ")
      lines.push(`  needs answer ${q.id}${q.questions.length > 1 ? ` #${i + 1}` : ""}: ${item.question}${opts ? ` [${opts}]` : ""}${item.multiple ? " (multi)" : ""}`)
    })
  }
  if (resultChars > 0 && SETTLED.has(s.state)) {
    const text = fleet.lastText(s)
    if (text) lines.push(`  result:\n${indent(truncateHead(text, resultChars))}`)
  }
  return lines.join("\n")
}

function indent(text: string) {
  return text
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n")
}

function progress(extra: Extra) {
  const token = extra._meta?.progressToken
  if (token === undefined) return undefined
  let n = 0
  return (snaps: Snapshot[], elapsed: number) => {
    const running = snaps.filter((s) => !SETTLED.has(s.state)).map((s) => s.name ?? s.id)
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: ++n, message: `${Math.round(elapsed / 1000)}s: waiting on ${running.join(", ")}` },
      })
      .catch(() => undefined)
  }
}

export function registerTools(server: McpServer, getFleet: () => Promise<Fleet>) {
  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    run: (args: z.infer<z.ZodObject<S>>, fleet: Fleet, extra: Extra) => Promise<string>,
    annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean } = {},
  ) => {
    server.registerTool(
      name,
      { description, inputSchema: shape, annotations: { openWorldHint: false, ...annotations } },
      (async (args: z.infer<z.ZodObject<S>>, extra: Extra) => {
        try {
          return ok(await run(args, await getFleet(), extra))
        } catch (err) {
          return fail(err)
        }
      }) as never,
    )
  }

  tool(
    "opencode_models",
    "List the models OpenCode can run (provider/model ids, reasoning variants a.k.a. effort levels, context size). Use the ids with opencode_spawn's model/variant.",
    {
      provider: z.string().optional().describe("Only this provider id (e.g. deepseek, anthropic, openrouter)."),
      query: z.string().optional().describe("Case-insensitive substring filter on the model id or name."),
      directory: z.string().optional().describe("Project directory whose opencode config to use."),
    },
    async (a, fleet) => {
      const q = a.query?.toLowerCase()
      const models = (await fleet.models(a.directory)).filter(
        (m) => m.enabled && (!a.provider || m.providerID === a.provider) && (!q || `${m.id} ${m.name}`.toLowerCase().includes(q)),
      )
      if (!models.length) return "No matching models. Configure providers in opencode (opencode auth login / opencode.json)."
      const lines = models.map((m) => {
        const variants = m.variants.map((v) => v.id)
        return `${m.providerID}/${m.id} — ${m.name} · ctx ${Math.round(m.limit.context / 1000)}k${variants.length ? ` · variants: ${variants.join(", ")}` : ""}`
      })
      return `${models.length} model(s):\n${lines.slice(0, 300).join("\n")}${lines.length > 300 ? "\n… (narrow with provider/query)" : ""}`
    },
    { readOnlyHint: true },
  )

  tool(
    "opencode_agents",
    'List OpenCode agent profiles (e.g. "build" can edit and run commands, "plan" is read-only, plus custom agents from the project config).',
    { directory: z.string().optional().describe("Project directory whose opencode config to use.") },
    async (a, fleet) => {
      const agents = (await fleet.agents(a.directory)).filter((x) => !x.hidden)
      return agents
        .map((x) => `${x.id} (${x.mode})${x.model ? ` · ${formatModel(x.model)}` : ""}${x.description ? ` — ${truncate(x.description, 200)}` : ""}`)
        .join("\n")
    },
    { readOnlyHint: true },
  )

  tool(
    "opencode_spawn",
    "Start a new OpenCode agent on a task and return immediately (default) or wait for it. Spawn several to work in parallel, then use opencode_wait. The prompt must be self-contained: the agent does not see your conversation.",
    {
      prompt: z.string().min(1).describe("The full task description."),
      name: z.string().optional().describe("Short unique name to address the agent by (e.g. 'tests', 'refactor-auth')."),
      model: z.string().optional().describe('"provider/model", e.g. "deepseek/deepseek-chat". Defaults to HORDE_OPENCODE_MODEL or opencode\'s default.'),
      variant: z.string().optional().describe('Reasoning effort / model variant, e.g. "low", "high", "max" (see opencode_models).'),
      agent: z.string().optional().describe('OpenCode agent profile, e.g. "build" (default) or "plan" (read-only).'),
      directory: z.string().optional().describe("Working directory (absolute). Defaults to the server's directory."),
      isolation: z
        .enum(["none", "worktree"])
        .optional()
        .describe('"worktree" runs the agent in its own git worktree + branch (horde/<name>) so parallel agents never clobber each other.'),
      permissions: permissions.optional(),
      files: files.optional(),
      wait: z.boolean().optional().describe("Block until the agent settles (finished, needs input, or failed). Default false."),
      timeout_seconds: timeout.optional(),
    },
    async (a, fleet, extra) => {
      let snap = await fleet.spawn({
        prompt: a.prompt,
        name: a.name,
        model: a.model,
        variant: a.variant,
        agent: a.agent,
        directory: a.directory,
        isolation: a.isolation,
        permissions: a.permissions,
        files: a.files,
      })
      if (a.wait) {
        const r = await fleet.waitFor([snap.id], "all", (a.timeout_seconds ?? 300) * 1000, { signal: extra.signal, onTick: progress(extra) })
        snap = r.snapshots[0]!
        return `${r.timedOut ? "Still running after timeout.\n" : ""}${renderSnapshot(snap, fleet, 8000)}`
      }
      return `Spawned.\n${renderSnapshot(snap, fleet)}\nUse opencode_wait to block until it settles, opencode_status to peek.`
    },
  )

  tool(
    "opencode_message",
    'Send a message to an agent. delivery "steer" (default) injects it at the agent\'s next step even mid-turn — use it to correct course; "queue" delivers it after the current turn finishes. An idle/interrupted agent starts working again. Can also switch model, variant, agent profile or permission policy first.',
    {
      id,
      message: z.string().min(1),
      delivery: z.enum(["steer", "queue"]).optional(),
      model: z.string().optional().describe('Switch to "provider/model" before this message.'),
      variant: z.string().optional().describe("Switch reasoning effort / variant before this message."),
      agent: z.string().optional().describe("Switch agent profile before this message."),
      permissions: permissions.optional(),
      files: files.optional(),
      wait: z.boolean().optional().describe("Block until the agent settles. Default false."),
      timeout_seconds: timeout.optional(),
    },
    async (a, fleet, extra) => {
      if (a.permissions) fleet.setPolicy(a.id, a.permissions)
      let snap = await fleet.message(a.id, a.message, { delivery: a.delivery, model: a.model, variant: a.variant, agent: a.agent, files: a.files })
      if (a.wait) {
        const r = await fleet.waitFor([snap.id], "all", (a.timeout_seconds ?? 300) * 1000, { signal: extra.signal, onTick: progress(extra) })
        snap = r.snapshots[0]!
        return `${r.timedOut ? "Still running after timeout.\n" : ""}${renderSnapshot(snap, fleet, 8000)}`
      }
      return `Delivered (${a.delivery ?? "steer"}).\n${renderSnapshot(snap, fleet)}`
    },
  )

  tool(
    "opencode_wait",
    'Block until agents settle (idle, needs_input, interrupted or error) and return their status plus final answers. mode "any" (default) returns when the first one settles — pass only the agents you are still waiting on; "all" waits for every one.',
    {
      ids: z.array(z.string()).optional().describe("Agents to wait on. Defaults to every tracked agent that is currently running."),
      mode: z.enum(["any", "all"]).optional(),
      timeout_seconds: timeout.optional(),
      result_chars: z.number().int().min(0).max(100_000).optional().describe("Max chars of each settled agent's final answer to include (default 6000)."),
    },
    async (a, fleet, extra) => {
      let ids = a.ids
      if (!ids?.length) {
        const all = await fleet.list({})
        ids = all.filter((s) => !SETTLED.has(s.state)).map((s) => s.id)
        if (!ids.length) return "No running agents to wait on.\n\n" + all.map((s) => renderSnapshot(s, fleet)).join("\n\n")
      }
      const r = await fleet.waitFor(ids, a.mode ?? "any", (a.timeout_seconds ?? 300) * 1000, { signal: extra.signal, onTick: progress(extra) })
      const chars = a.result_chars ?? 6000
      const settled = r.snapshots.filter((s) => SETTLED.has(s.state))
      const running = r.snapshots.filter((s) => !SETTLED.has(s.state))
      const parts = [r.timedOut ? `Timed out; ${running.length} still running.` : `${settled.length} settled, ${running.length} still running.`]
      for (const s of [...settled, ...running]) parts.push(renderSnapshot(s, fleet, chars))
      return parts.join("\n\n")
    },
    { readOnlyHint: true },
  )

  tool(
    "opencode_status",
    "Peek at agents without blocking: state, current activity, pending permission requests/questions. With no ids, lists every agent this server is tracking.",
    {
      ids: z.array(z.string()).optional(),
      include_untracked: z.boolean().optional().describe("Also list recent OpenCode sessions in `directory` that this server did not spawn (e.g. from before a restart) so you can adopt them by id."),
      directory: z.string().optional(),
    },
    async (a, fleet) => {
      const snaps = a.ids?.length
        ? await Promise.all(a.ids.map((i) => fleet.snapshot(i)))
        : await fleet.list({ includeUntracked: a.include_untracked, directory: a.directory })
      if (!snaps.length) return "No agents yet. Start one with opencode_spawn."
      return snaps.map((s) => renderSnapshot(s, fleet, 600)).join("\n\n")
    },
    { readOnlyHint: true },
  )

  tool(
    "opencode_output",
    'Read what an agent did. detail "final" = last answer only, "summary" (default) = messages plus one line per tool call, "full" = also tool outputs and reasoning. scope "turn" (default) = since the latest prompt, "all" = whole session.',
    {
      id,
      detail: z.enum(["final", "summary", "full"]).optional(),
      scope: z.enum(["turn", "all"]).optional(),
      max_chars: z.number().int().min(500).max(200_000).optional().describe("Default 20000; older content is cut first."),
    },
    async (a, fleet) => {
      const text = await fleet.transcript(a.id, { scope: a.scope ?? "turn", detail: a.detail ?? "summary" })
      return truncateHead(text, a.max_chars ?? 20_000)
    },
    { readOnlyHint: true },
  )

  tool(
    "opencode_interrupt",
    "Stop an agent's current turn (pause). Its context is kept; continue later with opencode_resume or opencode_message. Messages that were not picked up yet stay pending and are delivered on resume.",
    { id },
    async (a, fleet) => renderSnapshot(await fleet.interrupt(a.id), fleet),
    { destructiveHint: false, idempotentHint: true },
  )

  tool(
    "opencode_resume",
    "Resume an interrupted, failed or idle agent. Without a message it is told to continue where it left off.",
    {
      id,
      message: z.string().optional(),
      wait: z.boolean().optional(),
      timeout_seconds: timeout.optional(),
    },
    async (a, fleet, extra) => {
      let snap = await fleet.resume(a.id, a.message)
      if (a.wait) {
        const r = await fleet.waitFor([snap.id], "all", (a.timeout_seconds ?? 300) * 1000, { signal: extra.signal, onTick: progress(extra) })
        snap = r.snapshots[0]!
        return renderSnapshot(snap, fleet, 8000)
      }
      return `Resumed.\n${renderSnapshot(snap, fleet)}`
    },
  )

  tool(
    "opencode_respond",
    "Answer an agent that is in needs_input: approve/reject a permission request, or answer/reject a question.",
    {
      id,
      request_id: z.string().describe("The per_… or que_… id shown by opencode_status / opencode_wait."),
      decision: z
        .enum(["once", "always", "reject"])
        .optional()
        .describe('Permissions: "once" (default) approves this call, "always" also approves matching future calls, "reject" denies. Questions: "reject" dismisses.'),
      message: z.string().optional().describe("Feedback to the agent when rejecting a permission."),
      answers: z
        .array(z.array(z.string()))
        .optional()
        .describe("Question answers: one array of selected option labels (or free text) per question, in order."),
    },
    async (a, fleet) =>
      renderSnapshot(await fleet.respond(a.id, a.request_id, { decision: a.decision, message: a.message, answers: a.answers }), fleet),
  )

  tool(
    "opencode_dispose",
    "Stop and forget an agent. Optionally remove its git worktree (kept if it has uncommitted changes unless force). The session stays in OpenCode history.",
    {
      id,
      remove_worktree: z.boolean().optional(),
      force: z.boolean().optional().describe("Discard uncommitted worktree changes."),
    },
    async (a, fleet) => fleet.dispose(a.id, { removeWorktree: a.remove_worktree, force: a.force }),
    { destructiveHint: true },
  )
}

export const INSTRUCTIONS = `Delegate coding work to OpenCode agents running any model OpenCode supports (DeepSeek, Kimi, GLM, Qwen, GPT, Claude, local models, …).

Typical flow:
1. opencode_models to pick a "provider/model" (and a variant for reasoning effort) if you need a specific one.
2. opencode_spawn one or more agents with self-contained prompts. They run in parallel in the background. Use isolation "worktree" when several agents edit the same repo.
3. opencode_wait (mode "any") to block until the next one settles; it returns each settled agent's final answer.
4. While they run: opencode_status to peek, opencode_message to steer, opencode_interrupt to pause, opencode_resume to continue.
5. Agents in state needs_input are blocked on a permission request or a question: answer with opencode_respond.
6. opencode_output for the detailed transcript, opencode_dispose when done.

Agents are OpenCode sessions; their ids (ses_…) stay valid across restarts and can be watched live with \`opencode attach <url>\`.`
