// What a call costs, as it happens: every paid request (hearing, voice, models, vision, search, the agent) reports its
// price to the call it was made for, and the call page adds them up. The paid calls are module functions with no call
// in hand, so the call travels with the async work itself (AsyncLocalStorage): src/server.ts runs every entry into a
// call's model inside costSink.run(sink, ...), and what that starts (promises, timers, fetches, streams) charges that
// call. With no sink (a bench, a proof that sets none) a charge does nothing.
import { AsyncLocalStorage } from 'node:async_hooks'

/** What a charge was for; `detail` (optional) says which use of it ("peek", "notes", "tone"). */
export type Item =
  | 'stt' | 'tts' | 'lane' | 'router' | 'eot' | 'judge' | 'bridge' | 'second' | 'think' | 'confirm' | 'vision' | 'search' | 'agent'
  | 'deep' | 'followup' | 'anticipate' | 'offer' | 'overlap' | 'lang' | 'watch' // the fast model's other jobs, each its own line (watch: src/meta.ts)
export type Sink = (item: Item, usd: number, units: string, model?: string, detail?: string) => void
export const costSink = new AsyncLocalStorage<Sink>()

/** The sink for a call's client: one {type: 'event', kind: 'cost', item, usd, units, model?, detail?} per charge. */
export const costEvents = (emit: (m: object) => unknown): Sink => (item, usd, units, model, detail) =>
  void emit({ type: 'event', kind: 'cost', item, usd: Math.round(usd * 1e9) / 1e9, units, ...(model ? { model } : {}), ...(detail ? { detail } : {}) })

