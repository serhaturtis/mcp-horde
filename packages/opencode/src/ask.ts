/**
 * One-shot answers for `opencode_ask`: a tool-less agent profile, and JSON replies checked
 * against a JSON Schema (the common subset: type, properties, required, items, enum,
 * additionalProperties, minItems/maxItems, minimum/maximum, minLength/maxLength).
 */

/**
 * The agent profile ask sessions run with: no tools. It has no prompt of its own, so
 * OpenCode's system prompt stays (OpenCode's free tier refuses sessions without it); the
 * instruction to answer directly travels with the user's prompt instead.
 */
export const ASK_AGENT = "horde-ask"
export const ASK_PROFILE = `---
description: mcp-horde one-shot answers (no tools)
mode: primary
tools:
  "*": false
---
`
export const ASK_PREAMBLE =
  "Answer the request below directly from what it contains. You have no tools in this session: do not try to read files, run commands or search. If something you need is missing, say exactly what.\n\n"

export type JsonSchema = {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  additionalProperties?: boolean | JsonSchema
  minItems?: number
  maxItems?: number
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  description?: string
}

const typeOf = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v

/** Problems with `value` against `schema`, as `path: problem` lines (empty when it conforms). */
export function validate(value: unknown, schema: JsonSchema, at = "$"): string[] {
  const errors: string[] = []
  const t = typeOf(value)
  if (schema.type) {
    const want = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!want.some((w) => w === t || (w === "number" && t === "integer"))) return [`${at}: expected ${want.join(" or ")}, got ${t}`]
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errors.push(`${at}: must be one of ${JSON.stringify(schema.enum)}`)
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: must be at least ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: must be at most ${schema.maximum}`)
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: must have at least ${schema.minLength} characters`)
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: must have at most ${schema.maxLength} characters`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: needs at least ${schema.minItems} items`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: allows at most ${schema.maxItems} items`)
    if (schema.items) for (const [i, v] of value.entries()) errors.push(...validate(v, schema.items, `${at}[${i}]`))
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>
    for (const k of schema.required ?? []) if (!(k in obj)) errors.push(`${at}.${k}: required`)
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties?.[k]
      if (sub) errors.push(...validate(v, sub, `${at}.${k}`))
      else if (schema.additionalProperties === false) errors.push(`${at}.${k}: not allowed`)
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object")
        errors.push(...validate(v, schema.additionalProperties, `${at}.${k}`))
    }
  }
  return errors
}

/** The JSON value in a model's reply: the whole reply, a fenced block, or the outermost object/array in it. */
export function extractJson(text: string): { value?: unknown; error?: string } {
  const candidates = [text.trim()]
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text)
  if (fenced) candidates.push(fenced[1]!.trim())
  const start = text.search(/[[{]/)
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"))
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1))
  for (const c of candidates) {
    try {
      return { value: JSON.parse(c) }
    } catch {
      // try the next form
    }
  }
  return { error: "the reply is not JSON" }
}

export function schemaPrompt(prompt: string, schema: JsonSchema): string {
  return `${prompt}\n\nAnswer with JSON only (no prose, no code fences), matching this JSON Schema:\n${JSON.stringify(schema)}`
}

export function retryPrompt(errors: string[]): string {
  return `That answer was not valid:\n${errors.map((e) => `- ${e}`).join("\n")}\nAnswer again with JSON only, matching the schema.`
}
