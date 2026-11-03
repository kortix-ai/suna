// A deeper look, queued: the quick answer from a fast web search is out in ~1 s, and when it could only frame what they
// asked (the best place, a market, a comparison, a plan), the agent takes the question on with its tools in the
// background (more searches, the pages read in full) while the call goes on; a short line says so, "how's it going?"
// is answered from its ledger, and its finding is said at the next pause, tied back to the question. The user asked
// for this ("a quick answer, then a queue that does the in-depth search and reports"); research on waiting (Maister
// 1985; Maslych 2025): announce the work, speak again only with news, tie the result to what was asked. Decided by a
// fast model (qwen3.8-27b on Groq, ~150 ms, while the answer plays), never by word lists. Off with VOICE_DEEP=0.
import { chargeReply } from './cost'
import type { Msg } from './lane'
import { fastFetch, fastOn } from './models'

const MODEL = process.env.VOICE_DEEP_MODEL ?? 'qwen/qwen3.8-27b'
const SYSTEM =
  'A voice assistant just answered the caller from one quick web search. Decide whether a deeper look in the ' +
  'background (more searches, reading the pages in full, up to a minute) would clearly add something this caller wants: ' +
  'yes when the quick answer could only frame it (the best options, a recommendation, a market, a comparison, a plan, ' +
  'something they asked to search or dig into); no for a settled fact (weather, a price, a time, a date, a version, a ' +
  'score, a definition), small talk, thanks, a yes or no, or when the answer already settles it. On yes, also write the ' +
  'one short sentence (under ten words) the assistant says next, in the caller\'s language: what it will look into ' +
  'for them, named for this question (its own words, never a stock phrase), and that it will tell them; plain words, ' +
  'no promise of a time. Reply with JSON only: {"deep": true, "say": "..."} or {"deep": false}.'

/** The sentence announcing a deeper look, or undefined (not worth one, off, no key, or no verdict within `ms`). */
export async function deeper(user: string, answer: string, history: Msg[], signal: AbortSignal, ms = 900): Promise<string | undefined> {
  if (process.env.VOICE_DEEP === '0' || !fastOn() || signal.aborted) return undefined
  try {
    const before = history.slice(-4).map((m) => `${m.role === 'user' ? 'Caller' : 'Assistant'}: ${m.content}`).join('\n')
    const res = await fastFetch({
      method: 'POST',
      signal: AbortSignal.any([signal, AbortSignal.timeout(ms)]),
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_completion_tokens: 60,
        reasoning_effort: 'none',
        reasoning_format: 'hidden',
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `${before ? `${before}\n` : ''}Caller: ${user}\nAssistant (from a quick search): ${answer}` }],
      }),
    })
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    chargeReply('deep', MODEL, j, 'deeper')
    const o = JSON.parse(j.choices?.[0]?.message?.content?.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as { deep?: unknown; say?: unknown }
    const say = typeof o.say === 'string' ? o.say.trim() : ''
    return o.deep === true && say && say.length <= 140 ? say : undefined
  } catch {
    return undefined
  }
}

/** The background turn's prompt: what they asked and heard; only what adds, tied back to the question. */
export const DEEP = (asked: string, heard: string) =>
  `[A deeper look for the caller, in the background, while the call goes on. They asked: "${asked}". They already heard: "${heard}". ` +
  'Search the web first (one or two searches, and read the most useful page); never answer this from memory. Then reply ' +
  'with only what adds to what they heard: the specifics that answer what they asked (models, prices, places, dates), ' +
  'within what they asked (a cheap one means the cheap ones), with where each is from, in at most three short ' +
  'sentences. Never repeat what they heard and never describe the search. If nothing you found adds to it, reply with ' +
  'exactly: (nothing).]'

// Still news? A finding from the background, checked against the conversation since, before it is said.
const STILL =
  'A voice assistant ran a deeper look in the background for the caller and has this finding ready to say. Given the ' +
  'conversation since, say yes only if it tells them something not already said and still fits what they are talking ' +
  'about now; one that repeats what they heard, is about a topic they have left, or only qualifies or takes back what ' +
  'was said without a right answer they would act on, is no. Reply with JSON only: ' +
  '{"say": true} or {"say": false}.'
