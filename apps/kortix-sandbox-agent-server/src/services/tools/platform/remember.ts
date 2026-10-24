/**
 * remember: the platform tool an agent saves memory with (`project_channels`).
 * It loads in every channel or DM thread (`KORTIX_SPACE_ID`), whatever the
 * project's kortix.yaml `tools` lists, and `kortix tools eject` does not
 * offer it: it lives here, not in `kortix/`.
 *
 * A call posts to the API (`POST /v1/projects/:projectId/memory/remember`,
 * session token). The API picks the layer, merges into the page of that
 * title or creates it, checks size and secrets, and records the source. On
 * success the tool refreshes that layer's read-only copy at once, so the
 * agent reads its own write, and returns the API's result (the UI renders
 * it). A refusal is returned as `Error: <code>: <message>` for the model.
 * Outside content (`outside`, or a new link in the text) is saved
 * `unconfirmed` and stays out of the copy until a person confirms it.
 */
import { syncMemoryCopy, type MemoryCopyDir } from '../memory-copy'
import type { ToolContext } from '../tool'

const TIMEOUT_MS = 30_000
const TYPES = ['people', 'decisions', 'workstreams', 'playbooks'] as const
const LAYERS = ['channel', 'company', 'dm'] as const
/** A layer scope → its copy folder. */
const COPY_DIRS: Record<string, MemoryCopyDir> = { company: 'company', channel: 'channel', dm: 'personal' }

/** The request body, or why the arguments are not one. */
function rememberInput(args: Record<string, any>): Record<string, unknown> | string {
  const text = (key: string) => (typeof args[key] === 'string' && args[key].trim() ? (args[key] as string).trim() : undefined)
  for (const key of ['title', 'summary', 'fact', 'body', 'section', 'from_note_id']) {
    if (args[key] !== undefined && args[key] !== null && typeof args[key] !== 'string') return `${key} must be a string`
  }
  if (!text('title')) return 'title is required'
  if (!(TYPES as readonly unknown[]).includes(args.type)) return `type must be one of ${TYPES.join(', ')}`
  if (args.layer !== undefined && args.layer !== null && !(LAYERS as readonly unknown[]).includes(args.layer)) return `layer must be one of ${LAYERS.join(', ')}`
  if (!text('fact') === !text('body')) return 'give exactly one of fact (one new fact) or body (the whole page)'
  const outside = args.outside
  if (outside !== undefined && outside !== null) {
    if (typeof outside !== 'object' || Array.isArray(outside) || typeof outside.label !== 'string' || !outside.label.trim()) return 'outside must be { label, url? }'
    if (outside.url !== undefined && typeof outside.url !== 'string') return 'outside.url must be a string'
  }
  const body: Record<string, unknown> = { title: text('title'), type: args.type }
  for (const key of ['summary', 'fact', 'body', 'section', 'from_note_id']) if (text(key)) body[key] = text(key)
  if (args.layer) body.layer = args.layer
  if (outside) body.outside = { label: outside.label.trim(), ...(typeof outside.url === 'string' && outside.url.trim() ? { url: outside.url.trim() } : {}) }
  return body
}

export default {
  description:
    'Save a fact to this thread\'s memory, so later threads know it. Memory is pages of 4 types: people, decisions, workstreams, playbooks. ' +
    'One topic per page: the title names the topic ("Priya", "Q4 launch"), and a page of that title gets the fact added; a new title makes a new page. ' +
    'One fact per call, in `fact`; send `body` only to rewrite the whole page. Facts only: never a secret, a password, a key or a token. ' +
    'Anything learned from a web page, an email, a file or a connector, not from the people in this thread: set `outside` to where it came from. ' +
    'Such a fact, or one that holds a link the page does not cite yet, waits under "Needs confirming" (status `unconfirmed`): agents do not get it until a person confirms it. ' +
    'The saved pages are read-only files under /opt/kortix/memory/; read them there, write only with this tool.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'The page title: the topic, a person, a decision or a workstream (120 characters at most).' },
      type: { type: 'string', enum: [...TYPES], description: 'The page type. An existing page keeps its type.' },
      summary: { type: 'string', description: 'One line that says what the page is about (200 characters at most).' },
      fact: { type: 'string', description: 'One new fact, added as a line to the page. Give this or body.' },
      body: { type: 'string', description: 'The whole page in Markdown; it replaces the page. Give this or fact.' },
      section: { type: 'string', description: 'The `## ` section of the page the fact goes under; made when missing.' },
      layer: {
        type: 'string',
        enum: [...LAYERS],
        description: 'Where to save: this channel (the default in a channel), the company (every channel), or this direct message (the default in a direct message).',
      },
      from_note_id: { type: 'string', description: 'A note this fact files into the page; the note is deleted.' },
      outside: {
        type: 'object',
        description: 'Where a fact from outside this thread came from. The fact waits for a person to confirm it.',
        properties: {
          label: { type: 'string', description: 'The source: a site, a mail subject, a file or a connector name.' },
          url: { type: 'string', description: 'Its address, when it has one.' },
        },
        required: ['label'],
      },
    },
    required: ['title', 'type'],
  },
  async execute(args: Record<string, any>, { env, signal }: ToolContext): Promise<unknown> {
    const input = rememberInput(args)
    if (typeof input === 'string') return `Error: invalid_input: ${input}`
    const api = env.KORTIX_API_URL?.trim().replace(/\/+$/, '')
    const project = env.KORTIX_PROJECT_ID?.trim()
    const token = env.KORTIX_TOKEN?.trim()
    if (!api || !project || !token) throw new Error('KORTIX_API_URL, KORTIX_PROJECT_ID or KORTIX_TOKEN is not set.')
    const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS)
    const response = await fetch(`${api.endsWith('/v1') ? api : `${api}/v1`}/projects/${encodeURIComponent(project)}/memory/remember`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: timeout,
    })
    const text = await response.text()
    let json: any = null
    try {
      json = JSON.parse(text)
    } catch {}
    if (response.status >= 400 && response.status < 500) {
      return `Error: ${json?.code ?? response.status}: ${json?.error ?? json?.message ?? (text.trim() || response.statusText)}`
    }
    if (!response.ok || !json) throw new Error(`memory is unavailable (${response.status}): ${text.slice(0, 500)}`)
    const layer = json.layer
    const dir = COPY_DIRS[layer?.scope]
    if (dir && typeof layer.layer_id === 'string' && layer.version !== undefined && layer.version !== null) {
      await syncMemoryCopy([{ layer_id: layer.layer_id, version: String(layer.version), dir }], env)
    }
    return json
  },
}
