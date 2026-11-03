// Retrieval before the agent's turn, by rules, no model (RESEARCH.md §3.14). A spoken question that needs
// the web or the workspace costs the agent two model passes (decide on a tool, then answer: +1.6–3 s,
// measured); with the snippets already in its turn instructions it can answer in one. Whatever does not
// arrive within the budget is dropped, and the agent still has its own tools.
import { norm } from './lang'
import { chargeSearch } from './cost'
import { basename } from 'node:path'
import { CARD_HOSTS, card } from './cards'
import * as source from './cards' // filled() read off it: a stand-in card source (the proofs') has only card()
import { type Card, decided, route } from './route'
import { asking, heard, judge, provide, routing } from './judge'
import { lookup as chunks, namedFiles, repoMap } from './workspace'
import { content, firstUseful, pageBlocks, readPages } from './pages'
import { router, routed } from './models'

// Web answers take ~1.0–1.7 s, still far less than the agent's own search (9.4 s on a fresh session, measured).
const BUDGET = Number(process.env.VOICE_PREFETCH_MS ?? 2000)

const repo = process.env.VOICE_WORKSPACE ?? process.env.KORTIX_WORKSPACE

// Web search, non-blocking (RESEARCH.md §3.17): providers race and the first usable result wins (a hedged
// request); results are cached by what is asked (TTL); a search can start while the user is still talking (warm)
// and the final question reuses it when it adds no new content word.
// Cache lifetimes by what is asked (answers held steady for minutes in repeat queries; live prices drifted 0.8–1.4%
// within a minute, a finished game's result page flipped once at ~11 min, measured).
const TTL: [RegExp, number][] = [
  [/\b(price|cost|stock|bitcoin|crypto|exchange rate|live|score|cen[aeu]|kurs)\b/i, 60_000],
  [/\b(news|won|winner|game|match|result|vesti)\b/i, 10 * 60_000],
  [/\b(weather|forecast|temperature|rain|vreme|prognoz\w*)\b/i, 15 * 60_000],
  [/\b(version|release[ds]?|update[ds]?|latest|newest|verzij\w*)\b/i, 30 * 60_000],
]
const ttl = (key: string) => TTL.find(([re]) => re.test(key))?.[1] ?? 24 * 3600_000
const searches = new Map<string, { at: number; words: Set<string>; result: Promise<string> }>()

/** Starts the web search for words still being spoken; prefetch() picks it up if the question ends the same. */
export function warm(q: string, context = '') {
  if (content(q).size < 2) return
  // The judge (src/judge.ts): the rules' card at once, then the router's verdict on the same words, which overrides it;
  // either way the card's data is fetched now, for the fast lane to start on at the transcript.
  const n = asking()
  const ruled = judge(q)
  if (ruled) heard(n, context, primaryOf(ruled), q, ruled)
  void route(q, context, projectFor(q)).then((r) => {
    if (!r) return // no verdict: the rules' stands
    const c = r.need === 'web' ? r.card : undefined
    heard(n, context, c && primaryOf(c), q, c)
    if (!c && r.need === 'web') search(r.query)
  })
}

// Card answers, cached a minute (the words still being spoken fetch it; the finished question finds it here).
const cards = new Map<string, { at: number; result: Promise<string | undefined> }>()
// A card's data exactly as prefetch() returns it (the judge compares the two byte for byte).
const primaryOf = (c: Card) => cardOf(c).then((data) => (data ? `<data source="${c.type}: a primary source, exact: say it plainly, no hedge">\n${data}\n</data>` : ''))
provide(primaryOf)
routing((q, context) => void route(q, context, projectFor(q)).catch(() => {})) // the words while they are said
function cardOf(c: Card): Promise<string | undefined> {
  const key = JSON.stringify(c).toLowerCase()
  const hit = cards.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.result
  const result = card(c).catch(() => undefined)
  cards.set(key, { at: Date.now(), result })
  result.then((r) => { if (!r && cards.get(key)?.result === result) cards.delete(key) })
  // What the line lacks comes behind it (src/cards.ts filled(): an npm version's release date): this answer is not held
  // for it, the next turn that reads the card has it.
  void result.then((r) => r && source.filled?.(c, r)).then((full) => { const hit = cards.get(key); if (full && hit?.result === result) cards.set(key, { at: hit.at, result: Promise.resolve(full) }) }, () => {})
  return result
}

