// The fast lane: a turn that needs no tool is answered by a fast model streaming straight into the voice, not by the
// agent. Measured 2026-11-01: qwen3.8-27b on Groq, first token 66-135 ms (median 77) for a voice turn with history, vs
// Flash-Lite 414 ms direct and the agent's session 600-2760 ms live (41k tokens of history in front of every turn).
// The model hands the turn to the agent, which has the tools, by replying exactly "(agent)". Off with VOICE_LANE=0.
const MODEL = process.env.VOICE_LANE_MODEL ?? 'qwen/qwen3.8-27b'
export const laneOn = () => process.env.VOICE_LANE !== '0' && fastOn()

import { NAME } from './name'
import { chargeTokens } from './cost'
import { fastFetch, fastOn } from './models'

export type Msg = { role: 'user' | 'assistant'; content: string }

const LANE =
  `\n\nYou are ${NAME}, a voice assistant, and you answer this turn yourself, with no tools. A background agent has ` +
  'the tools: it reads and changes their project files and code, runs commands, browses the web, uses their connected ' +
  'apps and remembers past sessions. When answering needs any of that (their workspace beyond what a <data> block of this turn shows, an action, something from an ' +
  'earlier session, or a fact that can change and is not in a <data> block of this turn), reply with exactly: (agent). ' +
  'Otherwise answer now, from the conversation, the <data> of this turn, or what you know for sure. Workspace <data> is ' +
  'their code and git state read just now, of the project it names: answer a question about it from it, naming the file, ' +
  'but a question about another repository or project the conversation is on is not answered by it: (agent); anything it does not ' +
  'show, and any change, run or check they ask for, is (agent). A question about ' +
  'you ("what can you do?") you answer yourself. When they only greet you or have no request yet, greet them back in a ' +
  'few words, as someone who knows them ("Hey!", "Not much, you?"), and nothing more: never your name, never a recap of ' +
  'earlier calls, never what they need.'

const HANDOFF = '(agent)'
// A spoken reply addresses the caller; it never narrates "the user" or plans aloud. When it does, the model's reasoning
// leaked into its answer (a live call read one out, 2026-11-01): the start is held to its first sentence and checked.
const NARRATION = /\b(the user|user's|user is|user asks|user wants|the caller is|the caller asks)\b|^\s*(okay,? )?(so,? )?(i need to|i should|let me (think|answer|figure|check what)|we need to)\b/i
const THINK = '<think>'

// A second, identical request when the first has not streamed a token after HEDGE ms; the first token wins and the other
// is aborted (Dean & Barroso, "The Tail at Scale"). Under two call stacks at once the fast lane's first token took
// 160-530 ms after its data instead of ~80 ms (floor runs 2026-11-01): the tail is queueing, not the model.
const HEDGE = Number(process.env.VOICE_LANE_HEDGE_MS ?? 300)

/** The content deltas of one streamed completion. Its cost, once: the usage that ends a finished stream (asked for with
 * stream_options), else, cut off by its abort (a hand-over, a barge-in, a hedge's loser), estimated at four
 * characters a token from what was sent and what came back. */
async function* deltas(body: string, signal: AbortSignal): AsyncGenerator<string> {
  const res = await fastFetch({
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'content-type': 'application/json' },
    body,
  })
  if (!res.ok || !res.body) return
  const dec = new TextDecoder()
  let buf = ''
  let out = 0
  type Usage = { prompt_tokens?: number; completion_tokens?: number }
  let usage: Usage | undefined
  let billed = false
  const bill = () => {
    if (billed) return
    billed = true
    if (typeof usage?.prompt_tokens === 'number') chargeTokens('lane', MODEL, usage.prompt_tokens, usage.completion_tokens ?? 0)
    else chargeTokens('lane', MODEL, body.length / 4, out / 4, { estimated: true })
  }
  signal.addEventListener('abort', bill, { once: true }) // a stream left mid-way is aborted, never read to its end
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true })
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line.startsWith('data:') || line.endsWith('[DONE]')) continue
        let delta: string | undefined
        try {
          const j = JSON.parse(line.slice(5)) as { choices?: { delta?: { content?: string } }[]; usage?: Usage; x_groq?: { usage?: Usage } }
          delta = j.choices?.[0]?.delta?.content
          usage = j.usage ?? j.x_groq?.usage ?? usage
        } catch {}
        if (delta) {
          out += delta.length
          yield delta
        }
      }
    }
  } finally {
    bill()
  }
}

