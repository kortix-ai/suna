// The voice's meta tools (src/voice-tools.ts; the actions themselves: src/meta.ts): an agent acting on the live call it is part of. It reads the call (who it is in it, who is
// there, what is shared, the last lines, work in flight, what is pending, the cost), speaks in it, changes its own
// name, voice, look, style or mode, sets reminders and watches, captures the screen, camera or voice, and looks at
// what is shared. Each tool is a thin client of the relay's HTTP contract (GET/POST {VOICE_RELAY_URL}/call), so the
// same set serves pi and omp (pi/extension.ts) and any MCP client, Kortix agents included (src/mcp.ts).
// Two need no call (POST /speech, src/speech-api.ts): its voice as an audio file, and an audio file's words, so the agent
// sends its voice to any API that takes audio and hears a voice message from any of them.
import { readFile } from 'node:fs/promises'

export type Json = Record<string, unknown>
export type Schema = { type: 'object'; properties: Record<string, Json>; required?: string[]; additionalProperties?: boolean }
/** Where the relay is, its token, and the call's session (none: the relay's only live call). */
export type Relay = { url: string; token?: string; session?: string }
export type MetaRequest = { method: 'GET' } | { method: 'POST'; body: Json; path?: '/speech' } // path: /call unless named
export type MetaTool = {
  name: string
  label: string
  description: string
  /** One line for a host's list of available tools (pi's promptSnippet). */
  snippet: string
  /** Reads the call and changes nothing in it (a host may run it without asking). */
  readOnly?: true
  parameters: Schema
  request(args: Json): MetaRequest
}
export type MetaResult = { text: string; data: unknown; files: string[] }
/** A tool result's content, the same shape in pi and MCP. */
export type Block = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

const str = (description: string, extra: Json = {}) => ({ type: 'string', description, ...extra })
/** Only the fields given: the relay reads an absent field as "leave it". */
const given = (o: Json) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''))
const object = (properties: Record<string, Json>, required: string[] = []): Schema => ({ type: 'object', properties, ...(required.length && { required }), additionalProperties: false })
/** "90" is 90 seconds; "5m", "1h", "90s" stay words for the relay. */
const when = (v: unknown) => (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v)

