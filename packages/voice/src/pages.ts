// Pages behind web search results, read in the background and kept for later turns: src/prefetch.ts reads the top
// results of every search and attaches pages on the topic; src/cascade.ts gives a quiet moment the pages read since.
import { norm } from './lang'
import { chargeSearch } from './cost'
import { router, routed } from './models'

const STOP = new Set('the and you can what whats what\'s does did how who when where which that this there are was were for with about tell please could would right now just know want wanted ask like okay hey yeah well into from out get got your our its his her their them they then than also some any much many more most very really sure think going'.split(' '))
/** A query's content words (three letters or more, no stop words). */
export const content = (q: string) => new Set((norm(q).match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w)))

/** The first non-empty result of several jobs ('' when all come back empty). */
export function firstUseful(jobs: Promise<string>[]): Promise<string> {
  return new Promise((resolve) => {
    let pending = jobs.length
    const settle = (value: string) => { if (value) resolve(value); else if (!--pending) resolve('') }
    for (const job of jobs) job.then(settle, () => settle(''))
  })
}

// The pages behind a search's top results, read in the background the moment it returns: a follow-up ("read it",
// "what does it say", "tell me more") is answered from the page in hand instead of the agent fetching it (7.2 s in
// a live call), and later turns on the topic carry the text, not just snippets. Firecrawl and Tavily race per page;
// no turn ever waits for a page. VOICE_PAGES sets how many (0: off). Through the Kortix router the top result alone: a
// page read there is Firecrawl's scrape at $0.01 (no Tavily extract), about twelve times the vendor's price, and two of
// them were most of a dev call's search spend ($0.02 of a web turn's $0.021-0.031).
const pages = () => Number(process.env.VOICE_PAGES ?? (router() ? 1 : 2))
type Page = { at: number; url: string; text: string }
const reading = new Set<string>()
const read: Page[] = [] // pages in hand, newest last
export function readPages(result: string) {
  for (const url of [...result.matchAll(/\((https?:\/\/[^\s)]+)\)/g)].map((m) => m[1]!).slice(0, pages())) {
    if (reading.has(url) || read.some((p) => p.url === url && Date.now() - p.at < PAGE_TTL)) continue
    reading.add(url)
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 15_000)
    firstUseful([scrape(url, ac.signal).catch(() => ''), extract(url, ac.signal).catch(() => '')]).then((text) => {
      clearTimeout(timer)
      ac.abort()
      reading.delete(url)
      if (text.trim().length < 200) return
      read.push({ at: Date.now(), url, text: text.replace(/\s+/g, ' ').slice(0, 6000) })
      if (read.length > 20) read.shift()
    })
  }
}
const PAGE_TTL = 10 * 60_000
async function scrape(url: string, signal: AbortSignal): Promise<string> {
  const to = routed('firecrawl', '/v2/scrape') ?? (process.env.FIRECRAWL_API_KEY ? { url: 'https://api.firecrawl.dev/v2/scrape', headers: { Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}` } } : undefined)
  if (!to) return ''
  const res = await fetch(to.url, { method: 'POST', signal, headers: { ...to.headers, 'content-type': 'application/json' }, body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }) })
  if (res.ok) chargeSearch('firecrawl-scrape')
  return ((await res.json()) as { data?: { markdown?: string } }).data?.markdown ?? ''
}
async function extract(url: string, signal: AbortSignal): Promise<string> {
  if (router() || !process.env.TAVILY_API_KEY) return '' // the router serves Tavily's search only: Firecrawl's scrape reads the page there
  const res = await fetch('https://api.tavily.com/extract', { method: 'POST', signal, headers: { Authorization: `Bearer ${process.env.TAVILY_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ urls: [url] }) })
  if (res.ok) chargeSearch('tavily-extract')
  return ((await res.json()) as { results?: { raw_content?: string }[] }).results?.[0]?.raw_content ?? ''
}
// A page is untrusted text: it can neither close its <data> envelope nor end its url attribute.
const block = (p: Page) => `<data source="page, read in full" url="${p.url.replace(/"/g, '&quot;')}">\n${p.text.replace(/<\/?data\b[^>]*>/gi, '').slice(0, 4000)}\n</data>`
/** Pages on this query read after `since` (ms epoch), as data: what a quiet moment after the answer can add. */
export function freshPages(q: string, since: number): string {
  return pagesFor(q).filter((p) => p.at > since).map(block).join('\n')
}
/** The page for a live answer, as data: the best one only (two put 8000 characters in front of the fast lane: first token
 * ~320 ms against ~235 with one, ~175 with none). */
export const pageBlocks = (q: string) => pagesFor(q).slice(0, 1).map(block).join('\n')
/** The best page read behind these search results (their addresses, in their order), as data, or ''. A look-ahead's
 * results point at the page its question needs ("What are the new features in Bun 1.4.4?": the release post), read a
 * second after its search; the follow-up its match answers ("What changed in it?") shares too few words with it
 * for pagesFor, and was answered from snippets: "The 1.4.4 release notes aren't in the data I have" in 82 of 188 real
 * runs, a made-up change ("--experimental-strip-types", a Node flag) in others. */
export function pagesOf(result: string): string {
  const urls = [...result.matchAll(/\((https?:\/\/[^\s)]+)\)/g)].map((m) => m[1]!)
  const p = urls.map((u) => read.find((x) => x.url === u && Date.now() - x.at < PAGE_TTL)).find((x) => x && !result.includes(`url="${x.url}"`))
  return p ? block(p) : ''
}
/** Pages in hand that share two or more content words with the query (in their address or opening), best first. */
export function pagesFor(q: string): Page[] {
  const want = content(q)
  return read
    .filter((p) => Date.now() - p.at < PAGE_TTL)
    .map((p) => ({ p, n: [...content(`${p.url.replace(/[\W_]+/g, ' ')} ${p.text.slice(0, 400)}`)].filter((w) => want.has(w)).length }))
    .filter((x) => x.n >= 2)
    .sort((a, b) => b.n - a.n)
    .slice(0, 2)
    .map((x) => x.p)
}