/** Whether the finding is still news for this conversation (yes when the model cannot be asked: the look was promised). */
export async function still(finding: string, history: Msg[], ms = 1500): Promise<boolean> {
  if (process.env.VOICE_DEEP === '0' || !fastOn()) return true
  try {
    const talk = history.slice(-8).map((m) => `${m.role === 'user' ? 'Caller' : 'Assistant'}: ${m.content}`).join('\n')
    const res = await fastFetch({
      method: 'POST',
      signal: AbortSignal.timeout(ms),
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_completion_tokens: 20,
        reasoning_effort: 'none',
        reasoning_format: 'hidden',
        messages: [{ role: 'system', content: STILL }, { role: 'user', content: `Conversation:\n${talk}\n\nFinding ready: ${finding}` }],
      }),
    })
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    chargeReply('deep', MODEL, j, 'still')
    return JSON.parse(j.choices?.[0]?.message?.content?.match(/\{[\s\S]*\}/)?.[0] ?? '{}').say !== false
  } catch {
    return true
  }
}

// The finding from the background (once still() says it is news), said as the next line of the conversation as it is
// now, or not at all. Right after
// the answer it deepens, it goes straight on from it (no re-introduction: "On the cheap smart TVs: ..." right after the
// answer about cheap smart TVs sounded like a new speech, live call 2026-11-02); when they talked about something else
// meanwhile, it opens with a two- or three-word way back. Only what is new (the model lists it first: asked for the
// line alone, it judged a finding with new prices "nothing" 2 of 2 times), within what they asked. Empty: not news.
const CONNECT =
  'A voice assistant on a call has a finding from looking further into the caller\'s question while the call went on. ' +
  'First list what in the ' +
  'finding is new: each model, price, place or fact the conversation has not already said. Then write the line the ' +
  'assistant says now, from those new things only, in the language of the conversation, as the note on where the ' +
  'conversation is says: going straight on from its own answer as the next sentence of it (no greeting, no ' +
  're-introduction of the topic such as "On the ...:", no "I found"), or opening with a two- or three-word way back ' +
  '("Back on the TVs:"). Within what they asked, with where it is from when that matters; one or two short spoken ' +
  'sentences, numbers as people say them, with their units (dollars, percent). A finding that only qualifies what was ' +
  'said (sources differ a little, a figure is an estimate) or takes it back without giving the right answer changes ' +
  'nothing they would do: that is not new. A correction they would act on (a different time, price or answer) is. ' +
  'With nothing new, or when the caller has clearly left the topic for good, the line is empty. Reply with JSON only: {"new": ["..."], "say": "..."}'
/** The finding as the next line of this conversation, or '' when it is not news now (as found when the model cannot be asked). */
export async function connect(finding: string, history: Msg[], movedOn: boolean, ms = 3000): Promise<string> {
  if (process.env.VOICE_DEEP === '0' || !fastOn()) return finding
  try {
    const talk = history.slice(-8).map((m) => `${m.role === 'user' ? 'Caller' : 'Assistant'}: ${m.content}`).join('\n')
    const where = movedOn ? 'They have talked about other things since its answer on this topic: open with a way back.' : 'Its answer on this topic was the last thing said: go straight on from it.'
    const res = await fastFetch({
      method: 'POST',
      signal: AbortSignal.timeout(ms),
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_completion_tokens: 300,
        reasoning_effort: 'none',
        reasoning_format: 'hidden',
        messages: [{ role: 'system', content: CONNECT }, { role: 'user', content: `Conversation, oldest first:\n${talk}\n\nWhere the conversation is: ${where}\n\nFinding ready: ${finding}` }],
      }),
    })
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    chargeReply('deep', MODEL, j, 'connect')
    const o = JSON.parse(j.choices?.[0]?.message?.content?.match(/\{[\s\S]*\}/)?.[0] ?? 'null') as { say?: unknown } | null
    if (!o || typeof o.say !== 'string') return finding
    return o.say.replace(/\s+/g, ' ').trim()
  } catch {
    return finding
  }
}