export const META_TOOLS: MetaTool[] = [
  {
    name: 'voice_state',
    readOnly: true,
    label: 'Voice: call state',
    description:
      'Read the live voice call you are part of: who you are in it (persona: name, voice, look, style, mode), the people on it, what they share (screen, camera), the last lines said, background work, pending reminders and watches, and the cost so far.',
    snippet: 'Read the live voice call you are in: persona, people, shared screen/camera, last lines, pending reminders, cost.',
    parameters: object({}),
    request: () => ({ method: 'GET' }),
  },
  {
    name: 'voice_say',
    label: 'Voice: say',
    description: 'Say something aloud in the live call, in your own voice. `when`: "now" interrupts nobody but speaks as soon as the line is free; "pause" waits for a natural pause (default: the relay\'s).',
    snippet: 'Say something aloud in the live voice call.',
    parameters: object({ text: str('What to say, as spoken words: no markdown, lists or URLs.'), when: str('now | pause', { enum: ['now', 'pause'] }) }, ['text']),
    request: (a) => ({ method: 'POST', body: given({ say: a.text, when: a.when }) }),
  },
  {
    name: 'voice_set',
    label: 'Voice: set persona',
    description:
      'Change who you are in the live call, from the next sentence on: name, voice (an id or a description), look (an image URL or an emoji), style (how to speak), mode (normal: answer everyone; listen: keep quiet and keep the transcript until told to speak; named: answer only when addressed by name). Give only what changes.',
    snippet: 'Change your name, voice, look, speaking style or mode in the live voice call.',
    parameters: object({
      name: str('New name.'),
      voice: str('Voice id or a description of the voice.'),
      look: str('Image URL or emoji.'),
      style: str('How to speak.'),
      rate: { type: 'number', description: 'How fast to speak: 1 normal, 0.85 slower, 1.2 faster.' },
      mode: str('normal | listen | named'),
      back: str('With mode listen or named: back to normal after this long ("10m", "30s"), by itself.'),
      say: str('With back: what to say when back.'),
    }),
    request: (a) => ({ method: 'POST', body: { set: given({ name: a.name, voice: a.voice, look: a.look, style: a.style, rate: a.rate, mode: a.mode, back: a.back, say: a.say }) } }),
  },
  {
    name: 'voice_later',
    label: 'Voice: remind later',
    description: 'Say something in the call later: a reminder, a follow-up, a check-in. `in`: seconds, or a duration like "90s", "5m", "1h". Returns the reminder\'s id.',
    snippet: 'Schedule something to say in the voice call later (a reminder).',
    parameters: object({ in: str('Seconds, or a duration like "90s", "5m", "1h".'), say: str('What to say then.') }, ['in', 'say']),
    request: (a) => ({ method: 'POST', body: { later: { in: when(a.in), say: a.say } } }),
  },
  {
    name: 'voice_watch',
    label: 'Voice: watch',
    description: 'Watch the shared screen, the camera, or the call itself for something, and say something when it happens (e.g. on: "screen", for: "the build turns green", say: "The build passed."). Returns the watch\'s id.',
    snippet: 'Watch the screen, camera or call for something and speak when it happens.',
    parameters: object({ on: str('screen | camera | call', { enum: ['screen', 'camera', 'call'] }), for: str('What to watch for.'), say: str('What to say when it happens.') }, ['on', 'for', 'say']),
    request: (a) => ({ method: 'POST', body: { watch: { on: a.on, for: a.for, say: a.say } } }),
  },
  {
    name: 'voice_cancel',
    label: 'Voice: cancel',
    description: 'Cancel pending reminders or watches: "later" (all reminders), "watch" (all watches), "all", or one id from voice_later, voice_watch or voice_state.',
    snippet: 'Cancel pending voice reminders or watches.',
    parameters: object({ what: str('later | watch | all | an id') }, ['what']),
    request: (a) => ({ method: 'POST', body: { cancel: a.what } }),
  },
  {
    name: 'voice_capture',
    label: 'Voice: capture',
    description:
      'Capture what the call shares to files: "screen" (a screenshot of the shared screen), "camera" (a frame), "voice" (the last `seconds` of audio). `next`: wait for the next one instead of taking the latest. Returns the file paths.',
    snippet: 'Capture the shared screen, the camera, or the call audio to files.',
    parameters: object(
      { what: str('screen | camera | voice', { enum: ['screen', 'camera', 'voice'] }), seconds: { type: 'number', description: 'For voice (and a camera clip): how many seconds.' }, next: { type: 'boolean', description: 'Wait for the next frame or words instead of the latest.' } },
      ['what'],
    ),
    request: (a) => ({ method: 'POST', body: { capture: given({ what: a.what, seconds: a.seconds, next: a.next }) } }),
  },
  {
    name: 'voice_look',
    readOnly: true,
    label: 'Voice: look',
    description: 'Look at what the call shares (screen, camera) for a question and get the answer in words, e.g. "What error is on the screen?".',
    snippet: 'Ask a question about what is shared in the voice call (screen, camera).',
    parameters: object({ question: str('What to look for or answer from what is shared.') }, ['question']),
    request: (a) => ({ method: 'POST', body: { look: a.question } }),
  },
  {
    name: 'voice_speak',
    label: 'Voice: speak into a file',
    description:
      'Say text in your own voice into an audio file, with or without a live call: a voice message or a spoken reply to send through any tool or API that takes audio (an upload, a message attachment, a phone line that plays a file). The voice is the one you have in your call (another for this file: `voice`, an id or a description). `format`: mp3 (default in Kortix) or wav. Up to 20000 characters. Returns the file path.',
    snippet: 'Say text in your own voice into an audio file (mp3 or wav) to send anywhere.',
    parameters: object(
      { text: str('What to say, as spoken words: no markdown, lists or URLs.'), voice: str('Another voice for this file: an id or a description ("deep calm male"). Default: your call voice.'), format: str('mp3 | wav', { enum: ['mp3', 'wav'] }) },
      ['text'],
    ),
    request: (a) => ({ method: 'POST', path: '/speech', body: { speak: given({ text: a.text, voice: a.voice, format: a.format }) } }),
  },
  {
    name: 'voice_transcribe',
    readOnly: true,
    label: 'Voice: transcribe a file',
    description:
      'Transcribe an audio or video file into text with the speech-to-text of your calls: a voice message, a recording, a call capture (mp3, ogg, oga, opus, m4a, wav, webm, flac, mp4; up to 25 MB). `language`: its two-letter code when you know it; detected otherwise.',
    snippet: 'Transcribe an audio file (a voice message, a recording) into text.',
    parameters: object({ file: str('The audio file\'s path.'), language: str('Its ISO 639-1 code, e.g. "en" or "sr" (optional).') }, ['file']),
    request: (a) => ({ method: 'POST', path: '/speech', body: { transcribe: given({ file: a.file, language: a.language }) } }),
  },
]

