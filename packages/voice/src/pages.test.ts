import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readPages } from './pages'

// The pages read behind a web search cost what they are worth: through the Kortix router a page read is Firecrawl's
// scrape at $0.01, and the two read behind every search were most of a dev call's search spend. Through the router the
// top result is read; with the vendors' own keys, the top two.
const originalFetch = globalThis.fetch
const keys = ['KORTIX_API_URL', 'KORTIX_TOKEN', 'FIRECRAWL_API_KEY', 'TAVILY_API_KEY', 'VOICE_PAGES']
let saved: (string | undefined)[]
let scraped: string[]
beforeEach(() => {
  saved = keys.map((k) => process.env[k])
  for (const k of keys) delete process.env[k]
  scraped = []
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = JSON.parse(String(init?.body)) as { url?: string; urls?: string[] }
    scraped.push(body.url ?? body.urls?.[0] ?? String(input))
    return Response.json({ data: { markdown: 'A page. '.repeat(60) }, results: [{ raw_content: 'A page. '.repeat(60) }] })
  }, { preconnect: originalFetch.preconnect })
})
afterEach(() => {
  globalThis.fetch = originalFetch
  keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i] })
})
const results = (host: string) => ['One', 'Two', 'Three'].map((t) => `${t} (https://${host}/${t.toLowerCase()}): snippet`).join('\n')
const settle = () => new Promise((r) => setTimeout(r, 30))

test('through the Kortix router, only the top result is read', async () => {
  process.env.KORTIX_API_URL = 'https://router.example.test'
  process.env.KORTIX_TOKEN = 'test-only'
  readPages(results('router.example.test'))
  await settle()
  expect([...new Set(scraped)]).toEqual(['https://router.example.test/one'])
})

test("with the vendors' own keys, the top two are read", async () => {
  process.env.FIRECRAWL_API_KEY = 'test-only'
  process.env.TAVILY_API_KEY = 'test-only'
  readPages(results('vendor.example.test'))
  await settle()
  expect([...new Set(scraped)].sort()).toEqual(['https://vendor.example.test/one', 'https://vendor.example.test/two'])
})
