/**
 * The pure parts of a workflow script (`workflow.ts`): the leading
 * `export const meta = { … }` block, and structured output (`agent(prompt,
 * { schema })`): the JSON Schema checks, the answer parse and the prompts
 * that ask a child for JSON.
 *
 * The meta block is read as a pure literal, as Claude Code reads it: strings,
 * numbers, booleans, null, arrays and objects, with comments and trailing
 * commas. A variable, a call, a spread or a `${}` template refuses the script
 * before any agent starts.
 *
 * The validator covers the JSON Schema keywords a workflow uses: `type`
 * (one name or a list), `properties`, `required`, `additionalProperties`
 * (false or a schema), `items`, `enum`, `const`, `minItems`, `maxItems`,
 * `minLength`, `maxLength`, `minimum` and `maximum`. Any other keyword is not
 * checked.
 */

export interface WorkflowMetaPhase {
  title: string
  detail?: string
}

export interface WorkflowMeta {
  name?: string
  description?: string
  phases?: WorkflowMetaPhase[]
}

const META_START = /^export\s+const\s+meta\s*=\s*/

/** Skip whitespace and comments from `pos`. */
function skipBlank(source: string, pos: number): number {
  for (;;) {
    while (pos < source.length && /\s/.test(source[pos]!)) pos++
    if (source.startsWith('//', pos)) {
      const end = source.indexOf('\n', pos)
      pos = end < 0 ? source.length : end + 1
      continue
    }
    if (source.startsWith('/*', pos)) {
      const end = source.indexOf('*/', pos + 2)
      if (end < 0) throw new Error('a comment is not closed')
      pos = end + 2
      continue
    }
    return pos
  }
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' }

/** One JavaScript literal value at `pos`: `{ value, end }`. Throws on anything that is not a literal. */
function literal(source: string, pos: number): { value: unknown; end: number } {
  pos = skipBlank(source, pos)
  const ch = source[pos]
  if (ch === undefined) throw new Error('the meta object ends early')
  if (ch === '{') {
    const value: Record<string, unknown> = {}
    pos = skipBlank(source, pos + 1)
    while (source[pos] !== '}') {
      let key: string
      const k = source[pos]
      if (k === '"' || k === "'" || k === '`') {
        const parsed = literal(source, pos)
        key = String(parsed.value)
        pos = parsed.end
      } else {
        const match = /^[A-Za-z_$][\w$]*|^\d+/.exec(source.slice(pos))
        if (!match) throw new Error(`unexpected "${source.slice(pos, pos + 12)}" where a key belongs (a spread or a computed key is not a literal)`)
        key = match[0]
        pos += key.length
      }
      pos = skipBlank(source, pos)
      if (source[pos] !== ':') throw new Error(`the key "${key}" has no value (a shorthand property is not a literal)`)
      const parsed = literal(source, pos + 1)
      value[key] = parsed.value
      pos = skipBlank(source, parsed.end)
      if (source[pos] === ',') pos = skipBlank(source, pos + 1)
      else if (source[pos] !== '}') throw new Error(`expected "," or "}" after the value of "${key}"`)
    }
    return { value, end: pos + 1 }
  }
  if (ch === '[') {
    const value: unknown[] = []
    pos = skipBlank(source, pos + 1)
    while (source[pos] !== ']') {
      const parsed = literal(source, pos)
      value.push(parsed.value)
      pos = skipBlank(source, parsed.end)
      if (source[pos] === ',') pos = skipBlank(source, pos + 1)
      else if (source[pos] !== ']') throw new Error('expected "," or "]" in an array')
    }
    return { value, end: pos + 1 }
  }
  if (ch === '"' || ch === "'" || ch === '`') {
    let text = ''
    let i = pos + 1
    for (;;) {
      const c = source[i]
      if (c === undefined) throw new Error('a string is not closed')
      if (c === ch) return { value: text, end: i + 1 }
      if (ch === '`' && c === '$' && source[i + 1] === '{') throw new Error('a template with ${…} is not a literal')
      if (c === '\n' && ch !== '`') throw new Error('a string breaks the line')
      if (c === '\\') {
        const e = source[i + 1] ?? ''
        if (e === 'u') {
          text += String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16))
          i += 6
          continue
        }
        text += ESCAPES[e] ?? (e === '\n' ? '' : e)
        i += 2
        continue
      }
      text += c
      i++
    }
  }
  const word = /^(?:true|false|null|-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(?![\w$])/.exec(source.slice(pos))
  if (word) {
    const token = word[0]
    return { value: token === 'true' ? true : token === 'false' ? false : token === 'null' ? null : Number(token), end: pos + token.length }
  }
  throw new Error(`"${source.slice(pos, pos + 20).split('\n')[0]}" is not a literal value (a variable or a call is not allowed in meta)`)
}

