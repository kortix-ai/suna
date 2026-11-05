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

// The search kept ready for an agent's turn (cascade standby(): the caller's words, searched as they are) searches only
// words that can be searched. On a dev call "You decide." raced three providers and read two pages, $0.03 for nothing.
test('a hand-back is never searched as it is; a request naming what to search is', async () => {
  const hosts: string[] = []
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input instanceof Request ? input.url : input)
    hosts.push(new URL(url).hostname)
    if (url.includes('google.serper.dev')) return Response.json({ organic: [{ title: 'Used hybrids in Serbia', link: 'https://example.test/a', snippet: 'Toyota Auris hybrids from 9,000 euros.' }] })
    return new Response('', { status: 404 })
  }, { preconnect: originalFetch.preconnect })
  for (const words of ['You decide.', 'Okay, go ahead.', 'Yes.']) expect(await prefetch(words, 'User: Can you write some python code?', undefined, true)).toBe('')
  expect(hosts.filter((h) => h === 'google.serper.dev')).toEqual([])
  expect(await prefetch('Search for used hybrid cars in Serbia', '', undefined, true)).toContain('hybrid')
  expect(hosts).toContain('google.serper.dev')
})
