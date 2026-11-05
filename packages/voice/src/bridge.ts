// The first thing said when the agent takes a turn (its tools take seconds): one sentence of what is being done for them
// now, or a solid fact that helps while they wait, written by a fast model (~150 ms) instead of a fixed "Let me check."
// The agent continues from it. A greeting gets a greeting back and nothing else (the user, 2026-11-02, after "What's up?" got
// "Hey! Pulling up where we left off. Not much, I'm Klaudia. We left off on cheap smart TVs...": "it literally doesn't need
// to introduce itself every time"). Before that, a greeting got where things stand: with nothing to describe, the model
// said "I'm here and ready to help.", and the agent went on to "What are we tackling today?" (drive runs, 2026-11-01).
// Off with VOICE_BRIDGE=0.
import type { Msg } from './lane'
import { chargeReply } from './cost'
import { fastFetch, fastOn } from './models'

const MODEL = process.env.VOICE_BRIDGE_MODEL ?? 'qwen/qwen3.8-27b'
const SYSTEM =
  'You are the voice of an assistant on a call. It is about to handle what the caller just said with its tools (their ' +
  'project files and code, commands, the web, their connected apps, past sessions), which takes a few seconds. Say one ' +
  'short spoken sentence. For work in their project or apps (files, code, git, commands, messages): what you are doing ' +
  'for them right now, first person, present tense ("Checking your git status."). For a question about the world (what ' +
  'something is, which one to pick, how something works), for a request to search or look something up on the web ("search X", "look up ' +
  'Y"), which is the same: something solid you already know that starts the answer, never that you are looking, ' +
  'searching, checking or researching it; when you know nothing solid about it, reply with exactly (nothing) ("Can you search ' +
  'Orvala Systems?" with nothing known: (nothing); "Look up used bikes in Berlin": "Berlin has a big used-bike market, ' +
  'mostly on Kleinanzeigen."), never what you can or will do ("I can search..."). Anything that narrows or ' +
  'follows up a search already going ("only the cheap ones", "in Lisbon"): (nothing); what the search finds answers it, and a ' +
  'claim of yours there gets taken back by the answer. ' +
  'Where to go in a city (a ' +
  'restaurant, café, bar, hotel or other venue): (nothing), you get the names of venues wrong; the pick comes from what ' +
  'is looked up. What to buy (a product, a model) is a question about the world as above. ' +
  'What they told you before or what you know of them (their name, their plans, what they said last time, what you ' +
  'remember about them): exactly (nothing). You have none of it, the agent has, and a check or a "no memory" of yours stands ' +
  'in the call ("I\'m checking your calendar", "I don\'t have any memory of you" were said, and the agent then answered). Never ' +
  'say what you cannot see or do, never ' +
  'promise a time, no filler. Only if what they asked is too vague to act on (what to ' +
  'write, which one), ask the one short question you need instead, and nothing else: they answer before you act. When ' +
  'they ask you to group, sort, pick or decide (categories, an order, "you decide"), you decide: that is not vague. If they only greeted you or have no ' +
  'request yet, greet them back in a few words and nothing else ("Hey!", "Not much, you?"): never your name, never ' +
  'what you are doing or where things were left. The caller\'s language. Only the sentence. Last check before you reply: ' +
  'a sentence that states a figure, a date or who won or placed, for anything current (a rate, a price, a release, a result), is a guess that stands in the call: (nothing). ' +
  'So a short follow-up on a live result gets exactly (nothing), never a figure, a name, or what you can or cannot find ("And silver?" after a gold price, "Any fixes in it?" after a version, "Who lost?" after a final). ' +
  'What to buy and how something works still get their solid sentence.'

/** The sentence, or undefined (off, no model, or no answer within `ms`). */
export async function bridge(user: string, history: Msg[], signal: AbortSignal, ms = 700): Promise<string | undefined> {
  if (process.env.VOICE_BRIDGE === '0' || !fastOn() || signal.aborted) return undefined
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  const stop = () => ac.abort()
  signal.addEventListener('abort', stop)
  try {
    const res = await fastFetch({
      method: 'POST',
      signal: ac.signal,
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_completion_tokens: 60,
        reasoning_effort: 'none',
        reasoning_format: 'hidden',
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `${history.length ? `The call so far:\n${history.slice(-6).map((m) => `${m.role === 'user' ? 'Caller' : 'You'}: ${m.content}`).join('\n')}\n\n` : ''}The caller just said: ${user}\n\nYour one sentence, or (nothing):` }],
      }),
    })
    const j = (await res.json()) as { choices?: { finish_reason?: string; message?: { content?: string } }[] }
    chargeReply('bridge', MODEL, j)
    const line = (j.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()
    // "(nothing)" (or any short word in parentheses, closed or not) is no sentence: nothing is said while the agent works.
    // Nor is a reply stopped at its token limit: this goes straight to the voice, so "(n" was said as her line.
    return line && j.choices?.[0]?.finish_reason !== 'length' && line.length <= 200 && !/^\(\s*\w{0,12}\s*\)?\.?$/.test(line) ? line : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
  }
}
