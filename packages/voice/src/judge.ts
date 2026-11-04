// The realtime judge: what a turn will look up, known before the router has decided. Two sources, both instant: rules
// that read the card a question asks for (weather, price, rate, version, F1) from its words, or from the last lookup
// for a follow-up ("And ethereum?" after bitcoin's price), and the router's verdict on the words still being spoken
// (src/prefetch.ts warm()). The card's data is fetched at once and the fast lane starts on it beside the router
// (~160-190 ms on gpt-oss-20b, floor runs 2026-11-01); its words are kept only when the router's route brings the same
// data, so a rule that misreads a question costs a wasted fetch, never a wrong answer. English words only: anything
// else waits for the router as before. A module of its own, so a proof that mocks the prefetch module still loads.
import type { Card } from './route'

const WEATHER = /\b(weather|forecast|temperature|rain(ing|y)?|snow(ing)?|sunny|cloudy|umbrella|degrees|how (hot|cold|warm))\b/i
const NOT_PLACE = /^(january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|celsius|fahrenheit|the|my|our|this|that|it|i)$/i
// A capitalized name after in/for/at ("in Porto", "for New York"), up to three words.
const PLACE = /\b(?:in|for|at)\s+((?:[A-Z][\p{L}'’-]+)(?:\s+[A-Z][\p{L}'’-]+){0,2})/u
const FOLLOW = /^\s*(?:and|what about|how about|also|ok(?:ay)?,? (?:and|what about))\b[\s,]*(?:(?:in|for|at|the)\s+)?(.*?)[\s?.!]*$/i
const ASSETS: Record<string, string> = {
  bitcoin: 'bitcoin', btc: 'bitcoin', ethereum: 'ethereum', ether: 'ethereum', eth: 'ethereum', solana: 'solana', sol: 'solana',
  dogecoin: 'dogecoin', doge: 'dogecoin', cardano: 'cardano', ada: 'cardano', ripple: 'ripple', xrp: 'ripple', litecoin: 'litecoin',
  polkadot: 'polkadot', tron: 'tron', chainlink: 'chainlink', 'shiba inu': 'shiba-inu', tether: 'tether',
  bitkoin: 'bitcoin', bitkoina: 'bitcoin', bitkoinu: 'bitcoin', eterijum: 'ethereum', eterijuma: 'ethereum',
}
const PRICE = /\b(price|prices|worth|trading|cost|how much is|how much's|what's .+ at|value|cena|cene|cenu|koliko (je|ko[sš]ta|vredi)|vredi)\b/i
// Longest names first: "Canadian dollar" is not the US dollar.
const CURRENCIES: [RegExp, string][] = [
  [/\bcanadian dollars?\b|\bcad\b/i, 'CAD'], [/\baustralian dollars?\b|\baud\b/i, 'AUD'], [/\bswiss francs?\b|\bchf\b/i, 'CHF'],
  [/\b(?:serbian )?dinars?\b|\brsd\b/i, 'RSD'], [/\b(?:british )?pounds?(?: sterling)?\b|\bsterling\b|\bgbp\b/i, 'GBP'],
  [/\b(?:japanese )?yen\b|\bjpy\b/i, 'JPY'], [/\byuan\b|\brenminbi\b|\bcny\b/i, 'CNY'], [/\b(?:indian )?rupees?\b|\binr\b/i, 'INR'],
  [/\b(?:us |u\.s\. |american )?dollars?\b|\busd\b|\bbucks\b/i, 'USD'], [/\beuros?\b|\beur\b/i, 'EUR'],
  // Serbian, every case: evro/evra/evru, dinar/dinara/dinarima, dolar/dolara/dolaru, funta/funti.
  [/\bevr[aoui]m?\b|\bevrima\b/i, 'EUR'], [/\bdinar(a|e|i|u|ima)?\b/i, 'RSD'], [/\bdolar(a|e|i|u|ima)?\b/i, 'USD'], [/\bfunt(a|e|i|u|ama)\b/i, 'GBP'],
]
const VERSIONED = ['bun', 'deno', 'typescript', 'python', 'react', 'vue', 'svelte', 'vite', 'rust', 'kotlin', 'ruby', 'php', 'django', 'kubernetes', 'redis', 'nginx', 'ubuntu', 'angular', 'postgresql']
const VERSION = /\b(version|release|released)\b/i
const F1 = /\b(f1|formula (?:one|1)|grand prix)\b/i
const F1_FOLLOW = /\b(second|third|podium|came|finished|won|winner|pole)\b/i
const DATE_ONLY = /^\s*(?:and|what about|how about)?\s*(today|tomorrow|next week)\s*[?.!]*\s*$/i

