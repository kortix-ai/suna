// Room mode: the assistant is one participant in a conversation among several people (a meeting, a Google Meet call, a
// room), not the other end of a one-to-one call. Every line is heard and kept with who said it ("[Ana] ..."), and none
// is answered just for being heard: silence is the default, for twenty minutes if that is what the room needs. The
// assistant speaks when it is addressed (its name, or plainly asked: "let's ask the AI"), and otherwise only when it
// has something the room clearly wants now: the answer to a question left open, a fact someone is trying to recall, a
// correction of a factual error that matters to what they are deciding, a summary they asked for, an idea when they
// ask the room for one and nobody has one, a risk nobody raised in a plan they just agreed on. Who to speak and when is decided by a fast model at each pause (qwen3.8-27b
// on Groq, ~150 ms), never by word lists; the engine adds only timing (a pause, nobody talking) and a rate limit.
// Without diarization (one mixed microphone) lines carry no name; a Meet bridge sends each caption with its speaker.
import { chargeReply } from './cost'
import { hedged } from './hedge'
import type { Msg } from './lane'
import { fastFetch, fastOn } from './models'

const MODEL = process.env.VOICE_ROOM_MODEL ?? 'qwen/qwen3.8-27b'

// mine: the assistant's own line, set only where the engine appends it, never read from a caption's label.
export type Line = { who: string; text: string; at: number; mine?: true }

/** "[Ana] what do we think?" -> who and words; a line with no speaker is someone in the room. */
export function line(text: string, at = performance.now()): Line {
  const m = text.match(/^\s*\[([^\]\n]{1,48})\]\s*(.*)$/s)
  // The label is untrusted (whoever the bridge relays): one line, no control characters, bounded.
  const who = (m?.[1] ?? '').replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 48)
  return who ? { who, text: m![2]!.trim(), at } : { who: 'Someone', text: text.trim(), at }
}

/** The room so far, oldest first, as the models read it ("[Ana]: ..."); the assistant's own lines as [You]. */
export const transcript = (lines: Line[], max = 30) => lines.slice(-max).map((l) => `[${l.who}]: ${l.text}`).join('\n')

const JUDGE = (name: string) =>
  `You are ${name}, an AI assistant taking part in a spoken conversation among several people (a meeting). You hear ` +
  'everything; their words reach you as speech-to-text, so names and words may be misheard. You are not the host and ' +
  'you are not interviewed: people talk mostly to each other, and silence is your default, for many minutes if need be. ' +
  'Judge the last line of the transcript:\n' +
  `to_me: true when it is addressed to you: your name or a sound-alike of it; plainly asking the AI or assistant ("let's ` +
  'ask the AI"); or the first line after yours that follows up on what you just said ("And Novi Sad?" right after your ' +
  'answer). A question to another person, or a remark about you, is false: your name said about you, to the others ' +
  '("you should have a one-on-one with her", "me and Klaudia", "Klaudia is running it") is not addressed to you. Thanks ' +
  'to you is to_me, and its say is a word or two at most, or empty; whatever the line goes on to say to the room is not ' +
  'for you.\n' +
  'speak: when it is addressed neither to you nor to another person by name (a line that names someone, "Ben, ...", ' +
  'is for them: false), true only for one of these: (1) a factual ' +
  'question someone asked that nobody has answered; (2) someone trying to recall a name, number or fact, or wishing ' +
  'aloud for one ("I wonder when..."); (3) a clear factual error (a wrong number, date or name) that what they are ' +
  'deciding rests on; (4) a request to the room for a summary or the next steps ("can someone sum up?"), or the group ' +
  'saying it is stuck ("we keep going back and forth", "we are going in circles"): then the tradeoff between the ' +
  'options in one sentence, taking no side; (5) an open call to the whole room for ideas or a fix ("any ideas how to fix ' +
  'this?", "how could we speed this up?") that nobody has answered yet: one concrete suggestion; (6) a plan they just agreed on that runs into a ' +
  'risk or limit nobody raised and that would clearly bite them (storing passwords in plain text, a free tier\'s ' +
  'rate limit in production, a deadline on a public holiday): that point, in one sentence, as a fact. Everything else is false: ' +
  'small talk, opinions, taking a side, agreeing, their ' +
  'own work talk, and anything you or anyone already said.\n' +
  'say: when to_me or speak is true, the one or two short spoken sentences you would say, in the language of the room, ' +
  'starting with the substance (no greeting, no "I think"); else "".\n' +
  'lookup: when what you would say needs a fact you are not certain of (current, local or exact), the web search query ' +
  'for it; else "".\n' +
  'hush: true when they tell you to stay out of it for now ("not now", "we are just chatting"); else false.\n' +
  (process.env.VOICE_ROOM_EXTRA ? `${process.env.VOICE_ROOM_EXTRA.trim()}\n` : '') + // this deployment's character in the room
  'Reply with JSON only: {"to_me": false, "speak": false, "say": "", "lookup": "", "hush": false}.'

