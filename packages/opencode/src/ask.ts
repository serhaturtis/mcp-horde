/**
 * One-shot answers for `opencode_ask`: sessions that may use no tools, and JSON replies checked
 * against a JSON Schema (the common subset: type, properties, required, items, enum, const,
 * anyOf/oneOf/allOf, additionalProperties, minItems/maxItems, minimum/maximum,
 * exclusiveMinimum/exclusiveMaximum, minLength/maxLength, pattern, min/maxProperties).
 * Schemas using anything else are rejected up front (`unsupportedSchema`), never half-checked.
 */

import type { Profile } from "./fleet.js"

/**
 * The permissions ask sessions run with: every tool denied. OpenCode's system prompt stays
 * (its free tier refuses sessions without it); the instruction to answer directly travels
 * with the user's prompt instead.
 */
export const ASK_PROFILE: Profile = { permission: { "*": "deny" } }

/**
 * OpenCode's free tier refuses sessions that offer no tools at all ("can only be used from
 * within OpenCode"). This keeps the read-only tools (read, grep, glob) and denies everything
 * else (the last matching rule wins, so the catch-all comes first). Ask sessions also run with
 * the "deny" policy, so nothing that asks for permission is ever allowed.
 */
export const ASK_GUARDED_PROFILE: Profile = { permission: { "*": "deny", read: "allow", grep: "allow", glob: "allow" } }
export const ASK_PREAMBLE =
  "Answer the request below directly from what it contains. Do not use tools in this session: do not try to edit files, run commands or search the web. If something you need is missing, say exactly what.\n\n"

export type JsonSchema = {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  const?: unknown
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  allOf?: JsonSchema[]
  additionalProperties?: boolean | JsonSchema
  minItems?: number
  maxItems?: number
  minProperties?: number
  maxProperties?: number
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  description?: string
}

/** Keywords that only describe (they never change what conforms). */
const ANNOTATIONS = new Set(["title", "description", "default", "examples", "$schema", "$id", "$comment", "deprecated", "readOnly", "writeOnly", "format"])
const NUMBER_KEYWORDS = [
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
]
const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"])

/**
 * Problems that keep `schema` from being checked faithfully: keywords outside the supported
 * subset ($ref, not, if/then/else, tuple items, patternProperties, …) or malformed values.
 * Empty when the schema is usable.
 */
export function unsupportedSchema(schema: unknown, at = "$"): string[] {
  if (typeof schema === "boolean") return [`${at}: boolean schemas are not supported; use {} or a typed schema`]
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [`${at}: a schema must be an object`]
  const errors: string[] = []
  const sub = (v: unknown, path: string) => errors.push(...unsupportedSchema(v, path))
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (ANNOTATIONS.has(k) || k.startsWith("x-")) continue
    switch (k) {
      case "type": {
        const list = Array.isArray(v) ? v : [v]
        if (!list.length || list.some((t) => typeof t !== "string" || !TYPES.has(t)))
          errors.push(`${at}.type: must be one of ${[...TYPES].join(", ")} (or a list of them)`)
        break
      }
      case "properties":
        if (!v || typeof v !== "object" || Array.isArray(v)) errors.push(`${at}.properties: must be an object of schemas`)
        else for (const [name, p] of Object.entries(v)) sub(p, `${at}.properties.${name}`)
        break
      case "required":
        if (!Array.isArray(v) || v.some((r) => typeof r !== "string")) errors.push(`${at}.required: must be a list of property names`)
        break
      case "items":
        if (Array.isArray(v)) errors.push(`${at}.items: tuple schemas (a list of item schemas) are not supported; use one schema for every item`)
        else sub(v, `${at}.items`)
        break
      case "enum":
        if (!Array.isArray(v) || !v.length) errors.push(`${at}.enum: must be a non-empty list`)
        break
      case "const":
        break
      case "anyOf":
      case "oneOf":
      case "allOf":
        if (!Array.isArray(v) || !v.length) errors.push(`${at}.${k}: must be a non-empty list of schemas`)
        else for (const [i, x] of v.entries()) sub(x, `${at}.${k}[${i}]`)
        break
      case "additionalProperties":
        if (typeof v !== "boolean") sub(v, `${at}.additionalProperties`)
        break
      case "pattern":
        if (typeof v !== "string") errors.push(`${at}.pattern: must be a string`)
        else
          try {
            new RegExp(v, "u")
          } catch (err) {
            errors.push(`${at}.pattern: not a valid regular expression (${(err as Error).message})`)
          }
        break
      default:
        if (NUMBER_KEYWORDS.includes(k)) {
          if (typeof v !== "number" || !Number.isFinite(v)) errors.push(`${at}.${k}: must be a number`)
        } else
          errors.push(
            `${at}.${k}: "${k}" is not supported (supported: type, properties, required, items, enum, const, anyOf, oneOf, allOf, additionalProperties, pattern, ${NUMBER_KEYWORDS.join(", ")})`,
          )
    }
  }
  return errors
}

const typeOf = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Problems with `value` against `schema`, as `path: problem` lines (empty when it conforms). */
export function validate(value: unknown, schema: JsonSchema, at = "$"): string[] {
  const errors: string[] = []
  const t = typeOf(value)
  if (schema.type) {
    const want = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!want.some((w) => w === t || (w === "number" && t === "integer"))) return [`${at}: expected ${want.join(" or ")}, got ${t}`]
  }
  if (schema.enum && !schema.enum.some((e) => same(e, value))) errors.push(`${at}: must be one of ${JSON.stringify(schema.enum)}`)
  if ("const" in schema && !same(schema.const, value)) errors.push(`${at}: must be ${JSON.stringify(schema.const)}`)
  if (schema.allOf) for (const s of schema.allOf) errors.push(...validate(value, s, at))
  if (schema.anyOf) {
    const results = schema.anyOf.map((s) => validate(value, s, at))
    if (!results.some((r) => !r.length)) errors.push(`${at}: must match at least one of the anyOf schemas (${results.map((r) => r[0]).join("; ")})`)
  }
  if (schema.oneOf) {
    const results = schema.oneOf.map((s) => validate(value, s, at))
    const matches = results.filter((r) => !r.length).length
    if (matches === 0) errors.push(`${at}: must match exactly one of the oneOf schemas (${results.map((r) => r[0]).join("; ")})`)
    else if (matches > 1) errors.push(`${at}: matches ${matches} of the oneOf schemas; it must match exactly one`)
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: must be at least ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: must be at most ${schema.maximum}`)
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${at}: must be greater than ${schema.exclusiveMinimum}`)
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) errors.push(`${at}: must be less than ${schema.exclusiveMaximum}`)
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: must have at least ${schema.minLength} characters`)
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: must have at most ${schema.maxLength} characters`)
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${at}: must match /${schema.pattern}/`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: needs at least ${schema.minItems} items`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: allows at most ${schema.maxItems} items`)
    if (schema.items) for (const [i, v] of value.entries()) errors.push(...validate(v, schema.items, `${at}[${i}]`))
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>
    const count = Object.keys(obj).length
    if (schema.minProperties !== undefined && count < schema.minProperties) errors.push(`${at}: needs at least ${schema.minProperties} properties`)
    if (schema.maxProperties !== undefined && count > schema.maxProperties) errors.push(`${at}: allows at most ${schema.maxProperties} properties`)
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
