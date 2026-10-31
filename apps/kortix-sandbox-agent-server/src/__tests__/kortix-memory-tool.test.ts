import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { KortixToolResult } from '@kortix/api-contract/kortix-tool-card'
import { PLATFORM_TOOLS, loadTools, runTool } from '@/services/tools/host'

/**
 * kortix_memory (services/tools/platform/kortix_memory.ts) at its boundary:
 * the Kortix API. A stub API on a real port answers
 * `/v1/projects/:id/memory/me/agent/mykortix[/pages/:name]` as the real one
 * does (one page per name, 201 created / 200 updated, 404, 403
 * feature_disabled, 422 secret_detected) and records every request.
 */
interface Page {
  name: string
  title: string
  description: string
  type: string
  body: string
  page_id: string
  path: string
  updated_at: string
}

let server: ReturnType<typeof Bun.serve>
let pages: Map<string, Page>
let requests: Array<{ method: string; path: string; auth: string | null; body: unknown }>
let filesOff = false

const PREFIX = '/v1/projects/proj_1/memory/me/agent/mykortix'
const entry = ({ body: _body, ...rest }: Page) => rest

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const text = await req.text()
      const body = text ? JSON.parse(text) : null
      requests.push({ method: req.method, path: url.pathname, auth: req.headers.get('authorization'), body })
      if (filesOff) return Response.json({ error: 'Memory lives in Files. Turn on Files for this project first.', code: 'feature_disabled', feature: 'drives' }, { status: 403 })
      if (!url.pathname.startsWith(PREFIX)) return Response.json({ error: 'Not found' }, { status: 404 })
      const name = decodeURIComponent(url.pathname.slice(PREFIX.length).replace(/^\/pages\//, ''))
      if (url.pathname === PREFIX && req.method === 'GET') {
        const entries = [...pages.values()].reverse().map(entry)
        return Response.json({ layer_id: 'mykortix', folder: '/Users/lee/Memory/mykortix', entries, truncated: false, index: '' })
      }
      const page = pages.get(name)
      if (req.method === 'GET') return page ? Response.json(page) : Response.json({ error: 'Memory not found.', code: 'memory_not_found' }, { status: 404 })
      if (req.method === 'DELETE') {
        if (!page) return Response.json({ error: 'Memory not found.', code: 'memory_not_found' }, { status: 404 })
        pages.delete(name)
        return Response.json({ ok: true, name, title: page.title })
      }
      if (req.method === 'PUT') {
        if (/sk-proj-/.test(String(body.body))) return Response.json({ error: 'That looks like a secret.', code: 'secret_detected' }, { status: 422 })
        const next: Page = {
          name,
          title: body.title ?? page?.title ?? name.replace(/-/g, ' '),
          description: body.description,
          type: body.type,
          body: body.body,
          page_id: `pid_${name}`,
          path: `/Users/lee/Memory/mykortix/${name}.md`,
          updated_at: '2026-10-30T12:00:00.000Z',
        }
        pages.set(name, next)
        return Response.json({ created: !page, page: next }, { status: page ? 200 : 201 })
      }
      return Response.json({ error: 'Not found' }, { status: 404 })
    },
  })
})
afterAll(() => server.stop(true))
beforeEach(() => {
  pages = new Map()
  requests = []
  filesOff = false
})

const env = () => ({
  PATH: '/nonexistent',
  KORTIX_PROJECT_ID: 'proj_1',
  KORTIX_API_URL: `http://127.0.0.1:${server.port}/v1/`,
  KORTIX_TOKEN: 'kortix_sb_session',
})
const run = async (args: Record<string, unknown>) =>
  JSON.parse(
    await runTool({ ...PLATFORM_TOOLS.kortix_memory!, name: 'kortix_memory' }, args, {
      sessionId: 'ses_1',
      agent: 'mykortix',
      directory: '/tmp',
      env: env(),
      signal: new AbortController().signal,
    }),
  ) as KortixToolResult

const SHORT = { type: 'feedback', description: 'Likes replies of one to three sentences', body: 'Keep replies short.\n\n**Why:** reads on a phone.\n\n**How to apply:** one to three sentences.' }

describe('loading', () => {
  test('only a config that names it loads kortix_memory: no project agent gets it by default', async () => {
    expect((await loadTools(null, undefined)).tools.map((tool) => tool.name)).not.toContain('kortix_memory')
    expect((await loadTools(null, { kortix_tools: ['kortix_memory'] })).tools.map((tool) => tool.name)).toEqual(['kortix_memory'])
  })
})