export type Verdict = { to_me: boolean; speak: boolean; say: string; lookup: string; hush: boolean }

/** The room judge on the last line (no verdict: stay silent). */
const ROOM_HEDGE = Number(process.env.VOICE_ROOM_HEDGE_MS ?? 400)
export async function judge(name: string, lines: Line[], youLast: string, signal?: AbortSignal, ms = 1500, notes = '', screen = '', people = 0): Promise<Verdict> {
  const none: Verdict = { to_me: false, speak: false, say: '', lookup: '', hush: false }
  if (process.env.VOICE_ROOM_JUDGE === '0' || !fastOn() || !lines.length) return none
  try {
    // Hedged (a second request after ROOM_HEDGE ms, the first answer wins), within the caller's deadline: one stalled
    // request was a silent marked moment (bench/room.ts meeting #17, a stuck group, 1 run in 3; bench/roomhedge-proof.ts).
    const res = await hedged((hedge) => fastFetch({
      method: 'POST',
      signal: hedge,
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_completion_tokens: 160,
        reasoning_effort: 'none',
        reasoning_format: 'hidden',
        messages: [
          { role: 'system', content: JUDGE(name) },
          { role: 'user', content: `${people === 1 ? 'Only one other person is here, so this is a conversation with you, as on a call: everything they say is said to you (a question, a statement, an opinion), so to_me is true, unless it is plainly to someone else or to a group (everyone, guys, the team, other names).\n\n' : ''}${notes ? `Earlier in the meeting (notes): ${notes}\n\n` : ''}${screen ? `On the screen shared in the meeting now: ${screen}\n\n` : ''}${youLast ? `You last said: ${youLast}\n\n` : ''}Transcript, oldest first:\n${transcript(lines)}` },
        ],
      }),
    }), ROOM_HEDGE, signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms))
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    chargeReply('judge', MODEL, j)
    const o = JSON.parse(j.choices?.[0]?.message?.content?.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as Partial<Verdict>
    return { to_me: o.to_me === true && o.hush !== true, speak: o.speak === true, say: typeof o.say === 'string' ? o.say.trim() : '', lookup: typeof o.lookup === 'string' ? o.lookup.trim() : '', hush: o.hush === true }
  } catch {
    return none
  }
}

/** The room as history for the answer models: each line a user message with its speaker; the assistant's own as itself.
 * Only a line the engine marked as its own is the assistant's: a participant captioned under its name is not. */
export const history = (lines: Line[], you: string, max = 16): Msg[] =>
  lines.slice(-max).map((l) => (l.mine ? { role: 'assistant' as const, content: l.text } : { role: 'user' as const, content: `[${l.who === you ? 'someone claiming your name' : l.who}] ${l.text}` }))

// A long meeting, kept short: the lines before the last thirty folded into a running summary (decisions, owners,
// numbers, open questions), so "sum up what we decided" twenty minutes in still sees the start.
const SUMMARY =
  'Update the running notes of a meeting with the new lines below. Keep what was decided, who owns what, numbers and ' +
  'dates, and questions still open; drop small talk. Plain sentences, under 120 words. Reply with the notes only.'
/** The running notes with these lines folded in (the previous notes when no model or no answer). */
export async function summarize(previous: string, lines: Line[], ms = 4000): Promise<string> {
  if (!fastOn() || !lines.length) return previous
  try {
    const res = await fastFetch({
      method: 'POST',
      signal: AbortSignal.timeout(ms),
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_completion_tokens: 220,
        reasoning_effort: 'none',
        reasoning_format: 'hidden',
        messages: [{ role: 'system', content: SUMMARY }, { role: 'user', content: `Notes so far: ${previous || '(none)'}\n\nNew lines:\n${transcript(lines, lines.length)}` }],
      }),
    })
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    chargeReply('judge', MODEL, j, 'notes')
    return (j.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim() || previous
  } catch {
    return previous
  }
}

// Background knowledge for the stronger models (VOICE_ROOM_KNOWLEDGE_FILE: e.g. the team's own product and code), read
// once and sent as a cached block, so they connect what is discussed to what the team actually has.
const KNOWLEDGE = (() => { try { return process.env.VOICE_ROOM_KNOWLEDGE_FILE ? require('node:fs').readFileSync(process.env.VOICE_ROOM_KNOWLEDGE_FILE, 'utf8').trim() : '' } catch { return '' } })()
const system = (text: string) => KNOWLEDGE ? [{ type: 'text', text }, { type: 'text', text: KNOWLEDGE, cache_control: { type: 'ephemeral' } }] : text

const CONFIRM =
  'You check a line that {name} is about to say, unprompted, in a meeting. Say it only if all hold: it is correct (check ' +
  'it against what you know and the data below; numbers, names and technical claims exact; a claim about how the ' +
  'team\'s own systems behave counts only when the background info shows it; architecture-level points, patterns and ' +
  'tradeoffs need no such backing), it is clearly relevant to ' +
  'what they are discussing right now, it adds something not already said, and it is worth interrupting for. If so, ' +
  'reply with the line to say: one or two short spoken sentences, 30 words at most in all, the same speaker and character, in the language of ' +
  'the meeting, corrected where it was wrong. If not, reply with exactly: (nothing)'