/** The relay from the environment: VOICE_RELAY_URL (default http://127.0.0.1:7860), VOICE_TOKEN, VOICE_SESSION. */
export const relayFromEnv = (session?: string): Relay => ({
  url: (process.env.VOICE_RELAY_URL || 'http://127.0.0.1:7860').replace(/\/$/, ''),
  token: process.env.VOICE_TOKEN || undefined,
  session: process.env.VOICE_SESSION || session || undefined,
})

/** Sends one tool's request to the relay and reads its answer. Throws on a failed request (a tool error). */
export async function callRelay(relay: Relay, tool: MetaTool, args: Json = {}, signal?: AbortSignal): Promise<MetaResult> {
  const req = tool.request(args ?? {})
  const sid = typeof args?.session === 'string' && args.session ? args.session : relay.session
  const url = `${relay.url}${(req.method === 'POST' && req.path) || '/call'}${req.method === 'GET' && sid ? `?session=${encodeURIComponent(sid)}` : ''}`
  const headers: Record<string, string> = { ...(relay.token && { authorization: `Bearer ${relay.token}` }), ...(req.method === 'POST' && { 'content-type': 'application/json' }) }
  const body = req.method === 'POST' ? JSON.stringify({ ...(sid && { session: sid }), ...req.body }) : undefined
  let res: Response
  try {
    res = await fetch(url, { method: req.method, headers, body, signal })
  } catch (err) {
    throw new Error(`voice relay unreachable at ${relay.url} (is a call running? set VOICE_RELAY_URL): ${err instanceof Error ? err.message : String(err)}`)
  }
  const raw = await res.text()
  if (!res.ok) throw new Error(`voice relay ${res.status}: ${raw.slice(0, 500)}`)
  let data: unknown = raw
  try { data = raw ? JSON.parse(raw) : {} } catch {}
  const d = data as { text?: unknown; files?: unknown }
  const files = Array.isArray(d?.files) ? d.files.filter((f): f is string => typeof f === 'string') : []
  const text = typeof d?.text === 'string' ? d.text : files.length ? `Saved:\n${files.join('\n')}` : typeof data === 'string' ? data || 'Done.' : JSON.stringify(data, null, 1).slice(0, 12000)
  return { text, data, files }
}

const IMAGE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
/** A result as content: its text, and each captured image file it names (a screenshot the model can see). */
export async function content(result: MetaResult): Promise<Block[]> {
  const blocks: Block[] = [{ type: 'text', text: result.text }]
  for (const file of result.files) {
    const mimeType = IMAGE[file.split('.').pop()?.toLowerCase() ?? '']
    if (!mimeType) continue
    const data = await readFile(file).then((b) => b.toString('base64'), () => '')
    if (data) blocks.push({ type: 'image', data, mimeType })
  }
  return blocks
}