/** The currencies named in order of mention, longest names first (each span counted once). */
function currencies(text: string): string[] {
  let rest = text
  const found: { at: number; code: string }[] = []
  for (const [re, code] of CURRENCIES) {
    const g = new RegExp(re.source, 'gi')
    for (let m = g.exec(rest); m; m = g.exec(rest)) {
      found.push({ at: m.index, code })
      rest = rest.slice(0, m.index) + ' '.repeat(m[0].length) + rest.slice(m.index + m[0].length)
    }
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.code).filter((c, i, all) => all.indexOf(c) === i)
}

const asset = (text: string) => {
  const t = text.toLowerCase()
  const key = Object.keys(ASSETS).find((k) => new RegExp(`\\b${k}\\b`).test(t))
  return key ? ASSETS[key] : undefined
}
const product = (text: string) => VERSIONED.find((p) => new RegExp(`\\b${p}\\b`, 'i').test(text))
// The first "in/for/at <Name>" that names a place ("rain in March in Porto": Porto).
const place = (text: string) => {
  for (const m of text.matchAll(new RegExp(PLACE.source, 'gu'))) {
    const words = m[1]!.split(/\s+/).filter((w) => !NOT_PLACE.test(w))
    if (words.length) return words.join(' ')
  }
}

/**
 * The card these words ask for, in the router's own shape (src/route.ts), or undefined when no rule applies. `last`:
 * the card of the call's last lookup, for a follow-up that names only what changed ("And Lisbon?", "And next week?").
 */
export function judge(text: string, last?: Card): Card | undefined {
  const words = text.trim()
  if (!words) return
  const follow = FOLLOW.exec(words)?.[1]?.trim()
  if (last && follow !== undefined && words.split(/\s+/).length <= 6) {
    const date = DATE_ONLY.exec(words)?.[1]?.toLowerCase()
    if (last.type === 'weather') {
      if (date) return { type: 'weather', place: last.place, ...(date === 'next week' ? { horizon: 'next_week' as const } : {}) }
      const p = /^[A-Z]/.test(follow) ? follow.split(/\s+/).filter((w) => !NOT_PLACE.test(w)).join(' ') : undefined
      if (p && !/\d/.test(p)) return { type: 'weather', place: p, ...(last.horizon ? { horizon: last.horizon } : {}) }
    }
    if (last.type === 'price') { const a = asset(follow); if (a) return { type: 'price', asset: a } }
    if (last.type === 'fx') { const c = currencies(follow); if (c.length === 1 && c[0] !== last.from) return { type: 'fx', from: last.from, to: c[0]! } }
    if (last.type === 'version') { const p = product(follow); if (p) return { type: 'version', product: p } }
  }
  if (last?.type === 'f1' && F1_FOLLOW.test(words) && words.split(/\s+/).length <= 6) return { type: 'f1' }
  if (last?.type === 'version' && /\b(when|come out|came out|released?)\b/i.test(words) && /\b(it|that)\b/i.test(words) && words.split(/\s+/).length <= 7) return last
  if (F1.test(words) && /\b(won|win|winner|result|results|podium|who)\b/i.test(words)) return { type: 'f1' }
  if (WEATHER.test(words)) {
    const p = place(words)
    if (p) return { type: 'weather', place: p, ...(/\bnext week\b/i.test(words) ? { horizon: 'next_week' as const } : {}) }
  }
  const c = currencies(words)
  if (c.length === 2 && /\b(how many|how much|rate|exchange|convert|in|to|into|worth|koliko|kurs|u|za)\b/i.test(words)) {
    // "How many euros is one dollar?" / "Koliko dinara je jedan evro?": the currency counted is the one asked for.
    const many = CURRENCIES.filter(([, code]) => code === c[0]).some(([re]) => new RegExp(`(?:how many|koliko)\\s+(?:${re.source})`, 'i').test(words))
    return many ? { type: 'fx', from: c[1]!, to: c[0]! } : { type: 'fx', from: c[0]!, to: c[1]! }
  }
  const a = asset(words)
  if (a && PRICE.test(words)) return { type: 'price', asset: a }
  const p = product(words)
  if (p && VERSION.test(words) && /\b(latest|newest|current|recent|last|new|what)\b/i.test(words)) return { type: 'version', product: p }
}