/**
 * Split a script into its leading `export const meta = { … }` and the body
 * that runs. No meta block: `meta` is null and the body is the script. A meta
 * block that is not a pure literal, or not a plain object, throws.
 */
export function splitMeta(script: string): { meta: WorkflowMeta | null; body: string } {
  const start = skipBlank(script, 0)
  const head = META_START.exec(script.slice(start))
  if (!head) return { meta: null, body: script }
  let parsed: { value: unknown; end: number }
  try {
    parsed = literal(script, start + head[0].length)
  } catch (err) {
    throw new Error(`The script's \`export const meta\` must be a plain object literal: ${err instanceof Error ? err.message : String(err)}.`)
  }
  if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    throw new Error('The script\'s `export const meta` must be a plain object literal.')
  }
  let end = skipBlank(script, parsed.end)
  if (script[end] === ';') end++
  return { meta: metaShape(parsed.value as Record<string, unknown>), body: script.slice(end) }
}

function metaShape(raw: Record<string, unknown>): WorkflowMeta {
  const meta: WorkflowMeta = {}
  if (typeof raw.name === 'string' && raw.name.trim()) meta.name = raw.name.trim()
  if (typeof raw.description === 'string' && raw.description.trim()) meta.description = raw.description.trim()
  if (raw.phases !== undefined) {
    if (!Array.isArray(raw.phases)) throw new Error('`meta.phases` must be an array of { title, detail? }.')
    meta.phases = raw.phases.map((phase, index) => {
      const title = phase && typeof phase === 'object' ? (phase as Record<string, unknown>).title : phase
      if (typeof title !== 'string' || !title.trim()) throw new Error(`\`meta.phases[${index}]\` needs a \`title\` string.`)
      const detail = phase && typeof phase === 'object' ? (phase as Record<string, unknown>).detail : undefined
      return { title: title.trim(), ...(typeof detail === 'string' && detail.trim() ? { detail: detail.trim() } : {}) }
    })
  }
  return meta
}

// ── structured output ─────────────────────────────────────────────────────

type Schema = Record<string, unknown>

const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'])

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function hasType(value: unknown, type: string): boolean {
  const actual = typeOf(value)
  return actual === type || (type === 'number' && actual === 'integer')
}

function types(schema: Schema): string[] | null {
  const raw = schema.type
  if (raw === undefined) return null
  return (Array.isArray(raw) ? raw : [raw]).filter((type): type is string => typeof type === 'string')
}

const isSchema = (value: unknown): value is Schema => !!value && typeof value === 'object' && !Array.isArray(value)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Why `schema` can never be met, or null. Proves the cases Claude Code
 * refuses before the child starts: a `required` key that `additionalProperties:
 * false` rules out (it is not in `properties`), an empty `enum`, an `enum`
 * with no value of the schema's `type`, an unknown `type` name, and
 * `minItems` above `maxItems`. Walks `properties`, `items` and an
 * `additionalProperties` schema.
 */
