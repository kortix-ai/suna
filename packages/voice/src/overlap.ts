// What a caller says over the agent, judged by meaning by a fast model (like src/eot.ts), in any language: keep talking
// through a listening sound or reaction, stop for a stop, yield to anything that takes the turn. The words come from a
// peek, often cut off mid-word. Undefined when no model answers in time: the turn manager's own rules decide then.
import { chargeReply } from './cost'
import { fastFetch, fastOn } from './models'
const MODEL = process.env.VOICE_OVERLAP_MODEL ?? 'qwen/qwen3.8-27b'
const SYSTEM =
  'The assistant is speaking on a voice call. The caller says something over it; you get their words so far as ' +
  'speech-to-text, often cut off mid-word, and what the assistant was saying. Answer one word. backchannel: a ' +
  'listening sound, agreement or reaction that does not ask the assistant to stop or answer. stop: they want it to ' +
  'stop or wait. interrupt: they are taking the turn: a correction, a question, an objection, new content.'

export type Overlap = 'backchannel' | 'stop' | 'interrupt' | undefined

export function overlapping(text: string, said: string, on: (v: Overlap) => void, ms = 700): void {
  if (process.env.VOICE_OVERLAP === '0' || !fastOn()) return on(undefined)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  fastFetch({
    method: 'POST',
    signal: ac.signal,
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_completion_tokens: 4,
      reasoning_effort: 'none',
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Assistant was saying (quoted context): ${JSON.stringify(said.slice(-300))}\nCaller over it: ${text}` }],
    }),
  })
    .then((r) => r.json() as Promise<{ choices?: { message?: { content?: string } }[] }>)
    .then((j) => {
      chargeReply('overlap', MODEL, j)
      const out = j.choices?.[0]?.message?.content?.toLowerCase() ?? ''
      on(out.includes('back') ? 'backchannel' : out.includes('stop') ? 'stop' : out.includes('inter') ? 'interrupt' : undefined)
    })
    .catch(() => on(undefined))
    .finally(() => clearTimeout(timer))
}
