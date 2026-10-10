import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PermissionBroker, compilePermissionPolicy } from '@/harness/pi/interactions'
import imageSearch from '@/services/tools/kortix/image_search'
import memoryTool from '@/services/tools/kortix/memory'
import scrapeWebpage from '@/services/tools/kortix/scrape_webpage'
import showTool from '@/services/tools/kortix/show'
import webSearch from '@/services/tools/kortix/web_search'
import { KORTIX_TOOLS, loadTools, runTool } from '@/services/tools/host'
import { asTool, type ToolContext } from '@/services/tools/tool'

/**
 * The Kortix tools every harness runs (services/tools). The web tools are
 * driven against a router fake on a real port: the request each one sends
 * (path, credential, body) is the contract with the API's billed proxy, and
 * the output JSON is the contract with the skills and the client's tool views.
 */
const ENV_KEYS = ['KORTIX_API_URL', 'KORTIX_TOKEN', 'TAVILY_API_KEY', 'SERPER_API_KEY', 'FIRECRAWL_API_KEY'] as const
type Call = { path: string; headers: Record<string, string>; body: any }

let saved: Record<string, string | undefined>
let server: ReturnType<typeof Bun.serve> | undefined
let calls: Call[]
let dir: string

/** The call context a harness passes: this session, this agent, the project checkout. */
const ctx = (): ToolContext => ({ sessionId: 'ses_test', agent: 'kortix', directory: dir, env: process.env, signal: new AbortController().signal })
/** The tools return their output text. */
const out = (result: unknown) => result as string

function router(handle: (call: Call) => unknown | Response): void {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const call = { path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers), body: await req.json() }
      calls.push(call)
      const reply = handle(call)
      return reply instanceof Response ? reply : Response.json(reply)
    },
  })
  process.env.KORTIX_API_URL = `http://127.0.0.1:${server.port}`
  process.env.KORTIX_TOKEN = 'kortix_sb_test'
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  calls = []
  dir = mkdtempSync(join(tmpdir(), 'pi-kortix-tools-'))
})

