import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import memorySearch, { formatHits, type MemorySearchHit } from '@/services/tools/platform/memory_search'

/**
 * The `memory_search` platform tool (services/tools/platform/memory_search.ts):
 * the request it sends is the contract with `GET /v1/projects/:id/memory/search`,
 * and the text is what the model reads. The API is a fake on a real port.
 */
type Call = { path: string; query: Record<string, string>; auth: string | null }
let server: ReturnType<typeof Bun.serve> | undefined
let calls: Call[]
let env: Record<string, string | undefined>

function api(status: number, reply: unknown): void {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.get('authorization') })
      return typeof reply === 'string' ? new Response(reply, { status }) : Response.json(reply, { status })
    },
  })
  env = { KORTIX_API_URL: `http://127.0.0.1:${server.port}/v1/`, KORTIX_PROJECT_ID: 'proj-1', KORTIX_TOKEN: 'kortix_sb_test' }
}

const call = (args: Record<string, unknown>) =>
  memorySearch.execute(args, { sessionId: 'ses_1', agent: 'kortix', directory: '/workspace', env, signal: new AbortController().signal })

const HIT: MemorySearchHit = {
  page_id: 'page-1',
  layer_name: '#marketing',
  scope: 'channel',
  type: 'workstreams',
  title: 'Q4 launch',
  summary: 'The Q4 launch plan',
  snippet: 'Launch moves to\n12 November',
}

beforeEach(() => {
  calls = []
  env = {}
})
afterEach(() => {
  server?.stop(true)
  server = undefined
})

describe('memory_search', () => {
  test('a search goes to the API with the session token, the query, type and limit', async () => {
    api(200, { hits: [] })
    expect(await call({ query: '  launch date ', type: 'decisions', limit: 5 })).toBe('No memory page matches "launch date". Pages you save with `remember` are found here.')
    await call({ query: '50% off_x', limit: '3' })
    expect(calls).toEqual([
      { path: '/v1/projects/proj-1/memory/search', query: { q: 'launch date', type: 'decisions', limit: '5' }, auth: 'Bearer kortix_sb_test' },
      { path: '/v1/projects/proj-1/memory/search', query: { q: '50% off_x', limit: '3' }, auth: 'Bearer kortix_sb_test' },
    ])
  })

  test('arguments that are not a search are refused before any request', async () => {
    api(200, { hits: [] })
    const refused = {
      'query must be 2 to 200 characters': [{}, { query: ' a ' }, { query: 'x'.repeat(201) }, { query: 5 }],
      'type must be one of people, decisions, workstreams, playbooks, note': [{ query: 'launch', type: 'pages' }],
      'limit must be a whole number from 1 to 20': [{ query: 'launch', limit: 0 }, { query: 'launch', limit: 21 }, { query: 'launch', limit: 2.5 }, { query: 'launch', limit: 'ten' }],
    }
    for (const [message, cases] of Object.entries(refused)) {
      for (const args of cases) expect(await call(args)).toBe(`Error: invalid_input: ${message}`)
    }
    expect(calls).toEqual([])
  })

  test('a 4xx answer is `Error: <code>: <message>`; a 5xx, a malformed answer or no token is a tool error', async () => {
    api(403, { error: 'Memory is on for channel and DM threads only.', code: 'memory_layer_forbidden' })
    expect(await call({ query: 'launch' })).toBe('Error: memory_layer_forbidden: Memory is on for channel and DM threads only.')
    server!.stop(true)
    api(503, { error: 'down' })
    await expect(call({ query: 'launch' })).rejects.toThrow('memory search is unavailable (503)')
    server!.stop(true)
    api(200, { pages: [] })
    await expect(call({ query: 'launch' })).rejects.toThrow('memory search is unavailable (200)')
    env = { ...env, KORTIX_TOKEN: '' }
    await expect(call({ query: 'launch' })).rejects.toThrow('KORTIX_TOKEN')
  })
})

describe('memory_search output', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'memory-search-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const page = (path: string, pageId: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), `---\ntitle: "x"\ntype: workstreams\npage_id: "${pageId}"\nsources: []\n---\n\n# x\n`)
  }

  test('one line per hit with its layer, summary and copy file, the snippet under it on one line', async () => {
    page('channel/workstreams/q4-launch.md', 'page-1')
    page('channel/workstreams/q3-launch.md', 'page-0')
    page('personal/people/priya.md', 'page-2')
    const hits: MemorySearchHit[] = [
      HIT,
      { page_id: 'page-2', layer_name: 'Your memory with Kortix', scope: 'dm', type: 'people', title: 'Priya', summary: '', snippet: null },
      { page_id: 'page-3', layer_name: 'Company', scope: 'company', type: 'note', title: 'Launch call', summary: 'Notes', snippet: 'y'.repeat(300) },
    ]
    expect((await formatHits('launch', hits, root)).split('\n')).toEqual([
      '3 memory pages match "launch". Read a page at its path before relying on details.',
      `- [#marketing] Q4 launch — The Q4 launch plan (${root}/channel/workstreams/q4-launch.md)`,
      '  Launch moves to 12 November',
      `- [Your memory with Kortix] Priya (${root}/personal/people/priya.md)`,
      "- [Company] Launch call — Notes (not in this thread's copy yet; it is there from the next message)",
      `  ${'y'.repeat(239)}…`,
    ])
  })

  test('the tool returns the formatted hits; with no copy on this machine the path says so', async () => {
    api(200, { hits: [HIT] })
    expect((await call({ query: 'launch' })).split('\n')).toEqual([
      '1 memory page matches "launch". Read a page at its path before relying on details.',
      "- [#marketing] Q4 launch — The Q4 launch plan (not in this thread's copy yet; it is there from the next message)",
      '  Launch moves to 12 November',
    ])
  })
})

describe('memory_search under a permission policy (pi)', () => {
  test('memory_search only reads: edit: deny leaves it, its own rule decides', async () => {
    const { compilePermissionPolicy, resolvePolicyRule } = await import('@/harness/pi/interactions')
    const rule = (permission: unknown) => resolvePolicyRule(compilePermissionPolicy(permission), 'memory_search', { query: 'launch' }, '/workspace')
    expect(rule({ edit: 'deny' })).toBeUndefined()
    expect(rule({ edit: 'deny', memory_search: 'deny' })).toBe('deny')
  })
})