function search(q: string): Promise<string> {
  const key = norm(q).replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim()
  const hit = searches.get(key)
  if (hit && Date.now() - hit.at < ttl(key)) return hit.result
  const result = race(q)
  searches.set(key, { at: Date.now(), words: content(q), result })
  result.then((r) => r || searches.delete(key))
  return result
}

/** A search started for these words or words they add nothing to (a question still being spoken, or one looked up
 * ahead because the call was likely to get there: src/anticipate.ts), within a minute and the topic's lifetime. */
function reuse(q: string): Promise<string> | undefined {
  const want = content(q)
  for (const [key, s] of [...searches].reverse()) {
    if (Date.now() - s.at > Math.min(60_000, ttl(key))) continue
    const extra = [...want].filter((w) => !s.words.has(w)).length
    const shared = [...want].filter((w) => s.words.has(w)).length
    if (extra === 0 && shared >= 2) return s.result
  }
}


// The providers, raced, the first usable result wins: Tavily, Serper (Google results) and Firecrawl. Alone each
// is ~1.26–1.35 s p50, 2.0–3.1 s p90; raced, 1.14 s / 1.48 s with the fact in the data 81% (n = 21, measured).
async function race(q: string): Promise<string> {
  const ac = new AbortController()
  const tries = [tavily(q, ac.signal), serper(q, ac.signal), firecrawl(q, ac.signal)].map((p) => p.catch(() => ''))
  const first = await new Promise<string>((resolve) => {
    let left = tries.length
    for (const t of tries) t.then((r) => (r ? resolve(r) : --left || resolve('')))
  })
  ac.abort()
  if (first) readPages(first)
  return first
}


async function serper(q: string, signal: AbortSignal): Promise<string> {
  const to = routed('serper', '/search') ?? (process.env.SERPER_API_KEY ? { url: 'https://google.serper.dev/search', headers: { 'X-API-KEY': process.env.SERPER_API_KEY } } : undefined)
  if (!to) return ''
  const res = await fetch(to.url, { method: 'POST', signal, headers: { ...to.headers, 'content-type': 'application/json' }, body: JSON.stringify({ q, num: 5 }) })
  if (res.ok) chargeSearch('serper') // answered: billed, even when another provider wins the race
  type R = { answerBox?: { answer?: string; snippet?: string; title?: string }; knowledgeGraph?: { title?: string; description?: string }; organic?: { title: string; link: string; snippet?: string; date?: string }[] }
  const { answerBox: a, knowledgeGraph: k, organic = [] } = (await res.json()) as R
  return [
    a && `answer: ${[a.title, a.answer ?? a.snippet].filter(Boolean).join(': ')}`,
    k?.description && `${k.title}: ${k.description}`,
    ...organic.slice(0, 3).map((r) => `${r.title} (${r.link})${r.date ? ` ${r.date}` : ''}: ${(r.snippet ?? '').slice(0, 300)}`),
  ].filter(Boolean).join('\n')
}

async function tavily(q: string, signal: AbortSignal): Promise<string> {
  const to = routed('tavily', '/search') ?? (process.env.TAVILY_API_KEY ? { url: 'https://api.tavily.com/search', headers: { Authorization: `Bearer ${process.env.TAVILY_API_KEY}` } } : undefined)
  if (!to) return ''
  const res = await fetch(to.url, {
    method: 'POST',
    signal,
    headers: { ...to.headers, 'content-type': 'application/json' },
    // Basic depth, no answer: Tavily's own answer added ~1 s and was right 52% of the time, the agent reads the
    // snippets better; "fast" and "ultra-fast" (0.4–0.7 s) had the fact 29–33% of the time (n = 21, measured).
    body: JSON.stringify({ query: q, search_depth: 'basic', max_results: 5 }),
  })
  if (res.ok) chargeSearch('tavily')
  const { results = [] } = (await res.json()) as { results?: { title: string; url: string; content: string }[] }
  return results.map((r) => `${r.title} (${r.url}): ${r.content.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n')
}

async function firecrawl(q: string, signal: AbortSignal): Promise<string> {
  const to = routed('firecrawl', '/v2/search') ?? (process.env.FIRECRAWL_API_KEY ? { url: 'https://api.firecrawl.dev/v2/search', headers: { Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}` } } : undefined)
  if (!to) return ''
  const res = await fetch(to.url, { method: 'POST', signal, headers: { ...to.headers, 'content-type': 'application/json' }, body: JSON.stringify({ query: q, limit: 5 }) })
  if (res.ok) chargeSearch('firecrawl')
  const web = ((await res.json()) as { data?: { web?: { title: string; url: string; description?: string }[] } }).data?.web ?? []
  return web.map((r) => `${r.title} (${r.url}): ${(r.description ?? '').slice(0, 300)}`).join('\n')
}

