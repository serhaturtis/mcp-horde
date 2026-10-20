// The horde's rule for when to delegate, added to every session's and subagent's context.
// Tool descriptions and server instructions inform an agent; its own context is what it acts
// on (a session given the tools upfront still did the work itself, at many times the cost).
const event = process.argv[2] === "SubagentStart" ? "SubagentStart" : "SessionStart"
const rule = [
  "HORDE: for any self-contained code change you would otherwise write yourself (a fix, a feature slice, tests, a refactor, docs), start it with horde_do and keep going.",
  "It is the short path: one call, a fraction of your tokens, and the work comes back tested and reviewed (horde_wait), then lands without breaking the branch (horde_land).",
  "Do it directly only for a one-line edit, a result you need right now to keep reasoning, or a change you cannot describe in a paragraph.",
  ...(event === "SubagentStart"
    ? ["As a subagent too: a worker is a cheaper model running one piece of your assignment, not another Claude agent; hand it the pieces, keep the judgement."]
    : []),
].join(" ")
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: rule } }))
