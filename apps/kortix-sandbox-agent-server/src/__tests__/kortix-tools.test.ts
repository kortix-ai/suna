import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PermissionBroker, compilePermissionPolicy } from '@/harness/pi/interactions'
import imageGen, { IMAGE_GEN_SESSION_LIMIT, IMAGE_GEN_TURN_LIMIT } from '@/services/tools/kortix/image_gen'
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
const ENV_KEYS = ['KORTIX_API_URL', 'KORTIX_LLM_BASE_URL', 'KORTIX_TOKEN', 'TAVILY_API_KEY', 'SERPER_API_KEY', 'FIRECRAWL_API_KEY'] as const
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
      const reply = await handle(call)
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

describe('image_gen', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46])
  const generated = { created: 1, model: 'codex/gpt-image-2', provider: 'openai-codex', data: [{ b64_json: PNG.toString('base64'), mime_type: 'image/png' }], size: '1254x1254' }
  const answer = (bytes: Buffer, mime_type: string, extra: Record<string, unknown> = {}) => ({ ...generated, data: [{ b64_json: bytes.toString('base64'), mime_type }], ...extra })
  const u16be = (n: number) => Buffer.from([n >> 8, n & 0xff])
  const u32be = (n: number) => Buffer.from([n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff])
  const u32le = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24])
  /** Image headers as each encoder writes them: just enough bytes for the size. */
  const pngOf = (w: number, h: number) => Buffer.concat([PNG.subarray(0, 8), u32be(13), Buffer.from('IHDR'), u32be(w), u32be(h), Buffer.from([8, 6, 0, 0, 0])])
  const jpegOf = (sof: number, w: number, h: number) =>
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), u16be(16), Buffer.alloc(14), Buffer.from([0xff, 0xdb]), u16be(4), Buffer.alloc(2), Buffer.from([0xff, sof]), u16be(17), Buffer.from([8]), u16be(h), u16be(w), Buffer.alloc(10)])
  const webpOf = (chunk: string, body: Buffer) => Buffer.concat([Buffer.from('RIFF'), u32le(4 + 8 + body.length), Buffer.from('WEBP'), Buffer.from(chunk), u32le(body.length), body])
  const vp8 = (w: number, h: number) => webpOf('VP8 ', Buffer.concat([Buffer.from([0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a]), Buffer.from([w & 0xff, w >> 8, h & 0xff, h >> 8])]))
  const vp8l = (w: number, h: number) => webpOf('VP8L', Buffer.concat([Buffer.from([0x2f]), u32le((w - 1) | ((h - 1) << 14)), Buffer.alloc(3)]))
  const vp8x = (w: number, h: number) =>
    webpOf('VP8X', Buffer.from([0x10, 0, 0, 0, (w - 1) & 0xff, ((w - 1) >> 8) & 0xff, (w - 1) >> 16, (h - 1) & 0xff, ((h - 1) >> 8) & 0xff, (h - 1) >> 16]))
  const imagesDir = () => join(dir, 'output', 'images')
  const MiB = 1024 * 1024
  // Each test is its own session: the session cap counts per sessionId in the module.
  let session = 0
  beforeEach(() => void session++)
  const ictx = (): ToolContext => ({ ...ctx(), sessionId: `ses_image_gen_${session}` })
  /** One call: `generate` with one prompt unless `args` says otherwise. */
  const gen = (args: Record<string, unknown> = {}, context: ToolContext = ictx()) => Promise.resolve(imageGen.execute({ action: 'generate', prompts: ['x'], ...args }, context))
  const genJson = async (args: Record<string, unknown> = {}, context?: ToolContext) => JSON.parse(out(await gen(args, context)))
  const refusal = (code: string, message: string, status = 400) => Response.json({ code, message }, { status })

  /** The LLM gateway fake: the tool posts to `${KORTIX_LLM_BASE_URL}/images/*` with the session token. */
  function gateway(handle: (call: Call) => unknown | Response = () => generated): void {
    router(handle)
    process.env.KORTIX_LLM_BASE_URL = `${process.env.KORTIX_API_URL}/v1/llm`
    process.env.KORTIX_TOKEN = 'tok'
    delete process.env.KORTIX_API_URL
  }

  test('generate posts to the gateway images route with the session token and saves the PNG', async () => {
    gateway()
    const result = await genJson({ prompts: ['A red cube on a white table'] })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.path).toBe('/v1/llm/images/generations')
    expect(calls[0]!.headers.authorization).toBe('Bearer tok')
    expect(calls[0]!.body).toEqual({ model: 'auto', prompt: 'A red cube on a white table', aspect_ratio: 'auto', quality: 'auto', background: 'auto', n: 1 })
    // The header holds no size here, so the answer's size is the output size (Ruling R2). No failure: no `failed`.
    expect(result).toEqual({
      action: 'generate',
      model: 'codex/gpt-image-2',
      provider: 'openai-codex',
      images: [{ path: expect.any(String), size: '1254x1254', prompt: 'A red cube on a white table' }],
    })
    const [image] = result.images
    expect(image.path).toStartWith(`${imagesDir()}/a-red-cube-on-a-white-table-`)
    expect(image.path).toMatch(/-\d{8}-\d{6}\.png$/)
    expect(readFileSync(image.path).subarray(0, 8)).toEqual(PNG.subarray(0, 8))
  })

  test('three prompts run concurrently', async () => {
    // The fake holds every request open until it has seen three in flight, then answers them all.
    // A tool that sends them one by one never reaches three: the 2 s fallback answers it, and `peak` says 1.
    let inFlight = 0
    let peak = 0
    let releaseAll!: () => void
    const all = new Promise<void>((resolve) => (releaseAll = resolve))
    gateway(async (call) => {
      peak = Math.max(peak, ++inFlight)
      if (inFlight === 3) releaseAll()
      await Promise.race([all, Bun.sleep(2_000)])
      inFlight--
      const side = { 'a red cube': 64, 'a green cone': 96, 'a blue sphere': 128 }[call.body.prompt as string]!
      return answer(pngOf(side, side), 'image/png')
    })
    const result = await genJson({ prompts: ['a red cube', 'a green cone', 'a blue sphere'] })
    expect(peak).toBe(3)
    expect(calls.map((call) => call.body.prompt).sort()).toEqual(['a blue sphere', 'a green cone', 'a red cube'])
    expect(calls.every((call) => call.body.n === 1)).toBe(true)
    // In prompt order, each with its own file and size.
    expect(result.images.map((image: { prompt: string; size: string }) => [image.prompt, image.size])).toEqual([
      ['a red cube', '64x64'],
      ['a green cone', '96x96'],
      ['a blue sphere', '128x128'],
    ])
    expect(new Set(result.images.map((image: { path: string }) => image.path)).size).toBe(3)
    expect(readdirSync(imagesDir())).toHaveLength(3)
    expect(result.failed).toBeUndefined()
  })

  test('one failed prompt is reported in failed[] and the others are saved', async () => {
    gateway((call) => (call.body.prompt === 'blocked' ? refusal('content_policy', 'The prompt was refused.') : generated))
    const result = await genJson({ prompts: ['a cat', 'blocked', 'a dog'] })
    expect(result.images.map((image: { prompt: string }) => image.prompt)).toEqual(['a cat', 'a dog'])
    expect(result.failed).toEqual([{ prompt: 'blocked', error: 'Image generation failed (400): The prompt was refused. [content_policy]' }])
    expect(readdirSync(imagesDir())).toHaveLength(2)
  })

  test('all prompts failing throws the first failure in the R11 format', async () => {
    gateway((call) =>
      call.body.prompt === 'first'
        ? Response.json({ code: 'provider_not_connected', message: 'Connect Codex to use this model.', suggestion: 'Connect your ChatGPT account in Settings.' }, { status: 400 })
        : refusal('rate_limited', 'Image limit reached.', 429),
    )
    await expect(gen({ prompts: ['first', 'second'] })).rejects.toThrow(
      'Image generation failed (400): Connect Codex to use this model. Connect your ChatGPT account in Settings. [provider_not_connected]',
    )
    expect(calls).toHaveLength(2)
    expect(readdirSync(imagesDir())).toEqual([])
  })

  test('prompts must be 1–4 non-empty strings', async () => {
    gateway()
    const message = "'prompts' must be a list of 1 to 4 non-empty strings."
    for (const prompts of [undefined, [], ['a', 'b', 'c', 'd', 'e'], [''], ['a', '   '], [42], 'a cube', null]) {
      await expect(gen({ prompts })).rejects.toThrow(message)
    }
    // The old single-prompt shape is not read.
    await expect(Promise.resolve(imageGen.execute({ action: 'generate', prompt: 'a cube' }, ictx()))).rejects.toThrow(message)
    expect(calls).toHaveLength(0)
    // Four is the most; each prompt is trimmed.
    const result = await genJson({ prompts: [' a ', 'b', 'c', 'd'] })
    expect(result.images.map((image: { prompt: string }) => image.prompt)).toEqual(['a', 'b', 'c', 'd'])
  })

  test('model and aspect_ratio are forwarded; absent model sends auto', async () => {
    gateway()
    await gen({ prompts: ['x'], model: ' google/gemini-2.5-flash-image ', aspect_ratio: '16:9', quality: 'low', transparent_background: true })
    await gen({ prompts: ['y'], model: '' })
    expect(calls.map((call) => call.body)).toEqual([
      { model: 'google/gemini-2.5-flash-image', prompt: 'x', aspect_ratio: '16:9', quality: 'low', background: 'transparent', n: 1 },
      { model: 'auto', prompt: 'y', aspect_ratio: 'auto', quality: 'auto', background: 'auto', n: 1 },
    ])
  })

  test('a bad aspect_ratio or model is refused before any request; prompts replaces prompt and output_name', async () => {
    gateway()
    await expect(gen({ aspect_ratio: '1024x1024' })).rejects.toThrow("'aspect_ratio' must be one of auto, 1:1, 3:2, 2:3, 16:9, 9:16, 4:3, 3:4.")
    await expect(gen({ model: 42 })).rejects.toThrow("'model' must be a model id.")
    expect(calls).toHaveLength(0)
    expect(Object.keys(imageGen.parameters.properties).sort()).toEqual(['action', 'aspect_ratio', 'model', 'prompts', 'quality', 'reference_images', 'transparent_background'])
    expect(imageGen.parameters.required).toEqual(['action', 'prompts'])
    expect(imageGen.parameters.properties.prompts).toMatchObject({ type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4 })
  })

  test('a jpeg answer is saved as .jpg and size is read from the image header', async () => {
    gateway(() => answer(jpegOf(0xc0, 1536, 1024), 'image/jpeg', { size: '1024x1024' }))
    const [image] = (await genJson({ prompts: ['a cat'] })).images
    expect(image.path).toMatch(/\/a-cat-\d{8}-\d{6}\.jpg$/)
    // The saved bytes win over the answer's size.
    expect(image.size).toBe('1536x1024')
    expect(readFileSync(image.path).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
  })

  test('each image type is saved with its extension and its header size', async () => {
    const cases: Array<[Buffer, string, string]> = [
      [pngOf(1254, 1254), 'image/png', '1254x1254.png'],
      [jpegOf(0xc0, 1024, 1536), 'image/jpeg', '1024x1536.jpg'],
      [jpegOf(0xc2, 1376, 768), 'image/jpeg', '1376x768.jpg'],
      [vp8(1024, 1024), 'image/webp', '1024x1024.webp'],
      [vp8l(1536, 1024), 'image/webp', '1536x1024.webp'],
      [vp8x(1184, 864), 'image/webp', '1184x864.webp'],
    ]
    let next = 0
    gateway(() => answer(cases[next]![0], cases[next++]![1], { size: '1x1' }))
    for (const [, , expected] of cases) {
      const [image] = (await genJson()).images
      expect(`${image.size}.${image.path.split('.').pop()}`).toBe(expected)
    }
  })

  test('an answer that is not a png, jpeg or webp image is refused and writes no file', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
    const gif = Buffer.from('GIF89a\x01\x00\x01\x00')
    let next = 0
    gateway(() => [answer(svg, 'image/svg+xml'), answer(gif, 'image/gif'), answer(svg, 'image/png')][next++])
    for (let i = 0; i < 3; i++) {
      await expect(gen()).rejects.toThrow('Image generation returned an image that is not png, jpeg or webp.')
    }
    expect(readdirSync(imagesDir())).toEqual([])
  })

  test('the output names the model and provider that answered', async () => {
    gateway(() => answer(pngOf(1024, 1024), 'image/png', { model: 'openrouter/google/gemini-2.5-flash-image', provider: 'openrouter', size: undefined }))
    const result = await genJson({ model: 'auto' })
    expect(result).toEqual({
      action: 'generate',
      model: 'openrouter/google/gemini-2.5-flash-image',
      provider: 'openrouter',
      images: [{ path: expect.any(String), size: '1024x1024', prompt: 'x' }],
    })
  })

  test('the size falls back to the answer when the header has none', async () => {
    gateway(() => answer(PNG, 'image/png', { size: '1536x1024' }))
    expect((await genJson({ aspect_ratio: '3:2' })).images[0].size).toBe('1536x1024')
  })

  test('edit sends each reference image as a data URL, with every prompt', async () => {
    gateway()
    writeFileSync(join(dir, 'a.png'), PNG)
    mkdirSync(join(dir, 'refs'))
    writeFileSync(join(dir, 'refs', 'b.jpg'), JPEG)
    const result = await genJson({ action: 'edit', prompts: ['merge them', 'merge them at night'], reference_images: ['a.png', join(dir, 'refs/b.jpg')] })
    const images = [{ image_url: `data:image/png;base64,${PNG.toString('base64')}` }, { image_url: `data:image/jpeg;base64,${JPEG.toString('base64')}` }]
    expect(calls.map((call) => call.path)).toEqual(['/v1/llm/images/edits', '/v1/llm/images/edits'])
    expect(calls.map((call) => call.body.images)).toEqual([images, images])
    expect(result.action).toBe('edit')
    expect(result.images).toHaveLength(2)
  })

  test('a missing reference image is refused before any request', async () => {
    gateway()
    await expect(gen({ action: 'edit', reference_images: ['nope.png'] })).rejects.toThrow('nope.png')
    await expect(gen({ action: 'edit' })).rejects.toThrow('reference_images')
    expect(calls).toHaveLength(0)
  })

  test('six reference images are refused', async () => {
    gateway()
    const names = ['1', '2', '3', '4', '5', '6'].map((n) => {
      writeFileSync(join(dir, `${n}.png`), PNG)
      return `${n}.png`
    })
    await expect(gen({ action: 'edit', reference_images: names })).rejects.toThrow('At most 5 reference images')
    expect(calls).toHaveLength(0)
  })

  test('a gateway refusal surfaces its message, suggestion and code', async () => {
    gateway(() =>
      Response.json(
        { code: 'provider_not_connected', message: 'Connect Codex to use this model.', suggestion: 'Connect your ChatGPT account in Settings.', requestId: 'req_1' },
        { status: 400 },
      ),
    )
    await expect(gen()).rejects.toThrow('Image generation failed (400): Connect Codex to use this model. Connect your ChatGPT account in Settings. [provider_not_connected]')
    expect(readdirSync(imagesDir())).toEqual([])
  })

  test('an OpenAI-shaped error and a rate limit name their message, retry time and code', async () => {
    gateway(() => Response.json({ error: { message: 'Image limit reached.', code: 'rate_limited' } }, { status: 429, headers: { 'retry-after': '120' } }))
    await expect(gen()).rejects.toThrow('(429): Image limit reached. Retry after 120 s. [rate_limited]')
  })

  test('a long refusal message is cut at 500 characters; no code means no bracket', async () => {
    gateway(() => Response.json({ message: 'm'.repeat(2000) }, { status: 500 }))
    const error = (await gen().catch((err: Error) => err)) as Error
    expect(error.message).toBe(`Image generation failed (500): ${'m'.repeat(500)}`)
  })

  test('no gateway env names what is missing', async () => {
    await expect(gen()).rejects.toThrow('KORTIX_LLM_BASE_URL')
    process.env.KORTIX_LLM_BASE_URL = 'http://127.0.0.1:1/v1/llm'
    await expect(gen()).rejects.toThrow('KORTIX_TOKEN')
  })

  test('an aborted turn aborts every request and writes no file', async () => {
    const turn = new AbortController()
    let arrived = 0
    let bothArrived!: () => void
    const received = new Promise<void>((resolve) => (bothArrived = resolve))
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    gateway(async () => {
      if (++arrived === 2) bothArrived()
      await held
      return generated
    })
    const call = gen({ prompts: ['x', 'y'] }, { ...ictx(), signal: turn.signal })
    await received
    turn.abort()
    await expect(call).rejects.toThrow()
    release()
    expect(readdirSync(imagesDir())).toEqual([])
  })

  test('the eleventh image in one turn is refused', async () => {
    gateway()
    const turn = { ...ctx(), sessionId: 'ses_turn_cap', signal: new AbortController().signal }
    for (let i = 0; i < IMAGE_GEN_TURN_LIMIT; i++) await gen({ prompts: [`x${i}`] }, turn)
    await expect(gen({}, turn)).rejects.toThrow('Image limit for this turn reached')
    expect(IMAGE_GEN_TURN_LIMIT).toBe(10)
    expect(calls).toHaveLength(10)
    // The next turn starts again.
    await gen({ prompts: ['next turn'] }, { ...turn, signal: new AbortController().signal })
    expect(calls).toHaveLength(11)
  })

  test('a batch that would pass the turn cap is refused before any request', async () => {
    gateway()
    const turn = { ...ctx(), sessionId: 'ses_turn_batch_cap', signal: new AbortController().signal }
    await gen({ prompts: ['a', 'b', 'c', 'd'] }, turn)
    await gen({ prompts: ['e', 'f', 'g', 'h'] }, turn)
    // 8 used: 3 more would be 11.
    await expect(gen({ prompts: ['i', 'j', 'k'] }, turn)).rejects.toThrow('Image limit for this turn reached (10 images; 8 used, 3 asked).')
    expect(calls).toHaveLength(8)
    // Exactly 10 is allowed; then nothing.
    await gen({ prompts: ['i', 'j'] }, turn)
    expect(calls).toHaveLength(10)
    await expect(gen({}, turn)).rejects.toThrow('Image limit for this turn reached')
    // Two calls of one step, as pi runs them in parallel: the caps count before either awaits.
    const step = { ...turn, signal: new AbortController().signal }
    const both = await Promise.allSettled([gen({ prompts: ['1', '2', '3', '4'] }, step), gen({ prompts: ['5', '6', '7', '8'] }, step), gen({ prompts: ['9', '10', '11'] }, step)])
    expect(both.map((settled) => settled.status)).toEqual(['fulfilled', 'fulfilled', 'rejected'])
    expect(calls).toHaveLength(18)
  })

  test('the turn cap keys on context.turnId when the harness names it: calls with fresh signals in one turn share it', async () => {
    gateway()
    // pi gives each call a codemode script makes its own abort signal; the turn id stays the same.
    const call = (turnId: string) => ({ ...ctx(), sessionId: 'ses_turn_id_cap', turnId, signal: new AbortController().signal })
    await gen({ prompts: ['a', 'b', 'c', 'd'] }, call('msg_turn_1'))
    await gen({ prompts: ['e', 'f', 'g', 'h'] }, call('msg_turn_1'))
    await expect(gen({ prompts: ['i', 'j', 'k'] }, call('msg_turn_1'))).rejects.toThrow('Image limit for this turn reached (10 images; 8 used, 3 asked).')
    expect(calls).toHaveLength(8)
    // The next turn starts again.
    await gen({ prompts: ['i', 'j', 'k'] }, call('msg_turn_2'))
    expect(calls).toHaveLength(11)
  })

  test('the fifty-first image in one session is refused, and a batch that would pass it', async () => {
    gateway()
    const session = () => ({ ...ctx(), sessionId: 'ses_session_cap' })
    for (let i = 0; i < 12; i++) await gen({ prompts: ['a', 'b', 'c', 'd'] }, session())
    await expect(gen({ prompts: ['a', 'b', 'c'] }, session())).rejects.toThrow('Image limit for this session reached (50 images; 48 used, 3 asked).')
    await gen({ prompts: ['a', 'b'] }, session())
    await expect(gen({}, session())).rejects.toThrow('Image limit for this session reached')
    expect(IMAGE_GEN_SESSION_LIMIT).toBe(50)
    expect(calls).toHaveLength(50)
  })

  test('a non-image or out-of-workspace reference is refused', async () => {
    gateway()
    const outside = mkdtempSync(join(tmpdir(), 'pi-kortix-outside-'))
    try {
      writeFileSync(join(dir, '.env'), 'SECRET=1')
      symlinkSync('/etc/passwd', join(dir, 'passwd.png'))
      writeFileSync(join(outside, 'x.png'), PNG)
      symlinkSync(join(outside, 'x.png'), join(dir, 'link.png'))
      writeFileSync(join(dir, 'text.png'), 'not an image at all')
      const relative = join('..', outside.split('/').pop()!, 'x.png')
      for (const path of ['.env', 'passwd.png', 'link.png', relative, join(outside, 'x.png'), 'text.png']) {
        await expect(gen({ action: 'edit', reference_images: [path] })).rejects.toThrow(path)
      }
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('a reference over 20 MiB is refused', async () => {
    gateway()
    writeFileSync(join(dir, 'big.png'), PNG)
    truncateSync(join(dir, 'big.png'), 20 * MiB + 1)
    await expect(gen({ action: 'edit', reference_images: ['big.png'] })).rejects.toThrow('Reference image big.png is larger than 20 MiB.')
    expect(calls).toHaveLength(0)
  })

  test('reference images over 50 MiB in total are refused', async () => {
    gateway()
    const names = ['a.png', 'b.png', 'c.png']
    for (const name of names) {
      writeFileSync(join(dir, name), PNG)
      truncateSync(join(dir, name), 18 * MiB)
    }
    await expect(gen({ action: 'edit', reference_images: names })).rejects.toThrow('Reference images are larger than 50 MiB in total.')
    expect(calls).toHaveLength(0)
  })

  test('a reference whose bytes do not match its extension is refused', async () => {
    gateway()
    writeFileSync(join(dir, 'photo.jpg'), PNG)
    writeFileSync(join(dir, 'pic.webp'), JPEG)
    await expect(gen({ action: 'edit', reference_images: ['photo.jpg'] })).rejects.toThrow('Reference image photo.jpg is not a jpeg image.')
    await expect(gen({ action: 'edit', reference_images: ['pic.webp'] })).rejects.toThrow('Reference image pic.webp is not a webp image.')
    expect(calls).toHaveLength(0)
  })

  test('a symlinked output or output/images that leaves the workspace is refused before any request', async () => {
    gateway()
    const outside = mkdtempSync(join(tmpdir(), 'pi-kortix-outside-'))
    try {
      symlinkSync(outside, join(dir, 'output'))
      await expect(gen()).rejects.toThrow('output/images is outside the workspace.')
      rmSync(join(dir, 'output'))
      mkdirSync(join(dir, 'output'))
      symlinkSync(outside, join(dir, 'output', 'images'))
      await expect(gen()).rejects.toThrow('output/images is outside the workspace.')
      expect(calls).toHaveLength(0)
      expect(readdirSync(outside).filter((name) => name.endsWith('.png'))).toEqual([])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('each file is named after its prompt inside output/images and never replaces a file', async () => {
    gateway()
    setSystemTime(new Date('2026-10-28T10:30:00Z'))
    try {
      mkdirSync(imagesDir(), { recursive: true })
      writeFileSync(join(imagesDir(), 'cube-20261028-103000.png'), 'mine')
      // A path in a prompt is only text: its slug never leaves output/images. `output_name` is not read.
      const result = await genJson({ prompts: ['cube', 'cube', '../../kortix.yaml', '.git/hooks/pre-commit'], output_name: '../kortix.yaml' })
      expect(result.images.map((image: { path: string }) => image.path)).toEqual([
        join(imagesDir(), 'cube-20261028-103000-2.png'),
        join(imagesDir(), 'cube-20261028-103000-3.png'),
        join(imagesDir(), 'kortix-yaml-20261028-103000.png'),
        join(imagesDir(), 'git-hooks-pre-commit-20261028-103000.png'),
      ])
      expect(readFileSync(join(imagesDir(), 'cube-20261028-103000.png'), 'utf8')).toBe('mine')
      expect(readdirSync(dir).sort()).toEqual(['output'])
    } finally {
      setSystemTime()
    }
  })

  test('the output is a small JSON object with paths and never the image bytes', async () => {
    gateway()
    const text = out(await gen({ prompts: ['x', 'y'] }))
    expect(text).not.toContain(PNG.toString('base64'))
    const result = JSON.parse(text)
    expect(Object.keys(result).sort()).toEqual(['action', 'images', 'model', 'provider'])
    expect(result.images.map((image: Record<string, unknown>) => Object.keys(image).sort())).toEqual([
      ['path', 'prompt', 'size'],
      ['path', 'prompt', 'size'],
    ])
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

  test('a scrape the provider answers late still reaches the tool: the cap covers the provider envelope', async () => {
    // Firecrawl documents its own `timeout` up to 60000ms and answers past it
    // when engines cascade. A tool cap below that envelope turns a
    // slow-but-successful scrape into a tool timeout. Scale the tool's cap
    // 50x down so this runs in ~2s: the router answers at 1000ms, a 35s cap
    // aborts at 700ms, the shipped cap (1.8s) waits and the call is made once.
    const native = AbortSignal.timeout
    const patched = AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }
    patched.timeout = (ms) => native(Math.round(ms / 50))
    try {
      router(async (call) => {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        return page(call.body.url)
      })
      const result = JSON.parse(out(await scrapeWebpage.execute({ urls: 'https://slow.example.test/page' }, ctx())))
      expect(result).toMatchObject({ url: 'https://slow.example.test/page', success: true, title: 'T' })
      expect(calls).toHaveLength(1)
    } finally {
      patched.timeout = native
    }
  })
})

describe('the Kortix tools follow the capability of what they do', () => {
  const rule = (policy: unknown, tool: string, args: unknown = {}) => new PermissionBroker('ses_test', '/workspace', () => {}, compilePermissionPolicy(policy)).rule(tool, args)

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
    const broker = new PermissionBroker('ses_test', '/workspace', () => {}, compilePermissionPolicy({ edit: 'ask', read: 'ask' }))
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

  test('an empty items value ("null", "[]") beside a single item shows that item', async () => {
    writeFileSync(join(dir, 'SKILL.md'), '# skill')
    for (const items of ['null', '[]']) {
      const result = JSON.parse(out(await show({ type: 'file', path: 'SKILL.md', theme: 'success', items })))
      expect(result.entry).toMatchObject({ type: 'file', path: join(dir, 'SKILL.md'), theme: 'success' })
    }
    await expect(show({ items: 'null' })).rejects.toThrow("'type' is required.")
  })
})

describe('each Kortix tool is one self-contained module (what `kortix tools eject` copies)', () => {
  const kortixDir = join(import.meta.dir, '../services/tools/kortix')
  const modules = { web_search: webSearch, image_search: imageSearch, image_gen: imageGen, scrape_webpage: scrapeWebpage, memory: memoryTool, show: showTool }

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