// Words that mean the answer may need a lookup or their workspace: something current, local, personal or about their
// project. Without any of them (and with no card above), the fast lane's own answer need not wait for the router.
const CUES = /\b(latest|newest|current(ly)?|now|today|tonight|tomorrow|yesterday|this (week|weekend|month|year)|next (week|month|year)|last (week|month|year|night)|recent(ly)?|news|price|prices|cost|costs|worth|stock|stocks|rate|rates|weather|forecast|rain|temperature|score|scores|won|win|wins|winner|result|results|election|president|prime minister|ceo|owns|owner|population|how many people|version|release|released|update|updates|near|nearby|open|closed|restaurant|traffic|flight|my|our|file|files|repo|repository|code|codebase|test|tests|function|project|commit|branch|bug|build|deploy|server|error|errors|log|logs|look up|check|search|find|google|vreme|vremena|prognoz\w*|danas|sutra|sada?|trenutno|cen[aeu]|kurs\w*|vesti|najnovij\w*|verzij\w*|ko[sš]ta|moj\w*|na[sš]\w*|fajl\w*|kod\w*|test\w*|projek\w*|grad\w*|restoran\w*|otvoren\w*|proveri|potra[zž]i|na[dđ]i|pogledaj)\b|\b(19|20)\d\d\b/i
// A turn that leans on the conversation ("Is it too big?", "What should I see there?", "And Discord?") is the router's
// to resolve first: without its context it could be the workspace, a follow-up lookup or a missing detail.
const LEANS = /\b(it|its|it's|that|this|there|those|these|they|them|their|umbrella|coat|jacket|wear)\b/i
/** Whether these words may need a lookup or the workspace (then the router decides before the fast lane speaks). */
export const cue = (text: string, last?: Card) => CUES.test(text) || LEANS.test(text) || FOLLOW.test(text) || !!judge(text, last)
/** Whether these words lean on the conversation ("And in its capital?", "What changed in it?"): one content word is the
 * whole question, and only the router, with the last exchange, knows what it asks. */
export const leans = (text: string) => LEANS.test(text) || FOLLOW.test(text)

// What the words still being spoken were last judged to ask for, and its data once in hand, exactly as prefetch()
// returns it: rules first (instant), then the router's verdict on the same words, which overrides them.
let card: { context: string; at: number; data?: string; words?: string; card?: Card } | undefined
// Told when a card's data is in hand for words still being spoken (the cascade starts the answer on them).
let onData: (words: string, context: string, data: string, c: Card) => void = () => {}
export const whenHeard = (f: typeof onData) => void (onData = f)
let asked = 0, settled = 0

/** A judging of the words so far starts; its number orders the verdicts. */
export const asking = () => ++asked

/** Verdict n: a card whose data is coming, or none. A verdict on words spoken later wins; the same n is overridden. */
export function heard(n: number, context: string, data?: Promise<string>, words?: string, which?: Card) {
  if (n < settled) return
  settled = n
  const c: typeof card = (card = data ? { context, at: Date.now(), words, card: which } : undefined)
  void data?.then((d) => void (c && card === c && d && ((c.data = d), words && which && onData(words, context, d, which))))
}

/** The rules' verdict on words still being spoken, at once: a card they name has its data fetched now (the router is
 * asked about the words at its own pace, src/prefetch.ts warm(), and overrides this). `last`: the card of the call's last
 * lookup, so a follow-up still being said ("And in Serbian dinars?" after a dollar rate) has its card in hand too. */
export function glance(q: string, context = '', last?: Card) {
  const c = judge(q, last)
  if (c) heard(asking(), context, cardData(c), q, c)
}

/** The data of the card the words so far were judged to ask for, if it is in hand ('' otherwise). */
export const spokenCard = (context = '') => (card?.context === context && Date.now() - card.at < 15_000 && card.data) || ''

// The card's data as prefetch() returns it (cached per card); prefetch registers it, so without it (a proof that mocks
// the prefetch module) nothing is judged ahead.
let fetcher: (c: Card) => Promise<string> = async () => ''
// The router, registered by the prefetch module (so a proof that mocks it routes nothing ahead): a verdict asked for
// on words still being spoken, cached for the transcript.
let router: (q: string, context: string) => void = () => {}
export const routing = (f: typeof router) => void (router = f)
export const routeAhead = (q: string, context = '') => router(q, context)
export const provide = (f: (c: Card) => Promise<string>) => void (fetcher = f)
export const cardData = (c: Card) => fetcher(c).catch(() => '')
