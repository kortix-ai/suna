// Where the call goes next. After an answer, a fast model (qwen3.8-27b on Groq, ~200 ms, off the caller's path) names
// the questions the caller is most likely to ask next that need a fresh lookup, written standalone ("And Belgrade?"
// after Serbia's population → "What is the population of Belgrade?"), and each is looked up at once, read-only, through
// the turn's own path (router, cards, search: src/prefetch.ts). When the next question comes, a second fast call beside
// the router judges whether it asks for the same information as one looked up ahead; if so, that data answers it,
// whichever is in hand first. Matched by meaning, not words: for the same follow-up the router writes "latest Bun
// version" where the prediction said "Bun 1.3.14", and word reuse missed 5 of 7 (measured). The answer to each
// prediction is written ahead from its data too, so a matched follow-up is spoken without waiting on the model.
// Off with VOICE_ANTICIPATE=0.
import { chargeReply } from './cost'
import type { Msg } from './lane'
import { content, firstUseful, pagesOf } from './pages'
import { prefetch } from './prefetch'
import { fastFetch, fastOn } from './models'

const MODEL = process.env.VOICE_ANTICIPATE_MODEL ?? 'qwen/qwen3.8-27b'
// v1 ("the most likely next questions") gave same-type siblings that are general knowledge ("capital of Canada" after
// Australia's) and missed the drill-down ("And Belgrade?"); asking for one going deeper first got it in 3 of 3 (eval).
export const NEXT_PROMPT =
  "You read a voice conversation and predict the caller's next questions, the ones a lookup must answer (a current " +
  'figure, place fact, price, rate, weather, version, date, result or news; never general knowledge). People most often ' +
  'follow an answer with the same question about a part or place within it, or about the obvious alternative; the same ' +
  'figure in another unit or in their own currency; the next one in a ranking or result; when, where or how it happened ' +
  'or came out; or what changed. Give the four most likely, most likely first, each something the last answer does not ' +
  'already say, written as a standalone question in the caller\'s language with every "it", "there" or "that" resolved. ' +
  'Reply with JSON only, no other text: {"next": ["...", "...", "...", "..."]}, or {"next": []} if nothing is likely.'
const SAME =
  'A caller in a voice call just asked the question below. The numbered questions were looked up ahead. Which one asks ' +
  'for the same information, so that its result answers the caller? Use the conversation to resolve a short question ' +
  '("and the other one?"). Also say whether the caller asks that very question, so its answer as written answers them ' +
  '(true), or asks something else its result answers (false: a yes or no about it, a comparison, a choice, an opinion). ' +
  'Reply with JSON only: {"same": n, "as": true} or {"same": n, "as": false}, or {"same": 0} if none asks for the same thing.'
const LIFE = 120_000 // a prediction older than two minutes is no longer where the call is going

// JSON mode off: Groq's validator rejected 1 of 10 look-ahead replies that were cut short (json_validate_failed), so
// the reply is parsed leniently: the first {...} in it.
async function ask(system: string, user: string, ms: number, tokens: number): Promise<Record<string, unknown>> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  try {
    const res = await fastFetch({
      method: 'POST',
      signal: ac.signal,
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_completion_tokens: tokens,
        reasoning_effort: 'none',
        reasoning_format: 'hidden',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    })
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    chargeReply('anticipate', MODEL, j, system === NEXT_PROMPT ? 'next' : system === SAME ? 'match' : system === FOLLOWS ? 'follows' : system === TONE ? 'tone' : undefined)
    return JSON.parse(j.choices?.[0]?.message?.content?.match(/\{[\s\S]*\}/)?.[0] ?? '{}')
  } catch {
    return {}
  } finally {
    clearTimeout(timer)
  }
}

const on = () => process.env.VOICE_ANTICIPATE !== '0' && fastOn()

const FOLLOWS =
  'A voice assistant just answered the caller, who then said only an acknowledgment or went quiet. Decide whether one ' +
  'more line it prepared is the natural next thing for THIS caller: it must build directly on what they just heard and ' +
  'serve what they are clearly after (the same subject one step deeper, or the obvious comparison they would want). A ' +
  'different topic, a tangent, or something they gave no sign of wanting is not. Reply with JSON only: {"follows": true} ' +
  'or {"follows": false}.'