afterEach(() => {
  server?.stop(true)
  server = undefined
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('web_search', () => {
  test('one query goes to the router proxy with the sandbox token and returns the template tool shape', async () => {
    router(() => ({
      answer: 'Bun is a runtime.',
      results: [{ title: 'Bun', url: 'https://bun.sh', content: 'A fast runtime', score: 0.9, published_date: '2026-01-01' }],
      images: ['https://img/1.png', { url: 'https://img/2.png', description: 'logo' }],
      response_time: 1.2,
    }))
    const result = JSON.parse(out(await webSearch.execute({ query: ' bun runtime ', num_results: 50, topic: 'news' }, ctx())))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.path).toBe('/v1/router/tavily/search')
    expect(calls[0]!.headers.authorization).toBe('Bearer kortix_sb_test')
    expect(calls[0]!.body).toEqual({
      query: 'bun runtime',
      search_depth: 'basic',
      topic: 'news',
      max_results: 20,
      include_answer: true,
      include_images: true,
      include_image_descriptions: true,
    })
    expect(result).toEqual({
      query: 'bun runtime',
      success: true,
      answer: 'Bun is a runtime.',
      results: [{ title: 'Bun', url: 'https://bun.sh', snippet: 'A fast runtime', score: 0.9, published_date: '2026-01-01' }],
      images: [{ url: 'https://img/1.png', description: '' }, { url: 'https://img/2.png', description: 'logo' }],
      response_time_ms: 1.2,
    })
  })

  test('a ||| batch runs one request per query and reports a failed query beside the good one', async () => {
    router((call) => (call.body.query === 'bad' ? new Response('quota', { status: 402 }) : { results: [{ title: 'ok', url: 'https://ok' }] }))
    const result = JSON.parse(out(await webSearch.execute({ query: 'good ||| bad' }, ctx())))
    expect(calls.map((call) => call.body.query).sort()).toEqual(['bad', 'good'])
    expect(result.batch_mode).toBe(true)
    expect(result.total_queries).toBe(2)
    expect(result.results[0]).toMatchObject({ query: 'good', success: true })
    expect(result.results[1]).toEqual({ query: 'bad', success: false, error: 'Error: 402 Error: quota' })
  })

  test('a box with a control plane and no token refuses before any request', async () => {
    router(() => ({}))
    delete process.env.KORTIX_TOKEN
    await expect(webSearch.execute({ query: 'x' }, ctx())).rejects.toThrow('KORTIX_TOKEN is not set.')
    expect(calls).toHaveLength(0)
  })

  test('a box with no control plane and no upstream key names the key it needs', async () => {
    await expect(webSearch.execute({ query: 'x' }, ctx())).rejects.toThrow('TAVILY_API_KEY is not set.')
  })

  test('an empty query is refused', async () => {
    router(() => ({}))
    await expect(webSearch.execute({ query: ' ||| ' }, ctx())).rejects.toThrow('The query is empty.')
  })
})

describe('image_search', () => {
  test('one query posts to the serper proxy with the token as X-API-KEY', async () => {
    router(() => ({ images: [{ imageUrl: 'https://img/cat.png', title: 'Cat', link: 'https://cats', imageWidth: 10, imageHeight: 20 }] }))
    const result = JSON.parse(out(await imageSearch.execute({ query: 'cats', num_results: 500 }, ctx())))
    expect(calls[0]!.path).toBe('/v1/router/serper/images')
    expect(calls[0]!.headers['x-api-key']).toBe('kortix_sb_test')
    expect(calls[0]!.body).toEqual({ q: 'cats', num: 100 })
    expect(result).toEqual({ query: 'cats', total: 1, images: [{ url: 'https://img/cat.png', title: 'Cat', source: 'https://cats', width: 10, height: 20 }] })
  })

  test('a batch posts one array and pairs each answer with its query', async () => {
    router(() => [{ images: [{ imageUrl: 'a' }] }, { images: [] }])
    const result = JSON.parse(out(await imageSearch.execute({ query: 'cats ||| dogs' }, ctx())))
    expect(calls[0]!.body).toEqual([{ q: 'cats', num: 12 }, { q: 'dogs', num: 12 }])
    expect(result).toEqual({
      batch_mode: true,
      results: [
        { query: 'cats', total: 1, images: [{ url: 'a', title: '', source: '', width: 0, height: 0 }] },
        { query: 'dogs', total: 0, images: [] },
      ],
    })
  })

  test('no image and an upstream error are different answers', async () => {
    router((call) => (call.body.q === 'none' ? { images: [] } : new Response('down', { status: 503 })))
    expect(out(await imageSearch.execute({ query: 'none' }, ctx()))).toBe("No images found for: 'none'")
    await expect(imageSearch.execute({ query: 'boom' }, ctx())).rejects.toThrow('Serper API returned 503: down')
  })
})

describe('scrape_webpage', () => {
  const page = (url: string) => ({ success: true, data: { markdown: `# ${url}`, html: '<h1>x</h1>', metadata: { title: 'T' } } })

  test('one URL posts to the firecrawl proxy and returns markdown without HTML by default', async () => {
    router((call) => page(call.body.url))
    const result = JSON.parse(out(await scrapeWebpage.execute({ urls: 'https://a.test' }, ctx())))
    expect(calls[0]!.path).toBe('/v1/router/firecrawl/v2/scrape')
    expect(calls[0]!.headers.authorization).toBe('Bearer kortix_sb_test')
    expect(calls[0]!.body).toEqual({ url: 'https://a.test', formats: ['markdown'], timeout: 30000 })
    expect(result).toEqual({ url: 'https://a.test', success: true, title: 'T', content: '# https://a.test', content_length: 16, metadata: { title: 'T' } })
  })

  test('several URLs report the failed one beside the scraped ones', async () => {
    router((call) => (call.body.url.includes('bad') ? Response.json({ success: false, error: 'blocked' }, { status: 403 }) : page(call.body.url)))
    const result = JSON.parse(out(await scrapeWebpage.execute({ urls: 'https://a.test, https://bad.test', include_html: true }, ctx())))
    expect(calls[0]!.body.formats).toEqual(['markdown', 'html'])
    expect(result).toMatchObject({ total: 2, successful: 1, failed: 1 })
    expect(result.results[0].html).toBe('<h1>x</h1>')
    expect(result.results[1]).toEqual({ url: 'https://bad.test', success: false, error: 'blocked' })
  })

  test('a call where every URL fails is an error', async () => {
    router(() => Response.json({ success: false, error: 'blocked' }, { status: 403 }))
    await expect(scrapeWebpage.execute({ urls: 'https://bad.test' }, ctx())).rejects.toThrow('Failed to scrape all 1 URLs. https://bad.test: blocked')
  })
})

describe('the Kortix tools follow the capability of what they do', () => {
  const rule = (policy: unknown, tool: string, args: unknown = {}) => new PermissionBroker('ses_test', () => {}, compilePermissionPolicy(policy)).rule(tool, args)

  test.each([
    ['web_search', { websearch: 'deny' }, 'deny'],
    ['image_search', { websearch: 'ask' }, 'ask'],
    ['scrape_webpage', { webfetch: 'deny' }, 'deny'],
    // The other capability does not reach across.
    ['scrape_webpage', { websearch: 'deny' }, 'allow'],
    ['web_search', { webfetch: 'deny' }, 'allow'],
    // A rule for the tool itself outranks its capability.
    ['web_search', { websearch: 'deny', web_search: 'allow' }, 'allow'],
    ['show', { websearch: 'deny', webfetch: 'deny', edit: 'deny' }, 'allow'],
  ])('%s under %j is %s', (tool, policy, expected) => {
    expect<string>(rule(policy, tool)).toBe(expected)
  })

  test.each([
    // A memory write is a file write: `edit` governs it, as it governs `write`.
    ['create', { edit: 'deny' }, 'deny'],
    ['str_replace', { edit: 'ask' }, 'ask'],
    ['delete', { edit: 'deny', read: 'allow' }, 'deny'],
    ['rename', { edit: 'deny' }, 'deny'],
    ['insert', { edit: 'deny' }, 'deny'],
    // Reading memory is a read.
    ['view', { edit: 'deny' }, 'allow'],
    ['view', { read: 'deny' }, 'deny'],
    // A path pattern reaches the memory path.
    ['create', { edit: { 'memory/*': 'allow', '*': 'deny' } }, 'allow'],
    // A rule for the tool itself outranks both.
    ['create', { edit: 'deny', memory: 'allow' }, 'allow'],
  ])('memory %s under %j is %s', (command, policy, expected) => {
    expect<string>(rule(policy, 'memory', { command, path: 'memory/notes.md' })).toBe(expected)
  })

  test('an "always" reply to a memory write allows the edit capability, not memory reads elsewhere', async () => {
    const broker = new PermissionBroker('ses_test', () => {}, compilePermissionPolicy({ edit: 'ask', read: 'ask' }))
    const asked = broker.ask({ tool: 'memory', args: { command: 'create', path: 'memory/a.md' } })
    const [request] = broker.list()
    expect(request!.permission).toBe('edit')
    broker.reply(request!.id, 'always')
    await asked
    expect<string>(broker.rule('write', { path: 'a.txt' })).toBe('allow')
    expect<string>(broker.rule('memory', { command: 'view', path: 'memory/a.md' })).toBe('ask')
  })
})

describe('memory', () => {
  const memory = (args: Record<string, unknown>) => Promise.resolve(memoryTool.execute(args, ctx())).then(out)

  test('create, view, str_replace, insert, rename and delete act on <project>/memory', async () => {
    expect(await memory({ command: 'create', path: 'memory/notes.md', file_text: 'alpha\nbeta' })).toBe('File created successfully at: memory/notes.md')
    expect(statSync(join(dir, 'memory/notes.md')).mode & 0o777).toBe(0o600)
    expect(await memory({ command: 'create', path: 'memory/notes.md', file_text: 'x' })).toBe('Error: File memory/notes.md already exists')
    expect(await memory({ command: 'view', path: 'memory/notes.md' })).toBe("Here's the content of memory/notes.md with line numbers:\n     1\talpha\n     2\tbeta")
    expect(await memory({ command: 'str_replace', path: 'memory/notes.md', old_str: 'beta', new_str: 'gamma' })).toContain('The memory file has been edited.')
    expect(await memory({ command: 'insert', path: 'memory/notes.md', insert_line: 0, insert_text: 'top' })).toBe('The file memory/notes.md has been edited.')
    expect(readFileSync(join(dir, 'memory/notes.md'), 'utf8')).toBe('top\nalpha\ngamma')
    expect(await memory({ command: 'rename', old_path: 'memory/notes.md', new_path: 'memory/topics/notes.md' })).toBe('Successfully renamed memory/notes.md to memory/topics/notes.md')
    expect(await memory({ command: 'view', path: 'memory' })).toContain('memory/topics/notes.md')
    expect(await memory({ command: 'delete', path: 'memory/topics' })).toBe('Successfully deleted memory/topics')
    expect(await memory({ command: 'delete', path: 'memory' })).toBe('Cannot delete the memory directory itself')
  })

  test('a path outside memory/ is refused and writes nothing', async () => {
    mkdirSync(join(dir, 'memory-evil'))
    writeFileSync(join(dir, 'secret.txt'), 'secret')
    mkdirSync(join(dir, 'memory'))
    symlinkSync(dir, join(dir, 'memory', 'out'))
    expect(await memory({ command: 'create', path: 'memory-evil/x.md', file_text: 'x' })).toBe('Error: Path must start with memory, got: memory-evil/x.md')
    expect(await memory({ command: 'create', path: 'memory/../escape.md', file_text: 'x' })).toBe('Error: Path memory/../escape.md would escape memory directory')
    expect(await memory({ command: 'view', path: 'memory/out/secret.txt' })).toBe('Error: Path would escape memory directory via symlink')
    expect(await memory({ command: 'create', path: '/etc/passwd', file_text: 'x' })).toBe('Error: Path must start with memory, got: /etc/passwd')
    expect(() => statSync(join(dir, 'escape.md'))).toThrow()
    expect(() => statSync(join(dir, 'memory-evil/x.md'))).toThrow()
  })

  test('a command without its required argument names the argument', async () => {
    expect(await memory({ command: 'view' })).toBe('Error: `path` is required for view.')
    expect(await memory({ command: 'create', path: 'memory/a.md' })).toBe('Error: `file_text` is required for create.')
    expect(await memory({ command: 'str_replace', path: 'memory/a.md', old_str: 'a' })).toBe('Error: `new_str` is required for str_replace.')
    expect(await memory({ command: 'rename', old_path: 'memory/a.md' })).toBe('Error: `new_path` is required for rename.')
  })
})

describe('show', () => {
  const show = async (args: Record<string, unknown>) => showTool.execute({ action: 'show', ...args }, ctx())

  test('a relative path resolves against the project checkout', async () => {
    writeFileSync(join(dir, 'report.md'), '# report')
    const result = JSON.parse(out(await show({ type: 'file', path: 'report.md', title: 'Report' })))
    expect(result).toMatchObject({ success: true, action: 'show', message: "Item 'Report' presented to user." })
    expect(result.entry).toMatchObject({ type: 'file', variant: 'compact', title: 'Report', path: join(dir, 'report.md') })
    expect(result.entry.id).toMatch(/^show_\d+_/)
  })

  test('a missing file, a missing type and a type without its field are errors', async () => {
    await expect(show({ type: 'file', path: 'nope.md' })).rejects.toThrow(`File not found: ${join(dir, 'nope.md')}`)
    await expect(show({})).rejects.toThrow("'type' is required.")
    await expect(show({ type: 'url' })).rejects.toThrow("'url' is required when type is 'url'.")
    await expect(show({ type: 'text' })).rejects.toThrow("'content' is required when type is 'text'.")
  })

  test('items become one carousel; a bad item is a warning while a good one remains', async () => {
    const result = JSON.parse(out(await show({ title: 'Two', items: JSON.stringify([{ type: 'url', url: 'http://localhost:3000' }, { type: 'image' }]) })))
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ type: 'url', variant: 'full', url: 'http://localhost:3000' })
    expect(result.warnings).toEqual(["Item 1: 'path' is required when type is 'image'."])
    expect(result.message).toBe('1 item(s) presented to user as carousel.')
    await expect(show({ items: JSON.stringify([{ type: 'image' }]) })).rejects.toThrow('All items failed validation')
    await expect(show({ items: 'not json' })).rejects.toThrow("Invalid JSON in 'items' parameter.")
  })
})

