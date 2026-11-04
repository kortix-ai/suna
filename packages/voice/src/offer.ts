// Tell, don't offer: a sentence after the answer that asks permission for a read-only step ("Want me to check your git
// status?") is said as the step being taken ("I'll check your git status.") and the agent takes it in the background.
// Decided by a fast model on Groq (~85 ms, 14/14 on a mixed set in two languages), not by phrases; consent before
// changing, sending, deleting or deploying stays a question. Runs while the answer's first sentence plays.
// Off with VOICE_OFFERS=0.
import { chargeReply } from './cost'
import { fastFetch, fastOn } from './models'
const MODEL = process.env.VOICE_OFFER_MODEL ?? 'qwen/qwen3.8-27b'
const SYSTEM =
  'A voice assistant just said the sentence below after answering. Decide what kind of sentence it is, in any language. ' +
  'Reply with JSON only. Only if it is a question asking permission for a quick look-up that serves what the caller ' +
  'asked (look something up, read a file, search the code or the web, check a status): {"offer":true,"say":"<the same ' +
  "look-up stated as something it is doing now, short, same language, e.g. I'll check your git status.>\",\"step\":\"<the " +
  'look-up as an instruction>"}. Anything else is {"offer":false}: a statement (even one about what it will do), an ' +
  'answer, a question about what they want, an offer to run tests, benchmarks, builds, scripts or commands, to fix, ' +
  'change, send, delete, deploy or buy something, or anything that takes more than a quick look.'

export type Offer = { say: string; step: string }

/** The step this sentence offers, restated, or undefined (not an offer, no model, or no answer within `ms`). */
export async function offered(sentence: string, ms = 600): Promise<Offer | undefined> {
  if (process.env.VOICE_OFFERS === '0' || !fastOn()) return undefined
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
        max_completion_tokens: 80,
        reasoning_effort: 'none',
        reasoning_format: 'hidden',
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: sentence }],
      }),
    })
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    chargeReply('offer', MODEL, j)
    const o = JSON.parse(j.choices?.[0]?.message?.content ?? '{}') as { offer?: boolean; say?: string; step?: string }
    return o.offer && o.say?.trim() && o.step?.trim() ? { say: o.say.trim(), step: o.step.trim() } : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