/** Whether a line prepared ahead follows from the last exchange (a fast yes/no judge; no on timeout or failure). */
export async function follows(asked: string, answered: string, closer: string, q: string, line: string): Promise<boolean> {
  if (!on()) return false
  const o = await ask(FOLLOWS, `Caller asked: ${asked}\nAssistant answered: ${answered}\nCaller: ${closer || '(quiet)'}\nPrepared line (answers "${q}"): ${line}`, 900, 20)
  return o.follows === true
}

const TONES: Record<string, string> = { warm: 'warmly', cheerful: 'cheerfully', gentle: 'gently, softly', concerned: 'with quiet concern', excited: 'excitedly', serious: 'seriously, calmly', playful: 'playfully' }
const TONE =
  'You set the tone of voice for a voice assistant\'s reply to what the caller just said. Most replies are plain: say ' +
  '"none" unless the feeling is clear. warm: thanks, good news about them, kindness; cheerful: a win, a light moment; ' +
  'gentle: loss, pain, stress, frustration; concerned: a problem or risk they face; excited: something great or new; ' +
  'serious: grave or careful matters; playful: a joke or teasing. Reply with JSON only: {"tone": "none"}.'
/** The delivery for the reply to these words ("gently, softly"), or '' for a plain one (a fast judge, ~120 ms). */
export async function toneOf(user: string, before = ''): Promise<string> {
  if (!fastOn() || process.env.VOICE_TONE === '0') return ''
  const o = await ask(TONE, `${before ? `Before: ${before}\n` : ''}Caller: ${user}`, 600, 15)
  return TONES[String(o.tone)] ?? ''
}

/** The likely next lookup questions after this conversation, or [] (off, nothing likely, or no answer within `ms`). */
export async function anticipate(history: Msg[], ms = 1500): Promise<string[]> {
  if (!on() || !history.length) return []
  const transcript = history.slice(-6).map((m) => `${m.role === 'user' ? 'Caller' : 'Assistant'}: ${m.content}`).join('\n')
  const o = await ask(NEXT_PROMPT, transcript, ms, 200)
  return Array.isArray(o.next) ? o.next.filter((q): q is string => typeof q === 'string' && q.trim().length > 3).slice(0, 4) : []
}

type Ahead = { q: string; at: number; data: Promise<string>; got?: string; reply?: Promise<string>; text?: string; used?: boolean }

/**
 * One call's look-ahead: what was looked up for where the call is going, and the next question matched against it.
 * write: the spoken answer to a predicted question from its data (the fast lane, off the caller's path), or '' when it
 * would hand over; with it, a matched follow-up starts speaking without the model's first token (~150-400 ms).
 */