// List prices in USD: estimates, checked 2026-11-02 against the providers' pages where they answered, else aggregators
// and our research notes (sources per line). VOICE_PRICES overrides any entry, field by field, as JSON:
// VOICE_PRICES='{"qwen/qwen3.8-27b": {"in": 0.29, "out": 0.59}, "tavily": {"call": 0.005}}'.
// in, out, cached (a cache read; half of `in` when not given, as on Groq), audioIn: per million tokens; hour: per hour of audio, at least `min` seconds billed a request;
// char: per million characters; call: per request. A model is priced by the longest key it starts with, its gateway
// prefixes dropped one by one when none matches ("openrouter/anthropic/claude-opus-5.5" is priced as "claude-opus").
export type Price = { in?: number; out?: number; cached?: number; audioIn?: number; hour?: number; min?: number; char?: number; call?: number }
const LIST: Record<string, Price> = {
  // Groq Whisper (groq.com/pricing): billed by audio length, 10 s at least per request.
  'whisper-large-v3': { hour: 0.111, min: 10 },
  'whisper-large-v3-turbo': { hour: 0.04, min: 10 },
  // Groq chat. qwen3.8-27b is a preview at $0.80 in / $4.00 out (morphllm.com/groq-pricing, Oct 2026; RESEARCH.md has
  // Groq at "$0.15-0.80 / M in"); other Qwen at qwen3-32b's $0.29 / $0.59; gpt-oss at Groq's $0.075 / $0.30 and $0.15 / $0.60.
  'qwen/qwen3.8-27b': { in: 0.8, out: 4 },
  'qwen/': { in: 0.29, out: 0.59 },
  'openai/gpt-oss-20b': { in: 0.075, out: 0.3 },
  'openai/gpt-oss-120b': { in: 0.15, out: 0.6 },
  // Gemini API: 3.5 Flash-Lite $0.30 in ($0.03 cached) / $2.50 out, thinking billed as out (aggregators citing
  // ai.google.dev/pricing, Aug-Oct 2026). Audio in is not listed there: $1.00 assumed (~3x text, as on Gemini Flash).
  'gemini-': { in: 0.3, cached: 0.03, audioIn: 1, out: 2.5 },
  'google/gemini-': { in: 0.3, out: 2.5 }, // the same through OpenRouter (whose usage.cost wins when present)
  // Voices, per million characters. Inworld TTS-2 $25, TTS-2 Flash $15, markup tags counted (on-demand: inworld.ai/pricing
  // via GMI Cloud docs 2026-08-31; research notes). xAI TTS $4.20 (launch price, April 2026; some resellers list $15).
  // Gemini 3.8 Flash-Lite TTS ~$11 and Flash TTS ~$16.50 (Artificial Analysis' per-character figures, research notes
  // 2026-10-27). ElevenLabs Flash v2.5 $40 ($0.04 per 1k, elevenlabs.io/pricing/api). The mock voice is free.
  'inworld-tts-2': { char: 25 },
  'inworld-tts-2-flash': { char: 15 },
  'xai-tts': { char: 4.2 },
  'gemini-3.8-flash-lite-tts': { char: 11 },
  'gemini-3.8-flash-tts': { char: 16.5 },
  eleven_: { char: 40 },
  mock: { char: 0 },
  // Search, per request. Tavily $0.008 a credit pay-as-you-go: a basic search is 1, an extract 1 per 5 pages (0.2).
  // Serper $0.001 a query ($50 for 50k). Firecrawl $0.00083 a credit (Standard, $83 for 100k): a search 2 credits
  // per 10 results, a scrape 1 a page.
  tavily: { call: 0.008 },
  'tavily-extract': { call: 0.0016 },
  serper: { call: 0.001 },
  firecrawl: { call: 0.00166 },
  'firecrawl-scrape': { call: 0.00083 },
  // OpenRouter replies, and the agent's session, carry their own cost (usage.cost, asked for; info.cost); these are for
  // one that does not: Anthropic's list prices per million tokens for its current tiers.
  'claude-opus': { in: 5, cached: 0.5, out: 25 },
  'claude-sonnet': { in: 3, cached: 0.3, out: 15 },
  'claude-haiku': { in: 1, cached: 0.1, out: 5 },
}
const OVERRIDE = (() => { try { return JSON.parse(process.env.VOICE_PRICES ?? '{}') as Record<string, Price> } catch { return {} } })()
const KEYS = [...new Set([...Object.keys(LIST), ...Object.keys(OVERRIDE)])].sort((a, b) => b.length - a.length)
/** The price of a model, voice or provider ({} when none is known: it is charged as free and says so). */
export function price(model: string): Price {
  const parts = model.toLowerCase().split('/')
  for (let i = 0; i < parts.length; i++) {
    const id = parts.slice(i).join('/')
    const key = KEYS.find((k) => id.startsWith(k.toLowerCase()))
    if (key !== undefined) return { ...LIST[key], ...OVERRIDE[key] }
  }
  return {}
}

const n = (x: number) => Math.round(x).toLocaleString('en-US')
function charge(item: Item, usd: number, units: string, model?: string, detail?: string) {
  const sink = costSink.getStore()
  if (!sink || !Number.isFinite(usd)) return
  try { sink(item, Math.max(0, usd), units, model, detail) } catch { /* a closed call */ }
}

/** Tokens of one model request: `usd` as the provider reported it, else from the price table. */
export function chargeTokens(item: Item, model: string, tokensIn: number, tokensOut: number, o: { usd?: number; cached?: number; audio?: number; estimated?: boolean; detail?: string } = {}) {
  if (!costSink.getStore()) return
  const p = price(model), cached = o.cached ?? 0, audio = o.audio ?? 0
  const known = p.in !== undefined || o.usd !== undefined
  const usd = o.usd ?? ((tokensIn - cached - audio) * (p.in ?? 0) + cached * (p.cached ?? (p.in ?? 0) / 2) + audio * (p.audioIn ?? p.in ?? 0) + tokensOut * (p.out ?? 0)) / 1e6
  charge(item, usd, `${n(tokensIn)} in + ${n(tokensOut)} out tokens${cached ? `, ${n(cached)} cached` : ''}${o.estimated ? ' (est.)' : ''}${known ? '' : ' (no price)'}`, model, o.detail)
}

