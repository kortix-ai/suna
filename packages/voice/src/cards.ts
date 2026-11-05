// Answer cards: a fact of a known type about an entity the router named (src/route.ts: typed, any language, no
// phrase lists), answered by a keyless primary API in one line, no search engine. Measured on 26 spoken questions (research notes 2026-10-28): 50/231 ms p50/p90 warm,
// the fact present 96% (search snippets 56–87%). Weather: Open-Meteo, free for non-commercial use only (production
// needs its commercial plan or another provider; VOICE_CARDS lists the kinds to use). Versions: endoflife.date, then
// the npm registry. Crypto: CoinGecko. Exchange rates: open.er-api.com (daily). Formula 1: jolpica (Ergast).
import { hedged } from './hedge'
import type { Card } from './route'

const KINDS = new Set((process.env.VOICE_CARDS ?? 'weather,version,price,fx,f1').split(','))
// A primary API that has not answered in 300 ms (p90 231) is asked again: a card past its 800 ms wait loses to the web
// search, which is slower and can be wrong ("around twenty-five degrees" against a forecast of 9 to 18).
const get = async (u: string) => {
  //codeql[js/file-access-to-http] Non-exploit: the host of every card URL is one of the fixed, allowlisted CARD_HOSTS (open-meteo, open-meteo geocoding, endoflife.date, npm registry, deps.dev, er-api, coingecko, jolpi) and the caller-chosen words are encodeURIComponent'd path/query text, never the request target.
  const r = await hedged((signal) => fetch(u, { headers: { 'user-agent': 'voice-agent' }, signal }), 300, undefined, false)
  if (!r.ok) throw new Error(`${r.status}`)
  return r.json() as Promise<any>
}
let eol: Set<string> | undefined
// A place's coordinates, found once per process (a failed lookup is asked again next time).
const places = new Map<string, Promise<any>>()
const located = (place: string) => {
  const key = place.trim().toLowerCase()
  const hit = places.get(key)
  if (hit) return hit
  const found = get(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1`).then((r) => r.results?.[0])
  places.set(key, found)
  void found.then((g) => g || places.delete(key), () => places.delete(key))
  return found
}
/** Whether the geocoder knows the place (the card's own lookup, cached for it); undefined when it did not answer in time. */
export const placeKnown = (place: string, ms = 800): Promise<boolean | undefined> =>
  Promise.race([located(place).then((g) => !!g, () => undefined), new Promise<undefined>((ok) => setTimeout(ok, ms))])
// open.er-api.com's rates are daily, and one answer holds every currency of its base: kept ten minutes per base, so a
// follow-up in another currency ("And in Serbian dinars?" after a dollar rate) reads its rate in hand. It fetched the
// same address again after its transcript, the card that turn waited on (~960 ms against ~560 for follow-ups in hand).
const rates = new Map<string, { at: number; answer: Promise<any> }>()
const ratesOf = (base: string) => {
  const hit = rates.get(base)
  if (hit && Date.now() - hit.at < 600_000) return hit.answer
  const answer = get(`https://open.er-api.com/v6/latest/${base}`)
  rates.set(base, { at: Date.now(), answer })
  void answer.catch(() => rates.get(base)?.answer === answer && rates.delete(base))
  return answer
}
const day = (i: number, t: string) => (i === 0 ? 'today' : i === 1 ? 'tomorrow' : new Date(t).toLocaleDateString('en', { weekday: 'long' }))

/** The card the router typed (src/route.ts), one line with its source; undefined if its kind is off or the API failed. */
export async function card(c: Card): Promise<string | undefined> {
  if (!KINDS.has(c.type)) return
  switch (c.type) {
    case 'weather': {
      const g = await located(c.place)
      if (!g) return
      const f = await get(`https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}&current=temperature_2m&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max&timezone=auto&forecast_days=${c.horizon === 'next_week' ? 16 : 3}`)
      const d = f.daily
      if (c.horizon === 'next_week') {
        const dates: unknown = d?.time, lows: unknown = d?.temperature_2m_min, highs: unknown = d?.temperature_2m_max
        const rain: unknown = d?.precipitation_sum, chances: unknown = d?.precipitation_probability_max
        if (!Array.isArray(dates) || !Array.isArray(lows) || !Array.isArray(highs) || !Array.isArray(rain) || !Array.isArray(chances)) return
        const first: unknown = dates[0]
        if (typeof first !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(first)) return
        // daily.time is already local to the forecast location. UTC arithmetic here
        // preserves those calendar dates without consulting the host's date or zone.
        const today = new Date(`${first}T00:00:00Z`)
        if (!Number.isFinite(today.getTime()) || today.toISOString().slice(0, 10) !== first) return
        const monday = today.getTime() + ((8 - today.getUTCDay()) % 7 || 7) * 86_400_000
        const start = new Date(monday).toISOString().slice(0, 10)
        const end = new Date(monday + 6 * 86_400_000).toISOString().slice(0, 10)
        const index = dates.indexOf(start)
        if (index < 0) return
        const days: string[] = []
        for (let offset = 0; offset < 7; offset++) {
          const i = index + offset
          const date = new Date(monday + offset * 86_400_000).toISOString().slice(0, 10)
          if (dates[i] !== date) return
          const low: unknown = lows[i], high: unknown = highs[i], mm: unknown = rain[i], chance: unknown = chances[i]
          if (typeof low !== 'number' || !Number.isFinite(low) || typeof high !== 'number' || !Number.isFinite(high)
            || typeof mm !== 'number' || !Number.isFinite(mm) || typeof chance !== 'number' || !Number.isFinite(chance)) return
          days.push(`${date} ${Math.round(low)} to ${Math.round(high)} degrees, rain ${Math.round(mm)} mm (${chance}% chance)`)
        }
        return `${g.name}, ${g.country}: next week ${start} to ${end}, degrees Celsius; ${days.join('; ')} (Open-Meteo forecast, live)`
      }
      return `${g.name}, ${g.country}: now ${Math.round(f.current.temperature_2m)} degrees Celsius; ${d.time.map((t: string, i: number) => `${day(i, t)} ${Math.round(d.temperature_2m_min[i])} to ${Math.round(d.temperature_2m_max[i])} degrees, rain ${Math.round(d.precipitation_sum[i])} mm (${d.precipitation_probability_max[i]}% chance)`).join('; ')} (Open-Meteo forecast, live)`
    }
    case 'version': {
      const id = c.product.toLowerCase().replace(/\.js$/, 'js').replace(/[\s.]+/g, '')
      eol ??= new Set(await get('https://endoflife.date/api/all.json'))
      if (eol.has(id)) {
        const all = await get(`https://endoflife.date/api/${id}.json`)
        return `${c.product}: latest ${all[0].latest} (released ${all[0].latestReleaseDate ?? all[0].releaseDate ?? '?'}), newest cycle ${all[0].cycle}${all.find((x: any) => x.lts) ? `, latest LTS cycle ${all.find((x: any) => x.lts).cycle}` : ''} (endoflife.date)`
      }
      const p = await get(`https://registry.npmjs.org/${encodeURIComponent(c.product.toLowerCase())}/latest`).catch(() => undefined)
      return p?.version ? `${c.product} on npm: latest ${p.version} (npm registry)` : undefined
    }
    case 'price': {
      const id = c.asset.toLowerCase()
      const p = (await get(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd,eur`))[id]
      return p ? `${id}: ${p.usd} US dollars, ${p.eur} euros (CoinGecko, live)` : undefined
    }
    case 'fx': {
      const r = (await ratesOf(c.from.toUpperCase())).rates?.[c.to.toUpperCase()]
      return r ? `1 ${c.from.toUpperCase()} = ${r} ${c.to.toUpperCase()} (open.er-api.com, today's rate)` : undefined
    }
    case 'f1': {
      const r = (await get('https://api.jolpi.ca/ergast/f1/current/last/results.json')).MRData.RaceTable.Races[0]
      return `${r.raceName}, ${r.date}: won by ${r.Results[0].Driver.givenName} ${r.Results[0].Driver.familyName} (${r.Results[0].Constructor.name}), then ${r.Results.slice(1, 3).map((x: any) => `${x.Driver.givenName} ${x.Driver.familyName}`).join(' and ')} (jolpica F1 results)`
    }
  }
}

/**
 * The card's line with what it lacked and a follow-up asks for, looked up behind the answer; undefined when it lacks
 * nothing or the lookup failed. npm's latest manifest has no release date (endoflife.date's has): "When did it come
 * out?" after TypeScript's version stayed on a card without one, and the fast lane guessed ("Looks like July 8th",
 * "early August" in the same 151 runs). deps.dev has each version's (~250 ms cold, keyless).
 */
export async function filled(c: Card, line: string): Promise<string | undefined> {
  const m = c.type === 'version' ? line.match(/^(.+) on npm: latest (\S+) \(npm registry\)$/) : null
  if (!m) return
  const r = await get(`https://api.deps.dev/v3/systems/npm/packages/${encodeURIComponent(m[1]!.toLowerCase())}/versions/${encodeURIComponent(m[2]!)}`)
  const day = typeof r?.publishedAt === 'string' ? r.publishedAt.slice(0, 10) : ''
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${m[1]} on npm: latest ${m[2]} (published ${day}) (npm registry)` : undefined
}

/** The card hosts' connections opened ahead (a cold first call is 50–800 ms). */
export const CARD_HOSTS = ['https://api.open-meteo.com/', 'https://geocoding-api.open-meteo.com/', 'https://endoflife.date/', 'https://registry.npmjs.org/', 'https://api.deps.dev/', 'https://open.er-api.com/', 'https://api.coingecko.com/', 'https://api.jolpi.ca/']