export function schemaContradiction(schema: unknown, path = '$'): string | null {
  if (!isSchema(schema)) return `${path}: a schema must be a JSON Schema object`
  const declared = types(schema)
  const unknown = declared?.find((type) => !TYPES.has(type))
  if (unknown) return `${path}: "${unknown}" is not a JSON Schema type`
  if (Array.isArray(schema.enum)) {
    if (schema.enum.length === 0) return `${path}: \`enum\` is empty, so no value can match`
    if (declared && !schema.enum.some((value) => declared.some((type) => hasType(value, type)))) {
      return `${path}: no \`enum\` value has the type ${declared.join(' or ')}`
    }
  }
  if (typeof schema.minItems === 'number' && typeof schema.maxItems === 'number' && schema.minItems > schema.maxItems) {
    return `${path}: \`minItems\` ${schema.minItems} is above \`maxItems\` ${schema.maxItems}`
  }
  const properties = isSchema(schema.properties) ? schema.properties : {}
  if (schema.additionalProperties === false && Array.isArray(schema.required)) {
    const ruledOut = schema.required.find((key) => typeof key === 'string' && !Object.hasOwn(properties, key))
    if (ruledOut !== undefined) return `${path}: the required key "${ruledOut}" is not in \`properties\`, and \`additionalProperties: false\` rules it out`
  }
  for (const [key, child] of Object.entries(properties)) {
    const found = schemaContradiction(child, `${path}.${key}`)
    if (found) return found
  }
  if (schema.items !== undefined) {
    const found = schemaContradiction(schema.items, `${path}[]`)
    if (found) return found
  }
  if (isSchema(schema.additionalProperties)) return schemaContradiction(schema.additionalProperties, `${path}.*`)
  return null
}

/** Every way `value` breaks `schema`, at most 10, each as `<path>: <problem>`. Empty: it matches. */
export function validateJson(value: unknown, schema: unknown, path = '$', errors: string[] = []): string[] {
  if (errors.length >= 10 || !isSchema(schema)) return errors
  const declared = types(schema)
  if (declared && !declared.some((type) => hasType(value, type))) {
    errors.push(`${path}: expected ${declared.join(' or ')}, got ${typeOf(value)}`)
    return errors
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => same(option, value))) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`)
  }
  if (schema.const !== undefined && !same(schema.const, value)) errors.push(`${path}: must be ${JSON.stringify(schema.const)}`)
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength} characters`)
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength} characters`)
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path}: below the minimum ${schema.minimum}`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path}: above the maximum ${schema.maximum}`)
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`)
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`)
    if (schema.items !== undefined) value.forEach((item, index) => validateJson(item, schema.items, `${path}[${index}]`, errors))
  }
  if (isSchema(value)) {
    const properties = isSchema(schema.properties) ? schema.properties : {}
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof key === 'string' && !Object.hasOwn(value, key)) errors.push(`${path}: the required key "${key}" is missing`)
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) validateJson(child, properties[key], `${path}.${key}`, errors)
      else if (schema.additionalProperties === false) errors.push(`${path}: the key "${key}" is not allowed`)
      else if (isSchema(schema.additionalProperties)) validateJson(child, schema.additionalProperties, `${path}.${key}`, errors)
    }
  }
  return errors.slice(0, 10)
}

/**
 * The JSON value in a child's answer: the whole text, else the body of a
 * ```json (or bare ```) fence, else the text from the first `{` or `[` to the
 * last `}` or `]`.
 */
export function parseJsonAnswer(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim()
  const candidates = [trimmed]
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(trimmed)
  if (fence?.[1]) candidates.push(fence[1].trim())
  const open = trimmed.search(/[{[]/)
  const close = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'))
  if (open >= 0 && close > open) candidates.push(trimmed.slice(open, close + 1))
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) }
    } catch {
      // the next candidate
    }
  }
  return { ok: false, error: trimmed ? 'the answer is not valid JSON' : 'the answer is empty' }
}

/** The text appended to a structured agent's prompt. */
export function schemaInstruction(schema: unknown): string {
  return [
    '',
    '---',
    'Answer format: your final message must be ONLY one JSON value that matches this JSON Schema. No other words, no Markdown fence.',
    '```json',
    JSON.stringify(schema, null, 2),
    '```',
  ].join('\n')
}

/** The follow-up a structured agent gets when its answer did not validate. */
export function schemaCorrection(problem: string, schema: unknown): string {
  return [
    `Your last answer does not match the required JSON Schema: ${problem}.`,
    'Answer again with ONLY one JSON value that matches this schema. No other words, no Markdown fence.',
    '```json',
    JSON.stringify(schema, null, 2),
    '```',
  ].join('\n')
}