export function foresight(note: (kind: 'anticipate' | 'ahead', data: Record<string, unknown>) => void = () => {}, write?: (q: string, data: string, history: Msg[]) => Promise<string>) {
  let ahead: Ahead[] = []
  let latest: Ahead[] = [], following = '' // predicted after the last answer, and the caller turn that answer was for
  // The match for the words at the caller's pause, kept for the transcript when its words are the same.
  let primed: { key: string; hit: Promise<{ hit?: Ahead; as: boolean }> } | undefined
  let refresh: Ahead | undefined // matched for its data while they asked something else: its written answer does not fit
  let approved: Ahead | undefined // matched as the very question they asked
  // Its written answer fits these words: approved by the match, or each of their content words is in its question.
  const fits = (a: Ahead, asked?: string) => a === approved || !asked || [...content(asked)].every((w) => content(a.q).has(w))
  const keyOf = (q: string, context: string, live: Ahead[]) => `${context}\n${q.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, ' ').trim()}\n${live.map((a) => a.q).join('\n')}`
  const same = (q: string, context: string, live: Ahead[]) => {
    const list = live.map((a, i) => `${i + 1}. ${a.q}`).join('\n')
    const t0 = performance.now()
    return ask(SAME, `Conversation:\n${context}\n\nThe caller asks: ${q}\n\nLooked up ahead:\n${list}`, 800, 20).then((o) => {
      const n = Number(o.same)
      const hit = Number.isInteger(n) && n >= 1 && n <= live.length ? live[n - 1]! : undefined
      note('ahead', { q, match: hit?.q ?? null, as: o.as ?? null, ms: Math.round(performance.now() - t0) })
      return { hit, as: o.as !== false }
    })
  }
  return {
    /** After an answer: predict the next questions and look each up (read-only), off the caller's path. */
    after(history: Msg[]) {
      const asked = history.findLast((m) => m.role === 'user')?.content ?? ''
      following = asked
      void anticipate(history).then((next) => {
        const now = Date.now()
        const fresh = next.map((q) => {
          const data = prefetch(q, '', undefined, false, true).catch(() => '')
          const entry: Ahead = { q, at: now, data }
          void data.then((d) => ((entry.got = d), note('anticipate', { q, ms: Date.now() - now, data: d.length })))
          // Written from the call as it is after this answer (the caller has heard it, or is hearing it now).
          if (write) entry.reply = data.then((d) => (d ? write(q, d, history).catch(() => '') : '')).then((r) => ((entry.text = r), r))
          return entry
        })
        if (following === asked) latest = fresh
        ahead = [...fresh, ...ahead.filter((a) => now - a.at < LIFE)].slice(0, 6)
      })
    },
    /** The data for this question: a look-ahead that asks for the same information, or the turn's own fetch. */
    async answer(q: string, context: string, fetching: Promise<string>, known?: (hit: boolean) => void): Promise<string> {
      const live = latest.filter((a) => Date.now() - a.at < LIFE) // what was looked up after the answer it follows
      if (!live.length || !on()) return known?.(false), fetching
      const key = keyOf(q, context, live)
      const matched = (primed?.key === key ? primed.hit : same(q, context, live)).then((m) => ((refresh = m.hit && !m.as ? m.hit : undefined), (approved = m.hit && m.as ? m.hit : undefined), m.hit ? m.hit.data.then((d) => (d && m.hit!.text === '' ? [d, pagesOf(d)].filter(Boolean).join('\n') : d)) : ''))
      primed = undefined
      void matched.then((d) => known?.(!!d), () => known?.(false)) // whether a look-ahead answers it, once that is known
      // Whichever useful data is in hand first; a turn with no lookup waits at most a moment for the match.
      const own = fetching.then((d) => d || Promise.race([matched, new Promise<string>((r) => setTimeout(() => r(''), 300))]))
      return firstUseful([matched, own])
    },
    /** The words at the caller's pause: the match starts now, for the transcript to take if its words are the same. */
    prime(q: string, context: string) {
      const live = latest.filter((a) => Date.now() - a.at < LIFE) // what was looked up after the answer it follows
      if (!live.length || !on()) return
      const key = keyOf(q, context, live)
      if (primed?.key !== key) primed = { key, hit: same(q, context, live) }
    },
    /** A caller turn was answered: predictions made after an earlier answer no longer follow (an "Okay." heard as an
     * acknowledgment, never committed as a turn, keeps them). */
    turned(user: string) {
      if (user !== following) (latest = []), (following = '')
    },
    /**
     * Where the call goes next after the last answer, as a forward move: the answer written ahead for the first
     * prediction that is ready (one going deeper into that answer first) and passes `fits`, once; '' if none is.
     */
    /** Like next(), with the question it answers and its data: for judging whether it is the natural next thing. */
    pick(fits: (line: string) => boolean = () => true): { q: string; text: string; data: string } | undefined {
      const a = latest.find((x) => x.text && !x.used && fits(x.text))
      if (!a) return
      a.used = true
      return { q: a.q, text: a.text!, data: a.got ?? '' }
    },
    next(fits: (line: string) => boolean = () => true): string {
      const a = latest.find((x) => x.text && !x.used && fits(x.text))
      if (a) a.used = true
      return a?.text ?? ''
    },
    /** The answer written ahead from exactly this data, or '' (none written, or it handed over). */
    /** The answer written ahead from exactly this data, if it is already written ('' otherwise; '' too once it was said
     * as a move: asked for again, it is answered fresh, with the move in the history, not recited). */
    ready(data: string, asked?: string): string {
      return (data && ahead.find((a) => a.got === data && a.text && !a.used && a !== refresh && fits(a, asked))?.text) || ''
    },
    written(data: string, asked?: string): Promise<string> {
      return (data && ahead.find((a) => a.got === data && !a.used && a !== refresh && fits(a, asked))?.reply) || Promise.resolve('')
    },
  }
}