const HOSTS = () => [...((r = router()) => (r ? [`${r.base}/health`] : ['https://api.tavily.com/', 'https://google.serper.dev/', 'https://api.firecrawl.dev/']))(), ...CARD_HOSTS]
let warmed = 0
/** Opens (or keeps open) the connections to the search providers: a new one costs ~0.4 s (measured). Cheap to call often. */
export function preconnect() {
  if (Date.now() - warmed < 45_000) return
  warmed = Date.now()
  for (const h of HOSTS()) fetch(h, { method: 'HEAD' }).catch(() => {})
}


// The workspace: the code chunks that answer the question best (src/workspace.ts).
const code = (q: string) => (repo ? chunks(repo, q) : '')

// A question about the repo's state is answered by git, not by its code: "Is my repo in a clean state?" got code chunks
// and the agent said "Everything is clean and committed." in a folder that was not a git repository (traced drive call,
// 2026-11-01). Its status and last commits are read here, read-only, in ~10-30 ms.
const GIT = /\b(git|clean|dirty|uncommitted|commit(s|ted)?|branch(es)?|diff|changed|changes|modified|staged|stash(ed)?|pushed|merged?|status|recent(ly)?|lately)\b/i
async function git(root: string): Promise<string> {
  const run = async (args: string[]) => {
    const p = Bun.spawn(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    return (await p.exited) === 0 ? out.trim() : `!${err.trim()}`
  }
  const status = await run(['status', '--short', '--branch'])
  if (status.startsWith('!')) return /not a git repository/i.test(status) ? 'This folder is not a git repository: there is no status or history to read.' : ''
  const lines = status.split('\n')
  const changed = lines.slice(1)
  const log = await run(['log', '-5', '--format=%h %ar %s'])
  return [
    `branch: ${lines[0]!.replace(/^## /, '')}`,
    changed.length ? `${changed.length} changed or untracked file(s):\n${changed.slice(0, 25).join('\n')}${changed.length > 25 ? '\n…' : ''}` : 'working tree clean: nothing changed, nothing untracked',
    log.startsWith('!') ? 'no commits yet' : `last commits:\n${log}`,
  ].join('\n')
}

/** The repo map for a call's first workspace question ('' without a workspace). */
export const workspaceMap = () => (repo ? repoMap(repo) : '')

// What the router is told the workspace is: its folder name and the package's description.
const project = repo ? [basename(repo), (() => { try { return JSON.parse(require('node:fs').readFileSync(`${repo}/package.json`, 'utf8')).description ?? '' } catch { return '' } })()].filter(Boolean).join(': ') : ''

// And the files of it the words name: "What does the cascade file do?" was routed none (the router had only the name and
// description, and "cascade" read as a general idea), and the agent's opener made up what it does (bench/namedfile-proof.ts).
// Only then is the description longer: every other turn's prompt is as it was.
// The index is looked at only when the words could name a file ("file", "module", "script", an extension): its rebuild
// (~150 ms, every 30 s) never lands on an ordinary turn's routing.
const projectFor = (q: string) => {
  const files = repo && /\b(file|module|script)\b|\w\.\w{1,4}\b|\bdot\s+[a-z]{1,4}\b/i.test(q) ? namedFiles(repo, q) : []
  return files.length ? `${project}; the turn names its file ${files.slice(0, 3).join(', ')}` : project
}

/** Where this turn's lookup goes, if the router has decided ('' while it has not, or for none). */
export const lookup = (q: string, context = ''): 'web' | 'code' | 'clarify' | '' => {
  const n = decided(q, context)
  return n === 'none' ? '' : n
}

// One deadline for routing and retrieval, and no orphaned timeout after a fast result.
function within<T>(job: Promise<T>, ms: number): Promise<T | undefined> {
  const { promise, resolve } = Promise.withResolvers<T | undefined>()
  const timer = setTimeout(() => resolve(undefined), Math.max(0, ms))
  job.then((value) => { clearTimeout(timer); resolve(value) }, () => { clearTimeout(timer); resolve(undefined) })
  return promise
}

// What a release changed, as the router's query says it (any language the router writes its English query in).
const CHANGES = /\b(change[sd]?|changelog|new features?|what'?s new|release notes|fixe[sd]|improvements?)\b/i

/** What to retrieve for this utterance, fetched within the budget; '' when nothing applies. */
export async function prefetch(q: string, context = '', mark?: (stage: 'routed') => void, words = false, ahead = false): Promise<string> {
  const deadline = performance.now() + BUDGET
  const remaining = () => Math.max(0, deadline - performance.now())
  // The words themselves are searched at once, beside the router: a web turn no longer waits for routing, then search
  // (and a turn routed to no lookup has it ready if the agent reaches for the web itself).
  const searching = !!(process.env.TAVILY_API_KEY || process.env.SERPER_API_KEY || process.env.FIRECRAWL_API_KEY)
  // ahead: a question looked up before it is asked (src/anticipate.ts) waits for its route; no extra search on its words.
  const raw = searching && !ahead && content(q).size >= 2 ? search(q) : undefined
  // words: a search on the words themselves, no routing (the agent is about to search on its own; ours is faster).
  const r = words ? { need: 'web' as const, query: q } : await within(route(q, context, projectFor(q)), remaining())
  if (!words) mark?.('routed')
  if (!r || r.need === 'none') return ''
  if (r.need === 'clarify') return `<data source="missing information">\n${r.query}\n</data>`
  if (r.need === 'code') {
    const state = repo && GIT.test(`${q} ${r.query}`) ? await git(repo).catch(() => '') : ''
    const data = code(`${q} ${r.query}`)
    // Named: the workspace is one project (this machine's), not whatever repository the call talks about. Unnamed, the
    // voice-agent's own git log answered "categorize what is being pushed" right after the agent had opened another repo.
    const of = basename(repo ?? '')
    return [state && `<data source="git of ${of}, read just now">\n${state}\n</data>`, data && `<data source="workspace: ${of}">\n${data}\n</data>`].filter(Boolean).join('\n')
  }
  const hasSearch = !!(process.env.TAVILY_API_KEY || process.env.SERPER_API_KEY || process.env.FIRECRAWL_API_KEY)
  let fallback: Promise<string> | undefined
  const searchNow = () => fallback ??= hasSearch ? (raw ? firstUseful([words ? raw : reuse(r.query) ?? search(r.query), raw]) : reuse(r.query) ?? search(r.query)) : Promise.resolve('')
  const web = async () => {
    const data = await searchNow()
    const found = data ? `<data source="web search" query="${r.query.replace(/"/g, "'")}">\n${data.replace(/<\/?data\b[^>]*>/gi, '')}\n</data>` : '' // untrusted: cannot close its envelope
    return [found, pageBlocks(`${q} ${r.query}`)].filter(Boolean).join('\n')
  }
  const job = async () => {
    if (r.card) {
      // Prefer exact primary facts briefly, but keep a late primary eligible while search is pending.
      const primary = primaryOf(r.card)
      const hedge = hasSearch ? setTimeout(searchNow, 250) : undefined
      let got: string | undefined
      try { got = await within(primary, Math.min(800, remaining())) }
      finally { clearTimeout(hedge) }
      // A version card holds the number and its date, not what changed: a question about the release's changes or new
      // features ("What changed in it?", routed as "Bun 1.4.4 changes" with Bun's card) gets the search beside it. With the
      // card alone the answer was "I don't have the specific changelog for Bun 1.4.4" (a traced real round).
      if (got && r.card.type === 'version' && CHANGES.test(r.query)) return [got, await web()].filter(Boolean).join('\n')
      if (got) return got
      return firstUseful([primary, web()])
    }
    return web()
  }
  // Past the turn's deadline, read-only work may finish into the cache for a follow-up.
  return await within(job(), remaining()) ?? ''
}