/** The deltas of whichever of up to two identical streams yields first; a stream that fails before a token is retried once. */
async function* hedged(body: string, signal: AbortSignal): AsyncGenerator<string> {
  type First = { i: number; r: IteratorResult<string> }
  const tries: { ac: AbortController; it: AsyncGenerator<string> }[] = []
  const firsts: Promise<First>[] = []
  const start = () => {
    const i = tries.length
    const ac = new AbortController()
    signal.addEventListener('abort', () => ac.abort(), { once: true })
    const it = deltas(body, ac.signal)
    tries.push({ ac, it })
    firsts.push(it.next().then((r) => ({ i, r }), () => ({ i, r: { done: true, value: undefined } })))
  }
  start()
  let timer: ReturnType<typeof setTimeout> | undefined
  const hedge = new Promise<'hedge'>((r) => (timer = setTimeout(() => r('hedge'), HEDGE)))
  let open = [0]
  let winner: First | undefined
  while (!winner && !signal.aborted) {
    const got = await Promise.race([...open.map((i) => firsts[i]!), ...(tries.length < 2 ? [hedge] : [])])
    if (got === 'hedge' || (got.r.done && open.length === 1 && tries.length < 2)) {
      if (got !== 'hedge') open = []
      start()
      open.push(tries.length - 1)
      continue
    }
    if (!got.r.done) winner = got
    else if (!(open = open.filter((i) => i !== got.i)).length) break
  }
  clearTimeout(timer)
  for (const [i, t] of tries.entries()) if (i !== winner?.i) t.ac.abort()
  if (!winner) return
  yield winner.r.value
  yield* tries[winner.i]!.it
}

/**
 * Streams a direct answer into `on`. Resolves "ok" once it has finished, "agent" when the model hands the turn over
 * before saying anything, "error" when no answer started (no key, network, no first token within `ms`).
 */
export async function lane(system: string, history: Msg[], user: string, context: string, signal: AbortSignal, on: (delta: string) => void, ms = 1500): Promise<'ok' | 'agent' | 'error'> {
  if (!laneOn() || signal.aborted) return 'error'
  const ac = new AbortController()
  const stop = () => ac.abort()
  signal.addEventListener('abort', stop)
  const timer = setTimeout(stop, ms) // until the first token
  let held = '' // the start, until it cannot be the handoff
  let flowing = false
  const body = JSON.stringify({
    model: MODEL,
    stream: true,
    stream_options: { include_usage: true }, // the stream ends with its token counts (src/cost.ts)
    temperature: 0, // facts the same every time (0.3 once said "Oracle owns Slack.")
    max_completion_tokens: 400,
    reasoning_effort: 'none',
    reasoning_format: 'hidden', // and never a <think> block in what is read aloud (seen once in 20 with history)
    messages: [{ role: 'system', content: system + LANE }, ...history, { role: 'user', content: context ? `${user}\n\n${context.trim()}` : user }],
  })
  // What the stream decided, kept apart from leaving it: the abort that stops a stream still being sent (a hand-over
  // before the stream's end, as the Kortix gateway sends it) makes leaving the loop throw an AbortError, and that threw
  // away the verdict: every "(agent)" there came back 'error'.
  let verdict: 'ok' | 'agent' | 'error' | undefined
  const end = (v: 'ok' | 'agent' | 'error') => ((verdict = v), ac.abort(), v)
  try {
    // Once it flows: a tail that may still be the marker waits; the marker ends the reply.
    let tail = ''
    const flow = (d: string) => {
      tail += d
      const at = tail.indexOf(HANDOFF)
      if (at >= 0) return on(tail.slice(0, at).trimEnd()), (tail = ''), true
      let keep = 0
      for (let k = Math.min(HANDOFF.length - 1, tail.length); k > 0; k--) if (HANDOFF.startsWith(tail.slice(-k))) { keep = k; break }
      if (tail.length > keep) on(tail.slice(0, tail.length - keep))
      tail = tail.slice(tail.length - keep)
      return false
    }
    for await (const delta of hedged(body, ac.signal)) {
      clearTimeout(timer)
      if (flowing) { if (flow(delta)) return end('ok'); continue }
      held += delta
      if (THINK.startsWith(held.trimStart().slice(0, THINK.length)) && !held.includes('</think>')) continue // a think block: wait it out
      held = held.replace(/^\s*<think>[\s\S]*?<\/think>/, '')
      const start = held.trimStart()
      if (!start) continue
      if (start.length < HANDOFF.length && HANDOFF.startsWith(start)) continue // may still be "(agent)"
      if (start.startsWith(HANDOFF) || start.includes(HANDOFF)) return end('agent') // the marker anywhere: a hand-over
      if (!/[.!?\n]/.test(start) && start.length < 140) continue // the first sentence, whole, before a word goes out
      if (NARRATION.test(start.slice(0, 200))) return end('error') // its reasoning, not an answer
      flowing = true
      flow(held)
    }
    if (tail) on(tail) // what waited as a possible marker was not one
    const rest = held.replace(/^\s*<think>[\s\S]*?(<\/think>|$)/, '').trim() // a short answer, or only a think block
    if (!flowing) return rest && !HANDOFF.startsWith(rest) && !NARRATION.test(rest.slice(0, 200)) ? (on(rest), 'ok') : held.trim() && !NARRATION.test(rest.slice(0, 200)) ? 'agent' : 'error'
    return 'ok'
  } catch {
    return verdict ?? (flowing ? 'ok' : 'error') // cut off mid-answer: what streamed stands, like an aborted agent turn
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
  }
}
