// One step further after every answer: Gemini Flash-Lite (~450-650 ms, while the answer plays) writes the sentence a sharp
// colleague adds next (a related fact they would want, a risk, a better option, the obvious next step), from the turn's
// data and what it knows for sure, or nothing. The drive judge's most-failed check was a turn that stops at a plain answer
// (55% of turns); a rule in the voice prompt alone moved it to 48%. Measured 2026-11-01: qwen3.8-27b added something to
// 2 of 9 answers; Flash-Lite without data invented details ("rain from the west around midday"), with the data and a
// no-invention rule it kept to them ("Tuesday's worse, with over two millimeters expected"). Off with VOICE_FOLLOWUP=0.
import { chargeReply } from './cost'
import type { Msg } from './lane'
import { fastFetch, fastOn, viaModels } from './models'

const MODEL = process.env.VOICE_FOLLOWUP_MODEL ?? 'gemini-3.5-flash-lite'
const SYSTEM =
  'You are the voice of an assistant on a call. It has just answered the caller. Most answers need nothing more: reply ' +
  'with exactly (nothing) unless one more sentence clearly helps with what the caller themselves asked or is trying to ' +
  'do: a risk in it, the obvious next step for it, or the specific fact the answer left out that they need. It must follow ' +
  'from their question and the answer just given, and be news to them. Reply (nothing) when their words were short or ' +
  'passed the choice to you (a yes or no, okay, thanks, leaving it to you, a correction, a hesitation), when they declined ' +
  'or closed a topic, when the answer asks them something or is complete, or when all you could add is about something ' +
  'they did not raise. Never advice they did not ask for, an offer, a promise, a question, a repeat or a new topic. Use ' +
  'only the <data> given, when it is about their question, and facts you are certain of: never invent a number, a time, ' +
  'a cause or a detail. Only the sentence, in the caller\'s language, in plain words (no symbols or markup).'
// The second opinion: a different model, on the sentence alone, before it is said.
const CHECK =
  'A voice assistant on a call wants to add one sentence after its answer. Say yes only if this caller would clearly ' +
  'want it right now: it is about what they asked or are doing, follows from the answer they heard, and is news to them. ' +
  'Advice they did not ask for, a new topic, a fact about something they did not raise, a repeat, an offer or a question ' +
  'is no. Reply with JSON only: {"add": true} or {"add": false}.'
const CHECK_MODEL = process.env.VOICE_FOLLOWUP_CHECK_MODEL ?? 'qwen/qwen3.8-27b'
/** Whether the caller would want this sentence after that answer (no on doubt, timeout, failure or no key). */
export async function wanted(user: string, answer: string, line: string, signal: AbortSignal, ms = 700): Promise<boolean> {
  if (!fastOn() || signal.aborted) return false
  try {
    const res = await fastFetch({
      method: 'POST',
      signal: AbortSignal.any([signal, AbortSignal.timeout(ms)]),
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: CHECK_MODEL,
        temperature: 0,
        max_completion_tokens: 20,
        reasoning_effort: 'none',
        reasoning_format: 'hidden',
        messages: [{ role: 'system', content: CHECK }, { role: 'user', content: `Caller: ${user}\nAnswer they heard: ${answer}\nSentence to add: ${line}` }],
      }),
    })
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    chargeReply('followup', CHECK_MODEL, j, 'check')
    return JSON.parse(j.choices?.[0]?.message?.content?.match(/\{[\s\S]*\}/)?.[0] ?? '{}').add === true
  } catch {
    return false
  }
}

/** The sentence, or undefined (nothing to add, off, no model, or no answer within `ms`). `data`: the turn's <data>. */
export async function followup(user: string, answer: string, history: Msg[], signal: AbortSignal, data = '', ms = 1200): Promise<string | undefined> {
  // Gemini's own API with its key locally; in a Kortix box the models base serves the same model as chat.
  if (process.env.VOICE_FOLLOWUP === '0' || !(process.env.GEMINI_API_KEY || viaModels()) || signal.aborted || !answer.trim()) return undefined
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  const stop = () => ac.abort()
  signal.addEventListener('abort', stop)
  try {
    const msgs: Msg[] = [...history.slice(-6), { role: 'user', content: data ? `${user}\n${data}` : user }, { role: 'assistant', content: answer }, { role: 'user', content: '(Write the next sentence, or (nothing).)' }]
    let line: string
    if (viaModels()) {
      const res = await fastFetch({
        method: 'POST',
        signal: ac.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, temperature: 0, max_completion_tokens: 80, reasoning_effort: 'minimal', messages: [{ role: 'system', content: SYSTEM }, ...msgs] }),
      })
      const j = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      chargeReply('followup', MODEL, j)
      line = (j.choices?.[0]?.message?.content ?? '').trim()
    } else {
      const turn = (m: Msg) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
        method: 'POST',
        signal: ac.signal,
        headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY!, 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: msgs.map(turn),
          generationConfig: { temperature: 0, maxOutputTokens: 80, thinkingConfig: { thinkingLevel: 'minimal' } },
        }),
      })
      const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
      chargeReply('followup', MODEL, j)
      line = (j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '').trim()
    }
    // "(nothing)", or the same in its own words or language ("(none)", "(nic)"): a lone parenthesis is never speech.
    const said = line.replace(/\$([^$\n]{1,40})\$/g, '$1')
    if (!said || /^\W*\([^)]{0,24}\)\W*$/.test(said) || said.length > 220) return undefined
    return (await wanted(user, answer, said, signal)) ? said : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
  }
}