describe('kortix_memory', () => {
  test('save creates a page, a second save of the same name updates it, list shows one page', async () => {
    const created = await run({ action: 'save', name: 'likes-short-replies', title: 'Likes short replies', ...SHORT })
    expect(created).toMatchObject({ ok: true, tool: 'kortix_memory', action: 'save', card: { title: 'Remembered: Likes short replies', status: 'done' }, data: { created: true, name: 'likes-short-replies', type: 'feedback' } })
    // No screen to link: the person reaches this memory only through My Kortix.
    expect(created.card.links).toBeUndefined()
    expect(requests[0]).toEqual({
      method: 'PUT',
      path: `${PREFIX}/pages/likes-short-replies`,
      auth: 'Bearer kortix_sb_session',
      body: { title: 'Likes short replies', description: SHORT.description, type: 'feedback', body: SHORT.body },
    })

    const updated = await run({ action: 'save', name: 'likes-short-replies', ...SHORT, description: 'Likes replies of one or two sentences' })
    expect(updated.card.title).toBe('Updated: Likes short replies')
    expect(updated.data).toMatchObject({ created: false })

    const listed = await run({ action: 'list' })
    expect(listed.card).toMatchObject({ title: '1 thing I remember', rows: [{ title: 'Likes short replies', detail: 'Likes replies of one or two sentences', badge: 'feedback' }] })
    expect(listed.data).toEqual({ entries: [{ name: 'likes-short-replies', title: 'Likes short replies', description: 'Likes replies of one or two sentences', type: 'feedback', updated_at: '2026-10-30T12:00:00.000Z' }], truncated: false })
  })

  test('view reads one page; delete forgets it; the next view is not found', async () => {
    await run({ action: 'save', name: 'works-at-acme', type: 'user', description: 'Role and team', body: 'Leads the support team.' })
    const viewed = await run({ action: 'view', name: 'works-at-acme' })
    expect(viewed).toMatchObject({ ok: true, card: { title: 'works at acme', subtitle: 'Role and team' }, data: { body: 'Leads the support team.' } })
    const forgot = await run({ action: 'delete', name: 'works-at-acme' })
    expect(forgot).toMatchObject({ ok: true, card: { title: 'Forgot: works at acme' }, data: { name: 'works-at-acme' } })
    expect(requests.at(-1)).toMatchObject({ method: 'DELETE', path: `${PREFIX}/pages/works-at-acme` })
    const gone = await run({ action: 'view', name: 'works-at-acme' })
    expect(gone).toMatchObject({ ok: false, error: { kind: 'not_found' }, card: { status: 'error' } })
  })

  test('an empty memory lists as "Nothing remembered yet"', async () => {
    expect((await run({ action: 'list' })).card.title).toBe('Nothing remembered yet')
  })

  test('an option-shaped, path-shaped or malformed name is refused before any request', async () => {
    for (const name of ['-rf', '--help', '../etc/passwd', 'a/b', 'Bad Name', 'UPPER', 'trailing-', 'a--b', '', 'x'.repeat(65)]) {
      for (const action of ['view', 'save', 'delete']) {
        // A save with no name takes one from its title (covered below).
        if (name === '' && action === 'save') continue
        const result = await run({ action, name, ...SHORT })
        expect({ name, action, ok: result.ok, kind: result.error?.kind }).toEqual({ name, action, ok: false, kind: 'invalid' })
      }
    }
    expect(requests).toEqual([])
  })

  test('save refuses a wrong type and a save with nothing to remember', async () => {
    expect((await run({ action: 'save', name: 'x', ...SHORT, type: 'secret' })).error?.kind).toBe('invalid')
    expect((await run({ action: 'save', name: 'x', type: 'user', body: '  ' })).error?.kind).toBe('invalid')
    expect((await run({ action: 'forget', name: 'x' })).error?.kind).toBe('invalid')
    expect(requests).toEqual([])
  })

  test('a save missing its name, type or body still saves: name from the title, type user, body from the description', async () => {
    const saved = await run({ action: 'save', title: 'Prefers bullet points', description: 'Prefers bullet points over paragraphs.' })
    expect(saved.ok).toBe(true)
    expect(requests.at(-1)).toMatchObject({
      method: 'PUT',
      path: `${PREFIX}/pages/prefers-bullet-points`,
      body: { title: 'Prefers bullet points', description: 'Prefers bullet points over paragraphs.', type: 'user', body: 'Prefers bullet points over paragraphs.' },
    })
  })

  test('a missing description falls back to the title, a multi-line one becomes one line; a name copied from the index keeps working', async () => {
    await run({ action: 'save', name: 'likes-short-replies', type: 'feedback', title: 'Likes short replies', body: 'Two sentences max.' })
    expect(requests.at(-1)?.body).toMatchObject({ description: 'Likes short replies' })
    await run({ action: 'save', name: 'likes-short-replies.md', type: 'feedback', description: 'two\nlines', body: 'Two sentences max.' })
    expect(requests.at(-1)).toMatchObject({ path: `${PREFIX}/pages/likes-short-replies`, body: { description: 'two lines' } })
    expect((await run({ action: 'view', name: 'likes-short-replies.md' })).ok).toBe(true)
  })

  test('Files off: a plain refusal that says to ask a project admin', async () => {
    filesOff = true
    for (const args of [{ action: 'list' }, { action: 'save', name: 'x', ...SHORT }, { action: 'delete', name: 'x' }]) {
      const result = await run(args)
      expect(result).toMatchObject({ ok: false, card: { title: 'Memory is off in this project', status: 'error' }, error: { kind: 'failed' } })
      expect(result.card.subtitle).toBe('Memory lives in Files, and Files is off in this project. Ask a project admin to turn Files on.')
    }
  })

  test('a secret is refused in plain words and never echoed', async () => {
    const key = ['sk', 'proj', 'a1B2c3D4e5F6g7H8'].join('-')
    const result = await run({ action: 'save', name: 'api-key', type: 'reference', description: 'The key', body: key })
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid' } })
    expect(JSON.stringify(result)).not.toContain(key)
    expect(result.card.subtitle).toContain('save it as a secret')
  })

  test('no control plane: a failure, not a throw', async () => {
    const result = JSON.parse(
      await runTool({ ...PLATFORM_TOOLS.kortix_memory!, name: 'kortix_memory' }, { action: 'list' }, {
        sessionId: 'ses_1',
        agent: 'mykortix',
        directory: '/tmp',
        env: { PATH: '/nonexistent' },
        signal: new AbortController().signal,
      }),
    ) as KortixToolResult
    expect(result).toMatchObject({ ok: false, error: { kind: 'failed', message: 'This computer has no connection to Kortix.' } })
  })
})
