// Speech as a service of the relay, with or without a call (POST /speech; the voice_speak and voice_transcribe tools,
// src/voice-tools.ts): text said in the agent's own voice, saved as an audio file, and the words of an audio file. So an
// agent with the voice loaded pipes its voice into anything that takes audio (a connector's upload, a message's
// attachment, a phone line that plays a file) and hears a voice message from any of them. A channel's voice note lands
// in its inbox as a file, and before this its only way to hear one was to install a speech-to-text tool for the turn.
// The models are a call's own: its voice (VOICE_TTS; the box's gateway in Kortix) and its Whisper, billed the same way.
import { open, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { chargeStt } from './cost'
import { ISO, family, serbianLatin } from './lang'
import { mediaDir } from './meta'
import { sttFetch, viaModels } from './models'
import { type Seg, heard, inworldVoice, inworldVoices, modelsSpeech, ttsDefault, ttss, vocab } from './speech'

/** What the relay answers: a JSON body and its status. */
export type Reply = { status: number; body: Record<string, unknown> }
const bad = (error: string, status = 400): Reply => ({ status, body: { error } })

const MAX_CHARS = 20_000 // about twenty minutes of speech
const CHUNK = 1_000 // characters a request: under every voice's limit (the gateway's 4,096)
const AT_ONCE = 4 // requests in flight for a long text, its parts kept in order
const MAX_BYTES = 25 * 1024 * 1024 // Whisper's upload limit
// The files Whisper reads, by extension, and the name each goes up as: Ogg's other names (Telegram's .oga, .opus) as .ogg.
const AUDIO: Record<string, string> = { flac: 'flac', mp3: 'mp3', mp4: 'mp4', mpeg: 'mpeg', mpga: 'mpga', m4a: 'm4a', ogg: 'ogg', oga: 'ogg', opus: 'ogg', wav: 'wav', webm: 'webm' }

/** The text in parts of at most `max` characters, cut after a sentence where one ends in time, else at a space. */
export function parts(text: string, max = CHUNK): string[] {
  const out: string[] = []
  let rest = text.replace(/\s+/g, ' ').trim()
  while (rest.length > max) {
    const head = rest.slice(0, max + 1)
    const end = Math.max(...['. ', '! ', '? ', '… '].map((p) => head.lastIndexOf(p)))
    const cut = end > max / 3 ? end + 1 : head.lastIndexOf(' ') > 0 ? head.lastIndexOf(' ') : max
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out
}

/** PCM16 mono as a WAV file. */
export function wav(pcm: Uint8Array, rate = 24_000): Uint8Array {
  const head = Buffer.alloc(44)
  head.write('RIFF', 0), head.writeUInt32LE(36 + pcm.length, 4), head.write('WAVEfmt ', 8), head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20), head.writeUInt16LE(1, 22), head.writeUInt32LE(rate, 24), head.writeUInt32LE(rate * 2, 28)
  head.writeUInt16LE(2, 32), head.writeUInt16LE(16, 34), head.write('data', 36), head.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([head, pcm])
}

/** f over the items, AT_ONCE at a time, the results in the items' order; the first failure stops the rest. */
async function inOrder(items: string[], signal: AbortSignal, f: (item: string, signal: AbortSignal) => Promise<Uint8Array>): Promise<Uint8Array[]> {
  const ac = new AbortController()
  const stop = () => ac.abort()
  signal.addEventListener('abort', stop)
  const out: Uint8Array[] = new Array(items.length)
  let next = 0
  try {
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, items.length) }, async () => {
      while (next < items.length && !ac.signal.aborted) {
        const k = next++
        out[k] = await f(items[k]!, ac.signal).catch((e) => (ac.abort(), Promise.reject(e)))
      }
    }))
    return out
  } finally {
    signal.removeEventListener('abort', stop)
  }
}

const bytesOf = async (r: Response): Promise<Uint8Array> => {
  if (!r.ok) throw new Error(`the voice answered ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`)
  return new Uint8Array(await r.arrayBuffer())
}

/**
 * `text` said in a voice, saved as an audio file in the call's media folder (src/meta.ts mediaDir). `voice`: an id or a
 * description for this file; else `o.voice` (the voice the session's live call has now), else the call's default.
 * `format`: mp3 (through the models base: a box's gateway) or wav (any voice; the default without the models base).
 */
