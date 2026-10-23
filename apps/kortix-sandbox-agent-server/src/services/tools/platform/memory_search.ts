/**
 * memory_search: the platform tool an agent finds memory pages with
 * (`project_channels`), for pages the turn's page list leaves out. It loads
 * with `remember` (`KORTIX_SPACE_ID`) and only reads: `edit: deny` keeps it.
 *
 * A call asks the API (`GET /v1/projects/:projectId/memory/search`, session
 * token), which searches only the thread's own layers and confirmed pages.
 * Each hit is one line, `- [<layer>] <title> — <summary> (<copy path>)`, with
 * its snippet under it. The path is the page's file in the thread's read-only
 * copy, found by the `page_id` in its header; a page the copy does not hold
 * yet (written after this turn's sync) gets none. A refusal is returned as
 * `Error: <code>: <message>` for the model.
 */
import { constants } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { MEMORY_COPY_DIR } from '@kortix/api-contract/sandbox-layout'
import { TYPE_FOLDERS } from '../memory-copy'
import type { ToolContext } from '../tool'

const TIMEOUT_MS = 30_000
const TYPES = ['people', 'decisions', 'workstreams', 'playbooks', 'note'] as const
const MAX_LIMIT = 20
const SNIPPET_CHARS = 240
/** A layer scope → its copy folder. */
const COPY_DIRS: Record<string, string> = { company: 'company', channel: 'channel', dm: 'personal' }

/** One hit of `GET …/memory/search`, as far as the tool reads it. */
export interface MemorySearchHit {
  page_id: string
  layer_name: string
  scope: string
  type: string
  title: string
  summary?: string | null
  snippet?: string | null
}

/** The search query string, or why the arguments are not one. */
function searchQuery(args: Record<string, any>): URLSearchParams | string {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (query.length < 2 || query.length > 200) return 'query must be 2 to 200 characters'
  const params = new URLSearchParams({ q: query })
  if (args.type !== undefined && args.type !== null) {
    if (!(TYPES as readonly unknown[]).includes(args.type)) return `type must be one of ${TYPES.join(', ')}`
    params.set('type', args.type)
  }
  if (args.limit !== undefined && args.limit !== null) {
    const limit = typeof args.limit === 'string' && /^\d+$/.test(args.limit.trim()) ? Number(args.limit) : args.limit
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return `limit must be a whole number from 1 to ${MAX_LIMIT}`
    params.set('limit', String(limit))
  }
  return params
}

/** page_id → file path, for the copy folders the hits name. A folder that is missing or unreadable adds nothing. */
async function copyPaths(hits: readonly MemorySearchHit[], root: string): Promise<Map<string, string>> {
  const known = (hit: MemorySearchHit) => Object.hasOwn(COPY_DIRS, hit.scope) && Object.hasOwn(TYPE_FOLDERS, hit.type)
  const folders = new Set(hits.filter(known).map((hit) => join(root, COPY_DIRS[hit.scope]!, TYPE_FOLDERS[hit.type]!)))
  const paths = new Map<string, string>()
  for (const folder of folders) {
    const names = await readdir(folder).catch(() => [] as string[])
    for (const name of names.filter((entry) => entry.endsWith('.md'))) {
      // The header line render.ts writes: `page_id: "<uuid>"`.
      const id = /^page_id: "([^"\n]+)"$/m.exec(await fileHead(join(folder, name)))?.[1]
      if (id) paths.set(id, join(folder, name))
    }
  }
  return paths
}

/**
 * The first 4 KiB of a regular file, else ''. The agent can unlock and edit the
 * copy: a link is not followed, and a FIFO or device is not read.
 */
async function fileHead(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null)
  if (!file) return ''
  try {
    if (!(await file.stat()).isFile()) return ''
    const buffer = Buffer.alloc(4096)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return ''
  } finally {
    await file.close()
  }
}

const oneLine = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim()

/** The model's text for the hits: one line per page and its snippet under it. */
export async function formatHits(query: string, hits: readonly MemorySearchHit[], root: string = MEMORY_COPY_DIR): Promise<string> {
  if (hits.length === 0) return `No memory page matches "${query}". Pages you save with \`remember\` are found here.`
  const paths = await copyPaths(hits, root)
  const lines = [`${hits.length} memory ${hits.length === 1 ? 'page matches' : 'pages match'} "${query}". Read a page at its path before relying on details.`]
  for (const hit of hits) {
    const summary = oneLine(hit.summary)
    const path = paths.get(hit.page_id)
    lines.push(`- [${oneLine(hit.layer_name)}] ${oneLine(hit.title)}${summary ? ` — ${summary}` : ''} (${path ?? 'not in this thread\'s copy yet; it is there from the next message'})`)
    const snippet = oneLine(hit.snippet)
    if (snippet) lines.push(`  ${snippet.length > SNIPPET_CHARS ? `${snippet.slice(0, SNIPPET_CHARS - 1)}…` : snippet}`)
  }
  return lines.join('\n')
}

export default {
  description:
    "Search this thread's memory pages by words: the company's, this channel's and, in a direct message, yours with this agent. " +
    'Use it for a page the memory page list of this turn does not show, or to find which page holds a fact. ' +
    'Returns each matching page with its layer, summary, a snippet and its file under /opt/kortix/memory/; read the file for the whole page.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Words to find in the page titles, summaries and text (2 to 200 characters).' },
      type: { type: 'string', enum: [...TYPES], description: 'Only pages of this type.' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `How many pages at most (default and maximum ${MAX_LIMIT}).` },
    },
    required: ['query'],
  },
  async execute(args: Record<string, any>, { env, signal }: ToolContext): Promise<string> {
    const params = searchQuery(args)
    if (typeof params === 'string') return `Error: invalid_input: ${params}`
    const api = env.KORTIX_API_URL?.trim().replace(/\/+$/, '')
    const project = env.KORTIX_PROJECT_ID?.trim()
    const token = env.KORTIX_TOKEN?.trim()
    if (!api || !project || !token) throw new Error('KORTIX_API_URL, KORTIX_PROJECT_ID or KORTIX_TOKEN is not set.')
    const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS)
    const response = await fetch(`${api.endsWith('/v1') ? api : `${api}/v1`}/projects/${encodeURIComponent(project)}/memory/search?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: timeout,
    })
    const text = await response.text()
    let json: any = null
    try {
      json = JSON.parse(text)
    } catch {}
    if (response.status >= 400 && response.status < 500) {
      return `Error: ${json?.code ?? response.status}: ${String(json?.error ?? json?.message ?? (text.trim() || response.statusText)).slice(0, 500)}`
    }
    if (!response.ok || !Array.isArray(json?.hits)) throw new Error(`memory search is unavailable (${response.status}): ${text.slice(0, 500)}`)
    return formatHits(params.get('q')!, json.hits as MemorySearchHit[])
  },
}