type Usage = { prompt_tokens?: number; completion_tokens?: number; cost?: number; prompt_tokens_details?: { cached_tokens?: number } }
type Gemini = { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number; promptTokensDetails?: { modality?: string; tokenCount?: number }[] }
/** A model's reply as read, OpenAI-shaped (Groq, OpenRouter: `usage`, Groq's `x_groq.usage`) or Gemini's
 * (`usageMetadata`). One without usage is an error, not billed: nothing is charged. */
export function chargeReply(item: Item, model: string, reply: unknown, detail?: string) {
  if (!costSink.getStore() || !reply || typeof reply !== 'object') return
  const r = reply as { usage?: Usage; x_groq?: { usage?: Usage }; usageMetadata?: Gemini }
  const u = r.usage ?? r.x_groq?.usage
  if (u && typeof u.prompt_tokens === 'number')
    return chargeTokens(item, model, u.prompt_tokens, u.completion_tokens ?? 0, { usd: typeof u.cost === 'number' ? u.cost : undefined, cached: u.prompt_tokens_details?.cached_tokens, detail })
  const g = r.usageMetadata
  if (g && typeof g.promptTokenCount === 'number')
    chargeTokens(item, model, g.promptTokenCount, (g.candidatesTokenCount ?? 0) + (g.thoughtsTokenCount ?? 0), { audio: g.promptTokensDetails?.find((d) => d.modality === 'AUDIO')?.tokenCount, cached: g.cachedContentTokenCount, detail })
}

/** The response, its usage charged as it is read by a reader of its own (a hedged request's loser is never read). */
export function metered(res: Response, item: Item, model: string, detail?: string): Response {
  if (costSink.getStore() && res.ok) void res.clone().json().then((j) => chargeReply(item, model, j, detail), () => {})
  return res
}

/** Speech-to-text by audio length (Whisper on Groq: 10 s billed at least per request). */
export function chargeStt(model: string, seconds: number, detail?: string) {
  const p = price(model), billed = Math.max(p.min ?? 0, seconds)
  charge('stt', (billed / 3600) * (p.hour ?? 0), `${seconds.toFixed(1)} s audio (billed ${billed.toFixed(1)})`, model, detail)
}

/** A voice by the characters it is sent (markup tags count). */
export function chargeTts(model: string, text: string) {
  if (text) charge('tts', (text.length * (price(model).char ?? 0)) / 1e6, `${n(text.length)} chars`, model)
}

/** One search or page read at a provider's per-request price. */
// Through the Kortix router (a box) a search is billed at its prices (apps/api config.ts proxy_*): a Firecrawl scrape
// is $0.01 there, twelve times the vendor's own credit, and a call's cost read it at the vendor's.
const ROUTER: Record<string, number> = { tavily: 0.005, serper: 0.001, firecrawl: 0.01, 'firecrawl-scrape': 0.01 }
export function chargeSearch(provider: 'tavily' | 'serper' | 'firecrawl' | 'tavily-extract' | 'firecrawl-scrape') {
  const routed = !!(process.env.KORTIX_API_URL?.trim() && process.env.KORTIX_TOKEN?.trim()) && provider in ROUTER
  charge('search', routed ? ROUTER[provider]! : price(provider).call ?? 0, provider.includes('-') ? '1 page' : '1 search', provider)
}

/** The agent's reply, as its session reports it (a kortixd assistant message: cost in USD, tokens). */
export function chargeAgent(info: { cost?: number; modelID?: string; providerID?: string; tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } }) {
  const t = info.tokens
  if (!t && !info.cost) return
  const cached = (t?.cache?.read ?? 0) + (t?.cache?.write ?? 0)
  const model = [info.providerID, info.modelID].filter(Boolean).join('/')
  chargeTokens('agent', info.modelID ?? model, (t?.input ?? 0) + cached, (t?.output ?? 0) + (t?.reasoning ?? 0), { usd: typeof info.cost === 'number' && info.cost > 0 ? info.cost : undefined, cached: t?.cache?.read, detail: model || undefined })
}