export async function speak(ask: { text?: unknown; voice?: unknown; format?: unknown }, o: { session?: string; voice?: string; signal?: AbortSignal } = {}): Promise<Reply> {
  const text = typeof ask.text === 'string' ? ask.text.trim() : ''
  if (!text) return bad('`text` is required: the words to say')
  if (text.length > MAX_CHARS) return bad(`the text is ${text.length} characters, more than ${MAX_CHARS}: say it in several files`)
  const format = ask.format === undefined || ask.format === '' ? (viaModels() ? 'mp3' : 'wav') : ask.format
  if (format !== 'mp3' && format !== 'wav') return bad('`format` is mp3 or wav')
  if (format === 'mp3' && !viaModels()) return bad('mp3 comes from the models base (VOICE_MODELS_URL); ask for wav')
  const tts = ttsDefault()
  const inworld = format === 'mp3' || tts === 'models' || tts.startsWith('inworld') // mp3 is the models base's Inworld voices
  let voice = o.voice
  const asked = typeof ask.voice === 'string' ? ask.voice.trim().slice(0, 80) : ''
  if (asked && inworld) {
    await inworldVoices() // the catalog, for a voice asked for by description
    voice = inworldVoice(asked) || undefined
    if (!voice) return bad(`no voice like "${asked}": name one of the call's voices (voice_state lists some) or describe one ("deep calm male")`)
  } else if (asked) {
    // Another vendor's voice is an id, never a path or a query (ElevenLabs puts it in its URL).
    if (!/^[\w-]{1,80}$/.test(asked)) return bad('`voice` is a voice id here: letters, digits, - and _')
    voice = asked
  }
  const signal = AbortSignal.any([...(o.signal ? [o.signal] : []), AbortSignal.timeout(120_000)])
  const engine = format === 'mp3' ? undefined : ttss[tts]?.()
  if (format === 'wav' && !engine) return bad(`no voice "${tts}" (VOICE_TTS)`, 500)
  let audio: Uint8Array
  try {
    const got = await inOrder(parts(text), signal, (part, s) => (engine ? engine.speak(part, voice, s) : modelsSpeech(part, voice, s, { format: 'mp3' })).then(bytesOf))
    const all = Buffer.concat(got) // MP3 is frames, so files from one voice join end to end; PCM joins as samples
    audio = format === 'wav' ? wav(all) : all
  } catch (e) {
    return bad(`no speech: ${(e as Error).message}`, 502)
  } finally {
    engine?.close()
  }
  const file = join(mediaDir(o.session || 'speech'), `speech-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.${format}`) // two in one millisecond are two files
  await writeFile(file, audio, { mode: 0o600 })
  const seconds = format === 'wav' ? Math.round((audio.length - 44) / 4800) / 10 : undefined
  return { status: 200, body: { text: `Saved ${file} (${format}${seconds === undefined ? '' : `, ${seconds} s`}, ${Math.ceil(audio.length / 1024)} KB).`, files: [file], format, ...(voice && { voice }), ...(seconds !== undefined && { seconds }), bytes: audio.length } }
}

/** The words of an audio or video file Whisper reads (up to 25 MB), as a call hears them: what it believes is speech,
 * Serbian in Latin script. `language`: its ISO 639-1 code when known (detected otherwise). A relative path is the
 * workspace's (KORTIX_WORKSPACE), else the relay's working folder. */
export async function transcribe(ask: { file?: unknown; language?: unknown }, o: { signal?: AbortSignal } = {}): Promise<Reply> {
  const file = typeof ask.file === 'string' ? ask.file.trim() : ''
  if (!file) return bad('`file` is required: the audio file\'s path')
  const path = isAbsolute(file) ? file : resolve(process.env.KORTIX_WORKSPACE || process.cwd(), file)
  const as = AUDIO[extname(path).slice(1).toLowerCase()]
  if (!as) return bad(`${basename(path)} is not a file Whisper reads (${Object.keys(AUDIO).join(', ')}): convert it first (ffmpeg -i in out.mp3)`)
  // One handle for the check and the read: a path swapped between a stat and a readFile cannot slip past the checks.
  const handle = await open(path, 'r').catch(() => undefined)
  if (!handle) return bad(`no file at ${path}`, 404)
  let audio: Buffer
  try {
    const info = await handle.stat()
    if (!info.isFile()) return bad(`no file at ${path}`, 404)
    if (info.size > MAX_BYTES) return bad(`${basename(path)} is ${(info.size / 2 ** 20).toFixed(1)} MB, more than 25: cut it (ffmpeg -t) or make it smaller (ffmpeg -ac 1 -b:a 32k)`)
    audio = await handle.readFile()
  } finally {
    await handle.close()
  }
  if (audio.length > MAX_BYTES) return bad(`${basename(path)} grew past 25 MB while it was read`)
  const language = typeof ask.language === 'string' && /^[a-z]{2}$/i.test(ask.language.trim()) ? ask.language.trim().toLowerCase() : undefined
  const model = process.env.WHISPER_MODEL ?? 'whisper-large-v3'
  const form = new FormData()
  form.append('file', new Blob([audio]), `audio.${as}`)
  form.append('model', model)
  if (language) form.append('language', language)
  // The product's and the project's names, spelled as they are, as a call's Whisper gets them: a dev voice note's
  // "Hello from Kortix voice" came back "Hello from Cordix Voice." without them.
  const hint = vocab()
  if (hint.length) form.append('prompt', hint.join(', '))
  form.append('temperature', '0')
  form.append('response_format', 'verbose_json')
  let res: Response
  try {
    res = await sttFetch({ method: 'POST', headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, body: form, signal: AbortSignal.any([...(o.signal ? [o.signal] : []), AbortSignal.timeout(120_000)]) })
  } catch (e) {
    return bad(`speech-to-text unreachable: ${(e as Error).message}`, 502)
  }
  if (!res.ok) return bad(`speech-to-text answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`, 502)
  const j = (await res.json().catch(() => ({}))) as { segments?: Seg[]; language?: string; duration?: number; text?: string }
  const seconds = Math.round((Number(j.duration) || 0) * 10) / 10
  chargeStt(model, seconds)
  const lang = j.language ? ISO[j.language.toLowerCase()] ?? j.language.toLowerCase() : language
  const heardWords = (Array.isArray(j.segments) ? j.segments.filter(heard).map((s) => s.text).join('') : String(j.text ?? '')).trim()
  // On unclear audio Whisper can read its prompt back ("Kortix, Bun, TypeScript"): words that are all the hint's are none.
  const hinted = new Set(hint.join(' ').toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [])
  const said = heardWords.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []
  const words = said.length && said.every((w) => hinted.has(w)) ? '' : heardWords
  const text = family(lang ?? '') === 'sh' ? serbianLatin(words) : words
  return { status: 200, body: { text: text || '(no speech in it)', ...(lang && { language: lang }), seconds } }
}