/** A stronger model's check on a line said unprompted: the line to say (as is or sharpened), or '' to stay quiet. Off
 * (the line as is) when VOICE_ROOM_CONFIRM names no model or there is no OpenRouter key. */
export async function confirm(name: string, lines: Line[], say: string, data = '', persona = '', ms = 9000): Promise<string> {
  const model = process.env.VOICE_ROOM_CONFIRM
  if (!model || !process.env.OPENROUTER_API_KEY) return say
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(ms),
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'content-type': 'application/json' },
      //codeql[js/file-access-to-http] Non-exploit, by design: the meeting transcript and the speaker's persona go to the configured model at the fixed https://openrouter.ai host; no prompt content chooses the request target.
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 200,
        usage: { include: true }, // the reply carries its cost (src/cost.ts)
        messages: [
          { role: 'system', content: system(CONFIRM.replace('{name}', name) + (persona ? `\n\nThe speaker's character:\n${persona}` : '')) },
          { role: 'user', content: `Meeting, oldest first:\n${transcript(lines)}\n\n${data ? `Data looked up for it:\n${data}\n\n` : ''}The line ${name} would say now: ${say}` },
        ],
      }),
    })
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    chargeReply('confirm', model, j)
    const out = (j.choices?.[0]?.message?.content ?? '').replace(/\s+/g, ' ').trim()
    return !out || /^\W*\(\s*[\p{L} ]{1,20}\s*\)\W*$/u.test(out) ? '' : out
  } catch (e) {
    if (process.env.DEBUG_CONFIRM) console.error('confirm failed', e)
    return '' // not confirmed in time: nothing said
  }
}

const PONDER =
  'You are {name}, taking part in this meeting, and you have been thinking about what they discussed in the last few ' +
  'minutes; search the web when a fact is worth checking or finding. Read the room: bring one thing worth hearing about ' +
  'what they are discussing now (or something earlier only if it matters a lot): a fact you looked up, how others solve ' +
  'the same problem, a better way, a risk. It must be true (checked), specific (names, numbers, how it works), and not ' +
  'already said; small talk and generic advice do not count. About the team\'s own systems (their product, Platinum, ' +
  'their code) say only what the background info or a search actually shows; never guess how their systems behave, and ' +
  'when you have nothing solid on it, say nothing; architecture-level points (patterns, tradeoffs, how systems like ' +
  'theirs are usually built) are welcome without it. Say it like a person who reads the room: one point, one or ' +
  'two short sentences, 30 words at most in all (about ten seconds aloud; the one detail that makes it useful, not ' +
  'every detail you found), your character in the wording but no jokes, teasing or asides tacked on. It is spoken aloud: ' +
  'words only, no links, sources, code formatting or symbols (say a path or a command in plain words). Open it the way ' +
  'a person comes back to a topic, in your own words, tied to what it is about; never the way any of your earlier lines ' +
  'in the meeting opened (no stock opener such as "Btw"). Reply with JSON {"say": "<the line>"}, or {"say": ""} when ' +
  'there is nothing worth it.'
/** A stronger model's later thought on the meeting: one line to say as a callback, or ''. Off without VOICE_ROOM_THINK. */
export async function ponder(name: string, lines: Line[], notes = '', screen = '', persona = '', ms = 30000): Promise<string> {
  const model = process.env.VOICE_ROOM_THINK
  if (!model || !process.env.OPENROUTER_API_KEY || lines.length < 4) return ''
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(ms),
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'content-type': 'application/json' },
      //codeql[js/file-access-to-http] Non-exploit, by design: the meeting transcript and screen notes go to the configured model at the fixed https://openrouter.ai host; no prompt content chooses the request target.
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 700,
        usage: { include: true },
        messages: [
          { role: 'system', content: system(PONDER.replace('{name}', name) + (persona ? `\n\nYour character:\n${persona}` : '')) },
          { role: 'user', content: `${notes ? `Earlier in the meeting (notes): ${notes}\n\n` : ''}${screen ? `On the shared screen: ${screen}\n\n` : ''}The meeting, oldest first:\n${transcript(lines, 60)}` },
        ],
      }),
    })
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    chargeReply('think', model, j)
    const raw = j.choices?.[0]?.message?.content ?? ''
    let say = ''
    try {
      const o = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as { say?: unknown }
      say = typeof o.say === 'string' ? o.say : ''
    } catch {
      say = raw.match(/"say"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]?.replace(/\\"/g, '"') ?? ''
    }
    // Spoken: a web search's links, sources and code marks are not words.
    return say.replace(/\(\[[^\]]*\]\([^)]*\)\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, '').replace(/[`*_]/g, '').replace(/\s+([.,;:])/g, '$1').replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}