describe('each Kortix tool is one self-contained module (what `kortix tools eject` copies)', () => {
  const kortixDir = join(import.meta.dir, '../services/tools/kortix')
  const modules = { web_search: webSearch, image_search: imageSearch, scrape_webpage: scrapeWebpage, memory: memoryTool, show: showTool }

  test('one file per Kortix tool, named after the tool', () => {
    expect(readdirSync(kortixDir).sort()).toEqual(Object.keys(KORTIX_TOOLS).map((name) => `${name}.ts`).sort())
  })

  test('a module imports only node:* and default-exports the project tool contract', () => {
    for (const [name, tool] of Object.entries(modules)) {
      const source = readFileSync(join(kortixDir, `${name}.ts`), 'utf8')
      const specifiers = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2] ?? m[3])
      expect({ name, imports: specifiers.filter((specifier) => !specifier!.startsWith('node:')) }).toEqual({ name, imports: [] })
      expect(typeof asTool(tool)).toBe('object')
      expect(KORTIX_TOOLS[name]).toBe(tool)
    }
  })

  test('a web tool reads the Kortix API and token from context.env, not process.env', async () => {
    router(() => ({ results: [{ title: 'ok', url: 'https://ok' }] }))
    const env = { KORTIX_API_URL: `${process.env.KORTIX_API_URL}/v1/`, KORTIX_TOKEN: 'kortix_sb_from_context' }
    process.env.KORTIX_TOKEN = 'kortix_sb_process'
    await webSearch.execute({ query: 'x' }, { ...ctx(), env })
    expect(calls.map((call) => [call.path, call.headers.authorization])).toEqual([['/v1/router/tavily/search', 'Bearer kortix_sb_from_context']])
  })

  test('a copy in the project checkout loads as a project tool and gives the same output', async () => {
    router(() => ({ answer: 'same', results: [] }))
    mkdirSync(join(dir, 'tools'))
    writeFileSync(join(dir, 'tools/web_search.ts'), readFileSync(join(kortixDir, 'web_search.ts')))
    const { tools, failed } = await loadTools(dir, { kortix_tools: [], project_tools: { web_search: 'tools/web_search.ts' } })
    expect(failed).toEqual([])
    expect(tools.map((tool) => [tool.name, tool.source])).toEqual([['web_search', 'tools/web_search.ts']])
    expect(await runTool(tools[0]!, { query: 'q' }, ctx())).toBe(await runTool({ ...webSearch, name: 'web_search' }, { query: 'q' }, ctx()))
  })
})
