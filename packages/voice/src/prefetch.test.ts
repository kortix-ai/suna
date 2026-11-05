import { afterEach, beforeEach, expect, test, vi } from 'bun:test'
import { prefetch } from './prefetch'

// A card's exact fact that lands late still beats the search snippets landing with it: the one-provider search beside
// the router settled sooner than the card's rate, and "How many US dollars is one Canadian dollar?" got the snippet.
const originalFetch = globalThis.fetch
const keys = ['GROQ_API_KEY', 'TAVILY_API_KEY', 'SERPER_API_KEY', 'FIRECRAWL_API_KEY', 'VOICE_ROUTE', 'VOICE_MODELS_URL', 'KORTIX_API_URL', 'KORTIX_TOKEN', 'KORTIX_LLM_BASE_URL']
let saved: (string | undefined)[]
beforeEach(() => {
  saved = keys.map((k) => process.env[k])
  for (const k of keys) delete process.env[k]
  process.env.GROQ_API_KEY = 'test-only'
  process.env.SERPER_API_KEY = 'test-only'
})
afterEach(() => {
  vi.useRealTimers()
  globalThis.fetch = originalFetch
  keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i] })
})

test('a late card fact wins over search snippets that land with it', async () => {
  vi.useFakeTimers()
  const requested = Promise.withResolvers<void>()
  const primary = Promise.withResolvers<Response>()
  const search = Promise.withResolvers<Response>()
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes('api.groq.com')) return Response.json({ choices: [{ message: { content: JSON.stringify({ need: 'web', query: 'CAD to USD exchange rate', card: { type: 'fx', from: 'CAD', to: 'USD' } }) } }] })
    if (url.includes('open.er-api.com')) { requested.resolve(); return primary.promise }
    if (url.includes('google.serper.dev')) return search.promise
    throw new Error(`unexpected provider ${url}`)
  }, { preconnect: originalFetch.preconnect })
  const pending = prefetch('How many US dollars is one Canadian dollar?', 'late-card-regression')
  await requested.promise
  vi.advanceTimersByTime(1000)
  primary.resolve(Response.json({ rates: { USD: 0.72 } }))
  search.resolve(Response.json({ organic: [{ title: 'Exchange estimates', link: 'https://example.test/rates', snippet: 'This estimate is not a live quote.' }] }))
  expect(await pending).toContain('1 CAD = 0.72 USD')
})
