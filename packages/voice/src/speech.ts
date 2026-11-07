// Speech stages behind two seams, so each can be swapped for the fastest one available
// (RESEARCH.md §3.6). STT: feed 16 kHz PCM16 frames, commit at a pause, get the final text in order.
// TTS: one sentence in, a PCM16 24 kHz stream out.
import { NAME } from './name'
import { chargeReply, chargeStt, chargeTts } from './cost'
import { hedged } from './hedge'
import { ISO, family, serbianLatin } from './lang'
import { b64 } from './model'
import { modelsHeaders, sttFetch, speechUrl, viaModels, voicesUrl } from './models'

// Vendor error text reaches stderr verbatim: drop line breaks so it cannot forge log lines (CodeQL js/log-injection).
const oneline = (v: unknown) => String(v).replace(/[\r\n]+/g, ' ')

export type Stt = { feed(pcm: Uint8Array, loud: boolean): void; commit(): void; peek?(): Promise<string>; speculate?(): void; close(): void }
export type SttEvents = { ready(): void; text(t: string, lang?: string, conf?: number): void; close(why: string): void; keep?(t: string): boolean; lang?: string; guess?(t: string): void; names?(): string[]; model?: string; engine?: 'groq' | 'gemini' } // names: said in this call, for the prompt // guess: a speculative transcript // keep: a short result too precious to drop (the wake name); lang: the call's starting language
// Voiced speech crosses zero far less often than noise: median zero-crossing rate 0.05-0.14 per sample for
// the bench's speech, 0.50 for broadband noise; 70-100% of loud speech frames are under 0.25, no noise frame is.
// Whisper never hears a segment without vowels in it (it invents "Okay, let's go." for noise).
export const voiced = (pcm: Uint8Array) => {
  const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1)
  let z = 0
  for (let i = 1; i < s.length; i++) if (s[i]! >= 0 !== s[i - 1]! >= 0) z++
  return z / s.length < 0.25
}
// Rare words bias Whisper (a custom vocabulary cut rare-word errors ~60%, RESEARCH.md §2.12): product names,
// plus the workspace's own file names, shallowest first, when it is a git repo.
const MIN_LOUD = 120, MIN_VOICED = 80 // ms of a piece above the gate, and voiced, before Whisper hears it
// Opt-in (VOICE_TRACE_AUDIO=1 with VOICE_TRACE_DIR): every caller piece sent to Whisper is kept next to the call traces,
// as a WAV and what Whisper returned per segment and what survived the filters, to see why words went missing. It stores
// the caller's voice: off by default.
const CAPTURE = process.env.VOICE_TRACE_AUDIO === '1' && process.env.VOICE_TRACE_DIR ? `${process.env.VOICE_TRACE_DIR}/audio` : undefined
const repo = process.env.VOICE_WORKSPACE ?? process.env.KORTIX_WORKSPACE
// Code files only, not tests, benches or notes: their names ("named-evidence-proof", "personas") took prompt slots real words need.
const files = repo ? Bun.spawnSync(['git', '-C', repo, 'ls-files']).stdout.toString().split('\n').filter((f) => /\.(?:tsx?|jsx?|mjs|py|go|rs|rb|java|kt|swift|cs|php|vue|svelte)$/.test(f) && !/(?:^|\/)(?:bench|tests?|__tests__|fixtures|runs|spec)\//.test(f) && !/\.(?:test|spec)\.[^/]+$/.test(f)) : []
const names = files.sort((a, b) => a.split('/').length - b.split('/').length).map((f) => f.split('/').pop()!.replace(/\.\w+$/, ''))
const terms = [...(process.env.VOCAB ?? `${NAME},Kortix,Bun,TypeScript`).split(',').map((t) => t.trim()), ...names.filter((n) => /^\w[\w-]{2,23}$/.test(n))]
const VOCAB = terms.filter((t, i) => terms.findIndex((u) => u.toLowerCase() === t.toLowerCase()) === i).slice(0, 40)
/** The names Whisper is biased toward (the product's and the project's), for reading a turn as it was said. */
export const vocab = () => VOCAB
// STT_LANG pins the language; unset, Whisper detects it and the call follows the user (see `whisper`).
const FILL = Number(process.env.VOICE_FILL_WPS ?? 10) // words per loud second above which a transcript is a Whisper fill-in
export const LANG = process.env.STT_LANG && process.env.STT_LANG !== 'auto' ? process.env.STT_LANG : undefined
const LANGS = process.env.VOICE_LANGS?.split(',') // optional allowlist: anything else detected is a misdetection
const SWITCH = /\b(switch|change|speak|talk|reply|answer|continue|cambi\w*|habl\w*|pre[dđ]\w*|pri[cč]aj\w*|govori\w*|sprich\w*|wechs\w*|parl\w*|passons)\b/i
const NAMED: [RegExp, string][] = [
  [/\b(english|ingl[eé]s|engleski|englisch|anglais|inglese)\b/i, 'en'],
  [/\b(serbian|srpski|serbisch|serbio|serbe|croatian|hrvatski|bosnian)\b/i, 'sr'],
  [/\b(spanish|espa[nñ]ol|spanisch|espagnol|[sš]panski)\b/i, 'es'],
  [/\b(german|deutsch|alem[aá]n|nema[cč]ki|allemand)\b/i, 'de'],
  [/\b(french|fran[cç]ais|franc[eé]s|francuski|franz[oö]sisch)\b/i, 'fr'],
]

export const stts: Record<string, (e: SttEvents) => Stt> = {
  // Batch Whisper on Groq (~250 ms per clip): buffers the turn from 300 ms before speech onset.
  // Language: every clip is transcribed with detection (pinning English *translates* other languages:
  // "Zdravo, ja sam Marko" came back "I am Marko", measured). Language ID on a few words is a guess
  // ("Kako se zovem?" came back Hebrew and Polish; in a simulated Serbian call "Super, nego reci mi" came back
  // Swedish and "a koje sve jezike" an English translation), so a clip that disagrees with the call's language
  // is transcribed again in it (+~250 ms, only on disagreement) and Whisper's confidence decides: Serbian "Ćao"
  // scores -0.45 as English "Ciao" and -0.27 as Serbian; real English ~-0.15 vs ~-0.8 forced into Serbian
  // (measured). The prior matters too: a call switches to English or to the caller's own (browser) language,
  // rarely to anything else, so either of those wins on one clip of 3+ words and 1+ s of speech (a Spanish
  // call's "Can you tell me a quick joke?", 1.2 s, was kept Spanish by a stricter rule and heard as "tell me a
  // girl"); any other language needs two such clips in a row or a long one (5+ words, 1.5+ s). Words like
  // "mhm" and "okay" never vote.
  whisper(e) {
    let lang = LANG ?? e.lang ?? process.env.VOICE_LANG ?? 'en'
    const home = family(lang) // the browser's language
    let last = '' // the language the previous clip of 3+ words preferred over the call's
    // The words of a clip, and the language state it implies, applied only if the clip is used (a speculative
    // one may be thrown away).
    // Asked for in words ("Vamos a cambiar a inglés."): the next clip is heard in that language, before any vote
    // ("Can you tell me a quick joke?" right after it came back Spanish, "¿Puedes decirme una chica?").
    const heard = async (pcm: Uint8Array, ms: number, strict: boolean): Promise<{ text: string; apply(): void; conf?: number }> => {
      const r = await clip(pcm, ms, strict)
      const to = !LANG && SWITCH.test(r.text) ? NAMED.find(([re]) => re.test(r.text))?.[1] : undefined
      if (!to || (LANGS && !LANGS.map(family).includes(family(to)))) return r
      return { text: r.text, conf: r.conf, apply: () => (r.apply(), (lang = to), (last = '')) }
    }
    // conf: Whisper's mean log-probability of the words used (src/cascade.ts reads a low one as unsure hearing).
    const clip = async (pcm: Uint8Array, ms: number, strict: boolean): Promise<{ text: string; apply(): void; conf?: number }> => {
      const r = e.engine === 'gemini' ? await hearGemini(pcm, e.names?.()) : await transcribe(pcm, strict, e.keep, LANG, e.model, e.names?.())
      const f = r.lang && family(r.lang)
      if (LANG || !r.lang || f === family(lang) || !r.text) return { text: r.text, conf: r.conf, apply() {} }
      const p = e.engine === 'gemini' ? r : await transcribe(pcm, strict, e.keep, lang, e.model, e.names?.())
      const n = r.text.split(/\s+/).length
      const better = n >= 3 && r.conf > p.conf + 0.05 && (!LANGS || LANGS.map(family).includes(f!)) // "hr" for Serbian speech is Serbian
      const twice = better && f === last
      const likely = f === 'en' || f === home
      const apply = () => void (last = better ? f! : '')
      if (better && ms >= 1000 && (likely || twice || (ms >= 1500 && n >= 5))) return { text: r.text, conf: r.conf, apply: () => (apply(), (lang = r.lang!)) }
      // The call's language heard nothing: the other reading counts only if that language is likely and Whisper is sure
      // of it ("Važi, a reci mi" came back German "README-Kommentare.", a phantom turn the agent answered).
      return { text: p.text || (likely && r.conf > -0.5 ? r.text : ''), conf: p.text ? p.conf : r.conf, apply }
    }
    // Whisper finishes a phrase cut off mid-way with words nobody said ("Can you tell me |" came back "Can you
    // tell me how to use the BUN?"): 12–14 words per loud second of speech, where whole lines measure 1.9–4.0
    // (two Gemini voices) and up to 7.8 (the bench's fast xAI voice, "Tell me a quick joke."; a threshold of 6
    // held complete questions for 1.5 s). Too fast to be true: marked as trailing off, so the turn waits for the rest.
    const filled = (t: string, ms: number) => (t.split(/\s+/).length >= 4 && t.split(/\s+/).length / (ms / 1000) > FILL ? t.replace(/[.?!…]*$/, '…') : t)
    // A piece is sent to Whisper with at least MIN_LOUD ms above the gate, MIN_VOICED of them voiced: a short real word
    // ("No.", "Stop.", a split-off "Peru") has only ~200 ms above it and was never sent (11-34% of caller lines lost a
    // piece at normal mic levels); breaths, coughs, keys and hum stay empty (not voiced, or filtered after).
    // A transcript started at a short pause (speculate), kept if no speech followed before the commit: the text
    // is ready ~100 ms sooner, and the utterance is not cut into pieces Whisper would complete on its own.
    let early: Promise<{ text: string; apply(): void; conf?: number }> | undefined
    let lead: Uint8Array[] = []
    let frames: Uint8Array[] | undefined
    let speech = 0 // ms of loud frames in this segment
    let vowels = 0 // ms of them that are voiced
    let order = Promise.resolve()
    queueMicrotask(e.ready)
    return {
      feed(pcm, loud) {
        if (loud) (speech += (pcm.length / 32000) * 1000), (early = undefined) // they went on: the guess is stale
        if (loud && voiced(pcm)) vowels += (pcm.length / 32000) * 1000
        if (frames) return void frames.push(pcm)
        lead = [...lead.slice(-14), pcm]
        if (loud) frames = lead
      },
      speculate() {
        if (frames && speech >= MIN_LOUD && vowels >= MIN_VOICED && !early) (early = heard(Buffer.concat(frames), speech, true)).then((r) => r.text && e.guess?.(r.text))
      },
      commit() {
        // Under 250 ms of speech is a click, a breath or a cough: Whisper would invent words for it.
        const audio = frames && speech >= MIN_LOUD && vowels >= MIN_VOICED ? Buffer.concat(frames) : undefined
        const ms = speech
        const guess = early
        frames = early = undefined
        lead = []
        speech = vowels = 0
        if (process.env.DEBUG) console.error('cascade', performance.now() | 0, 'stt-commit', guess ? 'speculated' : '')
        const clip = audio && (guess ?? heard(audio, ms, true))
        order = order.then(async () => {
          const r = clip ? await clip : undefined
          r?.apply()
          e.text(r ? filled(r.text, ms) : '', lang, r?.conf)
        })
      },
      // The words so far, without ending the segment (deciding an overlap while it is still going).
      // Lenient: it only decides whether to pause, which is undone if the words were nothing.
      // whisper-large-v3-turbo: a peek only decides whether to pause (undoable), so speed beats accuracy (~120 ms sooner).
      peek: () => (frames && speech >= MIN_LOUD && vowels >= MIN_VOICED ? transcribe(Buffer.concat(frames), false, e.keep, lang, PEEK_MODEL, e.names?.()).then((r) => r.text) : Promise.resolve('')),
      close() {},
    }
  },
  // Whisper large-v3 turbo for every clip (27/27 exact on the bench's clips, 245 ms median vs v3's 217 ms, 26/27).
  'whisper-turbo': (e) => stts.whisper!({ ...e, model: 'whisper-large-v3-turbo' }),
  // Gemini 3.5 Flash-Lite hears each turn with the call's names, by meaning ("run ls", not "Ron Ellis"): ~1.2 s a turn.
  gemini: (e) => stts.whisper!({ ...e, engine: 'gemini' }),
  // ElevenLabs Scribe v2 Realtime, manual commits: the committed text is final, unlike its partials.
  scribe(e) {
    const terms = VOCAB.map((t) => `&keyterms=${encodeURIComponent(t)}`).join('')
    const ws = new WebSocket(
      `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=pcm_16000&commit_strategy=manual&language_code=${LANG}${terms}`,
      { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY! } } as any,
    )
    let commit = false
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data))
      if (d.message_type === 'session_started') e.ready()
      else if (d.message_type === 'committed_transcript') e.text(d.text ?? '')
      else if (d.message_type?.endsWith('error')) console.error('[cascade stt]', oneline(d.message_type), oneline(d.error))
    }
    ws.onclose = (m) => e.close(`scribe ${m.code} ${m.reason}`)
    return {
      feed(pcm) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: b64(pcm), sample_rate: 16000, commit }))
        commit = false
      },
      commit: () => void (commit = true),
      close: () => ws.close(),
    }
  },
}

const PEEK_MODEL = process.env.WHISPER_PEEK_MODEL ?? 'whisper-large-v3-turbo'
// A turn heard by Gemini 3.5 Flash-Lite, given the names this call and project use: it resolves sound-alikes by meaning,
// at ~1.2 s a turn (bench clips: 24/27 exact, 1205 ms median). The call keeps its language (no detection here).
async function hearGemini(pcm: Uint8Array, names: string[] = []): Promise<{ text: string; lang?: string; conf: number }> {
  const head = Buffer.alloc(44)
  head.write('RIFF', 0), head.writeUInt32LE(36 + pcm.length, 4), head.write('WAVEfmt ', 8), head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20), head.writeUInt16LE(1, 22), head.writeUInt32LE(16000, 24), head.writeUInt32LE(32000, 28)
  head.writeUInt16LE(2, 32), head.writeUInt16LE(16, 34), head.write('data', 36), head.writeUInt32LE(pcm.length, 40)
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_STT_MODEL ?? 'gemini-3.5-flash-lite'}:generateContent`, {
    method: 'POST', headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY!, 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: `Transcribe exactly what the caller says on this voice call, in their language. Names they may use: ${[...VOCAB, ...names].join(', ')}. If nothing is said, reply with nothing. Reply with only their words.` }, { inlineData: { mimeType: 'audio/wav', data: Buffer.concat([head, pcm]).toString('base64') } }] }], generationConfig: { temperature: 0, thinkingConfig: { thinkingLevel: 'minimal' } } }),
  }).catch(() => undefined)
  const j = (await res?.json().catch(() => undefined)) as any
  chargeReply('stt', process.env.GEMINI_STT_MODEL ?? 'gemini-3.5-flash-lite', j)
  const text = ((j?.candidates?.[0]?.content?.parts ?? []) as any[]).map((p) => p.text ?? '').join('').trim()
  return { text, conf: text ? 0 : -9 }
}
async function transcribe(pcm: Uint8Array, strict = true, keep?: (t: string) => boolean, lang?: string, model = process.env.WHISPER_MODEL ?? 'whisper-large-v3', names: string[] = []): Promise<{ text: string; lang?: string; conf: number }> {
  const extra = names.filter((n) => !VOCAB.some((v) => v.toLowerCase() === n.toLowerCase())).slice(0, 15)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0), head.writeUInt32LE(36 + pcm.length, 4), head.write('WAVEfmt ', 8), head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20), head.writeUInt16LE(1, 22), head.writeUInt32LE(16000, 24), head.writeUInt32LE(32000, 28)
  head.writeUInt16LE(2, 32), head.writeUInt16LE(16, 34), head.write('data', 36), head.writeUInt32LE(pcm.length, 40)
  const file = Buffer.concat([head, pcm])
  const wav = new Blob([file], { type: 'audio/wav' })
  const form = new FormData()
  form.append('file', wav, 'turn.wav')
  form.append('model', model)
  if (lang) form.append('language', lang)
  form.append('prompt', [...VOCAB, ...extra].join(', ')) // biases rare product words, and the names this call already used
  form.append('temperature', '0')
  form.append('response_format', 'verbose_json')
  // Hedged: Groq is 255 ms p50, 392 ms p90, but 2.1 s at worst (n = 30, measured); a second request after HEDGE
  // ms, the first answer wins (Dean & Barroso, "The Tail at Scale": big tail cuts for a few % more requests).
  // A turn's own clip (strict) is the transcript every answer waits on: two requests at once (RACE), the first answer
  // wins. 48 paired clips of the bench's questions, alternating: 266 ms mean, 281 p50, 322 p90 hedged at 400 vs 243,
  // 241, 291 raced (2026-11-02). Peeks, which only decide or warm, keep the one request.
  const res = await hedged((signal) =>
    sttFetch({ method: 'POST', signal, headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'user-agent': 'voice-agent' }, body: form })
      .then((r) => (r.ok && chargeStt(model, pcm.length / 32000, strict ? undefined : 'peek'), r)), // each answered request is billed, a race's or hedge's second too
    strict ? RACE : HEDGE,
  ).catch(() => undefined)
  if (!res?.ok) return console.error('[cascade whisper]', res?.status, await res?.text()), { text: '', conf: -9 }
  // Whisper invents text for noise and echo. Keep only segments it believes are speech.
  const { segments = [], language } = (await res.json()) as { segments?: Seg[]; language?: string }
  const detected = language && (ISO[language.toLowerCase()] ?? language.toLowerCase())
  let text = segments.filter(heard).map((s) => s.text).join('').trim()
  // One or two words is where hallucinations live ("CometEdit" from echo): demand more confidence,
  // except for a command, which is never a stock hallucination and costs more to miss than to mishear.
  // Short real words score -0.5 to -0.9 ("Thanks, bye." -0.54, "Hey, what?" -0.59, "Sweet!" -0.75, all with no-speech
  // 0.00, dropped at -0.5 in simulated calls: 0.85 of the caller's words reached the agent); noise read as words
  // scores worse or is marked as no speech ("Reth.me" 0.87/-0.81, "Ovoaip." 0.43/-1.08).
  const sure = segments.every((s) => (s.no_speech_prob < 0.3 && s.avg_logprob > -0.8) || s.avg_logprob > -0.4)
  if (strict && text.split(/\s+/).length <= 2 && !sure && !COMMAND.test(text) && !keep?.(text)) text = ''
  if (process.env.DEBUG && !text) console.error('whisper dropped', JSON.stringify(segments.map((s) => [s.text, s.no_speech_prob.toFixed(2), s.avg_logprob.toFixed(2), s.compression_ratio.toFixed(1)])))
  // On unclear audio Whisper can read back its own prompt ("Kortix, Bun, TypeScript").
  const said = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []
  // Whisper's stock phrases on noise ("Thank you.") are also what callers say last: kept when Whisper is certain.
  const certain = segments.every((s) => s.no_speech_prob < 0.1 && s.avg_logprob > -0.7)
  const prompted = new Set([...PROMPT, ...extra.flatMap((n) => n.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [])])
  if (said.every((w) => prompted.has(w)) || (HALLUCINATION.test(text) && (!certain || SUBTITLE.test(text) || REPEATED.test(text)))) text = ''
  // Serbian comes back in Cyrillic when pinned ("Какво ће време"): Latin, as the user would type it.
  const conf = segments.length ? segments.reduce((a, s) => a + s.avg_logprob, 0) / segments.length : -9
  if (CAPTURE && strict) {
    const id = `${CAPTURE}/${new Date().toISOString().replace(/[:.]/g, '-')}-${model}`
    void Bun.write(`${id}.wav`, file).catch(() => {})
    void Bun.write(`${id}.json`, JSON.stringify({ ms: pcm.length / 32, model, lang: lang ?? null, detected: detected ?? null, text, segments })).catch(() => {})
  }
  return { text: family(detected ?? '') === 'sh' ? serbianLatin(text) : text, lang: detected, conf }
}
// xAI reads at ~219 wpm (207 by the simulator's measure); people talk at 160–190 and synthetic speech at 178 is
// understood worse than at 155 (RESEARCH.md §2.15). 0.9: 185 wpm on the same text (0.8: 165, measured).
const SPEED = Number(process.env.XAI_SPEED ?? 0.9)
const HEDGE = Number(process.env.VOICE_HEDGE_MS ?? 400)
const RACE = Number(process.env.VOICE_STT_RACE_MS ?? 0) // a turn's clip: the second request after this many ms
/** The first OK response of `run`, started once and again after `after` ms if the first has not answered. */
const COMMAND = /^(stop|wait|cancel|enough|no|hold on|hang on|one sec(ond)?)\b[\w\s]*[.!?]*$/i
const PROMPT = new Set(VOCAB.join(' ').toLowerCase().match(/[a-z0-9']+/g))

// Whisper's stock outputs for silence and noise (subtitles in its training data).
// Top non-speech outputs of large-v3 (Barański et al. 2025): "thank you" 24.8%, "thanks for watching" 10.3%, ...
// Whisper's stock words for noise ("and so on.", "and more." from a noisy room, a live call), not things people said.
// A text of nothing but them, once or repeated ("Thank you for watching! Thank you for watching!", a noisy room).
// Punctuation and space between the words are one run, so a long "..." or a repeated phrase cannot backtrack (CodeQL js/redos).
// A subtitle credit ("Subtitles by the Amara.org community") is cut out first: its open-ended words inside the
// pattern could each be read as one of the words above, and that backtracked exponentially.
const CREDIT = /subtitles by[^.!]*/gi
const HALLUCINATION_WORDS = /^[\s.!]*(?:(?:thank you(?: (?:so much|very much))?(?: for watching)?|thanks for watching|so|the|you|oh|bye|uh|um|and so on|and more|and so forth)[\s.!]*)*$/i
const HALLUCINATION = { test: (text: string) => HALLUCINATION_WORDS.test(text.replace(CREDIT, ' ')) }
// The ones from video subtitles: never what a caller says to an assistant, however sure Whisper is of them.
const SUBTITLE = /\b(for watching|subtitles|subscribe)\b/i
const REPEATED = /^(.{4,}?[.!?])\s*\1/i // the same sentence again at once: Whisper's loop on noise

// Text-to-speech behind one seam: one sentence in, a PCM16 24 kHz stream out. A factory per call, so
// a vendor can hold one warm connection for the whole call.
export type Speak = (text: string, voice: string | undefined, signal: AbortSignal, rate?: number) => Promise<Response> // rate: speaking speed (1 = the voice's own), where the provider takes one
// stream(): one utterance fed text as it comes (prosody carries across sentences, RESEARCH.md §2.13).
export type Utterance = { response: Response; add(text: string): void; end(): void }
export type Tts = { speak: Speak; stream?(voice: string | undefined, signal: AbortSignal): Utterance; close(): void }

const httpTts = (speak: Speak) => (): Tts => ({ speak, close() {} })

/** A Whisper segment (verbose_json). */
export type Seg = { text: string; no_speech_prob: number; avg_logprob: number; compression_ratio: number }
/** A segment Whisper believes is speech: its own skip rule (no speech AND low confidence), no repetition loop, and not
 * very low confidence. Whisper invents text for noise and echo. */
export const heard = (s: Seg) => !(s.no_speech_prob > 0.6 && s.avg_logprob < -1) && s.compression_ratio <= 2.4 && s.avg_logprob > -1.5

/** The voice a call speaks with unless it picks one: VOICE_TTS, else the models base (a Kortix box), else Inworld with its
 * key, else xAI. */
export const ttsDefault = (): string => process.env.VOICE_TTS ?? (viaModels() ? 'models' : process.env.INWORLD_API_KEY ? 'inworld' : 'xai-ws')

/** Speech through the models base (VOICE_MODELS_URL): OpenAI-shaped, streamed back as PCM16 24 kHz (a call's) or MP3 (a
 * file's, src/speech-api.ts). INWORLD_MODEL picks the model, INWORLD_VOICE the voice when none is given. */
export function modelsSpeech(text: string, voice: string | undefined, signal: AbortSignal, o: { rate?: number; model?: string; format?: 'pcm' | 'mp3' } = {}): Promise<Response> {
  const id = o.model ?? process.env.INWORLD_MODEL ?? 'inworld-tts-2'
  chargeTts(id, text)
  return fetch(speechUrl(), {
    method: 'POST',
    signal,
    headers: { ...modelsHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ model: id, input: text, voice: (voice && inworldId(voice)) || process.env.INWORLD_VOICE || 'Ashley', response_format: o.format ?? 'pcm', ...(o.format === 'mp3' ? {} : { sample_rate: 24000 }), ...(o.rate && o.rate !== 1 ? { speed: o.rate } : {}) }),
  })
}

// xAI's documented TTS languages (ISO 639-1 → its code). German, Spanish, French: Whisper reads the audio back
// word for word, first audio ~345 ms vs ~585 ms for Gemini Flash-Lite (measured). Serbian is not on the list and
// 2/6 of its sentences came back as English or Ukrainian (technical words like "fajl lang.ts"; Gemini 6/6), so
// Serbo-Croatian and every unlisted language stay on Gemini.
const XAI: Record<string, string> = { en: 'en', de: 'de', fr: 'fr', it: 'it', es: 'es-ES', pt: 'pt-PT', ru: 'ru', tr: 'tr', ja: 'ja', ko: 'ko', zh: 'zh', hi: 'hi', ar: 'ar-SA', id: 'id', vi: 'vi', bn: 'bn' }
/** Whether xAI speaks this language natively. */
export const xaiSpeaks = (lang: string) => lang in XAI

export const ttss: Record<string, (lang?: string, model?: string) => Tts> = {
  // xAI streaming TTS: one WebSocket per call (first audio ~290 ms warm vs ~330-530 ms over HTTP,
  // measured). Utterances are served in order; an utterance takes text until it ends (it speaks each
  // sentence as it completes, ~300-420 ms after the text, measured); an aborted one is text.clear.
  'xai-ws'(lang = 'en') {
    const params = `voice=${process.env.VOICE ?? 'ara'}&language=${XAI[lang] ?? 'auto'}&codec=pcm&sample_rate=24000&optimize_streaming_latency=${process.env.XAI_LATENCY ?? 1}&speed=${SPEED}` // 2 is ~40 ms sooner with audible chunk joins (xAI docs)
    let ws: WebSocket
    type Job = { text: string; out: ReadableStreamDefaultController<Uint8Array>; signal: AbortSignal; sent: boolean; open: boolean; done: boolean }
    const jobs: Job[] = []
    const send = (o: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o))
    const next = () => {
      while (jobs[0]?.signal.aborted) jobs.shift()!.out.close()
      const j = jobs[0]
      if (!j || ws.readyState !== WebSocket.OPEN) return
      if (j.text) send({ type: 'text.delta', delta: j.text }), (j.text = '')
      j.sent = true
      if (!j.open && !j.done) (j.done = true), send({ type: 'text.done' })
    }
    const job = (text: string, open: boolean, signal: AbortSignal) => {
      chargeTts('xai-tts', text) // billed by the characters sent; charged here, in the call's own context
      let j!: Job
      const body = new ReadableStream<Uint8Array>({
        start: (out) => {
          j = { text, out, signal, sent: false, open, done: false }
          jobs.push(j)
          signal.addEventListener('abort', () => {
            if (j === jobs[0] && j.sent) send({ type: 'text.clear' }) // audio.clear advances the queue
            else if (jobs.includes(j)) jobs.splice(jobs.indexOf(j), 1), out.close(), next()
          })
          next()
        },
      })
      return { j, response: new Response(body) }
    }
    const connect = () => {
      ws = new WebSocket(`wss://api.x.ai/v1/tts?${params}`, { headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` } } as any)
      ws.onopen = next
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data))
        const j = jobs[0]
        if (m.type === 'audio.delta' && j && !j.signal.aborted) j.out.enqueue(new Uint8Array(Buffer.from(m.delta, 'base64')))
        else if (m.type === 'audio.done' || m.type === 'audio.clear') jobs.shift()?.out.close(), next()
        else if (m.type === 'error') console.error('[tts xai-ws]', oneline(m.message))
      }
      ws.onclose = () => {
        for (const j of jobs.splice(0)) j.out.close()
        if (!closed) setTimeout(connect, 200)
      }
    }
    let closed = false
    connect()
    return {
      speak: (text, _voice, signal) => Promise.resolve(job(text, false, signal).response),
      stream(_voice, signal) {
        const { j, response } = job('', true, signal)
        return {
          response,
          add: (text) => (chargeTts('xai-tts', text), (j.text += text), j === jobs[0] && next()),
          end: () => ((j.open = false), j === jobs[0] && next()),
        }
      },
      close: () => ((closed = true), ws.close()),
    }
  },
  xai: (lang = 'en') =>
    httpTts((text, voice, signal) => {
      chargeTts('xai-tts', text)
      return fetch('https://api.x.ai/v1/tts', {
        method: 'POST',
        signal,
        headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text, voice_id: voice ?? 'ara', language: XAI[lang] ?? 'auto', output_format: { codec: 'pcm', sample_rate: 24000 }, speed: SPEED }),
      })
    })(),
  // Gemini TTS for every language but English: it reads the language from the text (Serbian, measured:
  // correct in Latin script, Russian-sounding in Cyrillic, so Serbian is transliterated); first audio ~460 ms.
  gemini: httpTts(async (text, _voice, signal) => {
    const model = process.env.GEMINI_TTS_MODEL ?? 'gemini-3.8-flash-lite-tts'
    chargeTts(model, serbianLatin(text))
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      signal,
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY!, 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: serbianLatin(text) }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.GEMINI_VOICE ?? 'Kore' } } } } }),
    })
    if (!res.ok || !res.body) return res
    // SSE of base64 PCM16 24 kHz chunks → a plain PCM stream, like the other vendors.
    const dec = new TextDecoder()
    let buf = ''
    const pcm = (res.body as ReadableStream<Uint8Array>).pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, out) {
          buf += dec.decode(chunk, { stream: true })
          for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
            const line = buf.slice(0, i)
            buf = buf.slice(i + 1)
            const data = line.startsWith('data: ') && JSON.parse(line.slice(6)).candidates?.[0]?.content?.parts?.[0]?.inlineData?.data
            if (data) out.enqueue(new Uint8Array(Buffer.from(data, 'base64')))
          }
        },
      }),
    )
    return new Response(pcm)
  }),
  // Inworld TTS-2 (the full model: it performs delivery tags, which Flash ignores; ~220 ms first audio vs Flash ~180,
  // measured 2026-11-01), every language, one voice per call. Before: Flash for English. Inworld TTS-2 Flash over HTTP streaming: 20 ms first audio server-side (P90, its docs) vs xAI's ~400 ms measured
  // here. Lines of JSON carry base64 PCM, turned into one PCM stream. INWORLD_API_KEY: the Portal's Base64 credentials,
  // sent as is; INWORLD_VOICE (default Ashley), INWORLD_MODEL. Flash for English; other languages get TTS-2 (+30 ms):
  // a Serbian sentence from Flash was heard by Whisper as English, from TTS-2 as Croatian, word for word (2026-11-01).
  inworld: (lang = 'en', model?: string) => ({ close() {}, speak: async (text, _voice, signal, rate) => {
    chargeTts(model ?? process.env.INWORLD_MODEL ?? 'inworld-tts-2', text)
    const res = await fetch('https://api.inworld.ai/tts/v1/voice:stream', {
      method: 'POST',
      signal,
      headers: { Authorization: `Basic ${process.env.INWORLD_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text, voiceId: (_voice && inworldId(_voice)) || process.env.INWORLD_VOICE || 'Ashley', modelId: model ?? process.env.INWORLD_MODEL ?? 'inworld-tts-2', audioConfig: { audioEncoding: 'PCM', sampleRateHertz: 24000, ...(rate && rate !== 1 ? { speakingRate: rate } : {}) } }),
    })
    if (!res.ok || !res.body) return res
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    const audio = (line: string) => {
      const m = JSON.parse(line) as { result?: { audioContent?: string }; error?: { message?: string } }
      if (m.error) throw Error(`inworld: ${m.error.message}`)
      return m.result?.audioContent ? new Uint8Array(Buffer.from(m.result.audioContent, 'base64')) : undefined
    }
    return new Response(new ReadableStream<Uint8Array>({
      async pull(c) {
        for (;;) {
          const i = buf.indexOf('\n')
          if (i >= 0) {
            const line = buf.slice(0, i).trim()
            buf = buf.slice(i + 1)
            const pcm = line ? audio(line) : undefined
            if (pcm?.length) return c.enqueue(pcm)
            continue
          }
          const { value, done } = await reader.read()
          if (done) {
            const pcm = buf.trim() ? audio(buf.trim()) : undefined
            buf = ''
            if (pcm?.length) c.enqueue(pcm)
            return c.close()
          }
          buf += dec.decode(value, { stream: true })
        }
      },
      cancel: () => void reader.cancel().catch(() => {}), // an aborted stream rejects its cancel (Bun 1.4): never an unhandled rejection
    }))
  } }),
  // A voice for conversation-flow tests: no provider, no characters spent. First audio after VOICE_MOCK_TTS_MS (180,
  // like Inworld Flash), then a quiet hum as long as the sentence would take (~15 characters a second), so turn-taking
  // and playback timing behave as in a call. A hum, not silence: the speaker drops leading silence, so an all-zero clip
  // was never played at all (no audio reached the caller, the turn never became audible). VOICE_TTS=mock.
  // Inworld TTS-2 Flash: ~40 ms sooner to first audio, performs sounds ([chuckle]) but ignores delivery tags.
  'inworld-flash': (lang = 'en') => ttss.inworld!(lang, 'inworld-tts-2-flash'),
  // The same voices through the models base (VOICE_MODELS_URL, a Kortix box): OpenAI-shaped speech that answers the
  // PCM itself, streamed. The default there; INWORLD_MODEL picks the model, as above.
  models: (_lang = 'en', model?: string) => ({ close() {}, speak: (text, voice, signal, rate) => modelsSpeech(text, voice, signal, { rate, model }) }),
  mock: httpTts(async (text, _voice, signal) => {
    chargeTts('mock', text) // free: the count of characters a real voice would bill
    await new Promise((r) => setTimeout(r, Number(process.env.VOICE_MOCK_TTS_MS ?? 180)))
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    const pcm = new Int16Array(Math.round((text.length / Number(process.env.VOICE_MOCK_TTS_CPS ?? 15)) * 24000)) // VOICE_MOCK_TTS_CPS: faster than speech for flow benches
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(800 * Math.sin((2 * Math.PI * 150 * i) / 24000)) // 150 Hz, ~-35 dBFS
    return new Response(new Uint8Array(pcm.buffer))
  }),
  eleven: httpTts((text, voice, signal) => {
    chargeTts(process.env.ELEVEN_TTS_MODEL ?? 'eleven_flash_v2_5', text)
    return fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice ?? 'EXAVITQu4vr4xnSDxMaL')}/stream?output_format=pcm_24000&optimize_streaming_latency=3`, {
      method: 'POST',
      signal,
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY!, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: process.env.ELEVEN_TTS_MODEL ?? 'eleven_flash_v2_5' }),
    })
  }),
}

// Fixed phrases are synthesized once per process and replayed from memory: zero TTS wait.
// The voices Inworld offers (314 on this key, each with a description and tags: "Bianca: deep, controlled female"),
// fetched once. A call's voice can be one by name, or a few words picked against them ("deep calm British male").
export type Voice = { id: string; about: string }
let voiceList: Promise<Voice[]> | undefined
export const inworldVoices = (): Promise<Voice[]> =>
  (voiceList ??= viaModels()
    ? fetch(voicesUrl(), { headers: modelsHeaders(), signal: AbortSignal.timeout(5000) })
        .then((r) => (r.ok ? (r.json() as Promise<{ data?: { id: string; description?: string; tags?: string[]; languages?: string[] }[] }>) : Promise.reject(Error(`voices ${r.status}`))))
        .then((j) => (known = (j.data ?? []).map((v) => ({ id: v.id, about: `${voiceName(v.id)} ${v.description ?? ''} ${(v.tags ?? []).join(' ')} ${(v.languages ?? []).join(' ')}`.toLowerCase() }))))
        .catch(() => ((voiceList = undefined), []))
    : process.env.INWORLD_API_KEY
    ? fetch('https://api.inworld.ai/tts/v1/voices', { headers: { Authorization: `Basic ${process.env.INWORLD_API_KEY}` }, signal: AbortSignal.timeout(5000) })
        .then((r) => (r.ok ? (r.json() as Promise<{ voices?: { voiceId: string; description?: string; tags?: string[]; languages?: string[] }[] }>) : Promise.reject(Error(`voices ${r.status}`)))) // a failed fetch is tried again next time, not kept as none
        .then((j) => (known = (j.voices ?? []).map((v) => ({ id: v.voiceId, about: `${voiceName(v.voiceId)} ${v.description ?? ''} ${(v.tags ?? []).join(' ')} ${(v.languages ?? []).join(' ')}`.toLowerCase() }))))
        .catch(() => ((voiceList = undefined), []))
    : Promise.resolve([]))
let known: Voice[] = [] // filled by inworldVoices() (the relay calls it at start)
/** An Inworld voice id for a name or a description: the name itself when it is one, else the voice whose description
 * shares the most of its words (gender words count double); the words as given when nothing is known yet. */
export function inworldVoice(want: string): string {
  const w = want.trim()
  // No catalog yet: only what looks like a voice id itself (a capitalized name: "Ashley"), never a description word.
  if (!known.length) return /^[A-Z][a-z]{2,20}$/.test(w) ? w : ''
  const exact = inworldId(w)
  if (exact) return exact
  // Whole words only ("man" is not in "woman" or "commanding"), and a person's words as the catalog says them.
  const SAME: Record<string, string> = { man: 'male', men: 'male', guy: 'male', boy: 'male', woman: 'female', women: 'female', girl: 'female', lady: 'female' }
  const words = (w.toLowerCase().match(/[a-z]+/g) ?? []).map((x) => SAME[x] ?? x).filter((x) => x.length > 2 && !/^(and|the|with|voice|sounding|like)$/.test(x))
  const score = (v: Voice) => {
    const has = new Set(v.about.match(/[a-z]+/g) ?? [])
    return words.reduce((s, x) => s + (has.has(x) ? (x === 'male' || x === 'female' ? 3 : 1) : 0) - ((x === 'male' && has.has('female')) || (x === 'female' && has.has('male')) ? 4 : 0), 0)
  }
  const best = known.filter((v) => ours(v.id)).map((v) => [v, score(v)] as const).sort((a, b) => b[1] - a[1])[0]
  return best && best[1] > 0 ? best[0].id : ''
}
/** A voice's name as a person says it: an account's own voices are "<workspace>__<name>" ("mellow-flute-9821__domagoj"
 * is Domagoj), the stock ones their id. */
export const voiceName = (id: string): string => ((n) => n.charAt(0).toUpperCase() + n.slice(1))(id.includes('__') ? id.slice(id.lastIndexOf('__') + 2) : id)
/** This deployment's own workspace in the voice catalog (INWORLD_WORKSPACE, e.g. "mellow-flute-9821"). The managed
 * catalog lists every workspace's voices, clones of real people among them: only the stock voices and this workspace's
 * are ever matched or offered, never another's (Strix on #11779). */
const workspace = () => (process.env.INWORLD_WORKSPACE ?? '').trim().toLowerCase()
export const ours = (id: string): boolean => !id.includes('__') || (!!workspace() && id.toLowerCase().startsWith(`${workspace()}__`))
/** A catalog voice id exactly as named (any case; an account's voice by its name too), else ''. What Inworld is sent:
 * never a fuzzy match. "Change your voice to Domagoj" set nothing while the reply said "Done": the voice is
 * "mellow-flute-9821__domagoj" in the catalog (a Kortix dev call, 2026-11-04). */
export function inworldId(v: string): string {
  const w = v.trim().toLowerCase()
  if (!known.length) return /^[A-Z][a-z]{2,20}$/.test(v.trim()) ? v.trim() : ''
  return known.find((x) => ours(x.id) && x.id.toLowerCase() === w)?.id ?? known.find((x) => x.id.includes('__') && ours(x.id) && voiceName(x.id).toLowerCase() === w)?.id ?? ''
}
/** Whether the catalog is in (a name it lacks is then really missing, not just unknown yet). */
export const voicesKnown = () => known.length > 0

const cache = new Map<string, Promise<Uint8Array | undefined>>()
export function cached(text: string, voice?: string, lang = 'en', via: 'xai' | 'gemini' | 'inworld' | 'mock' | 'models' = xaiSpeaks(lang) ? 'xai' : 'gemini'): Promise<Uint8Array | undefined> {
  const key = `${via}|${lang}|${voice ?? ''}|${text}`
  if (!cache.has(key))
    cache.set(
      key,
      (via === 'xai' ? ttss.xai!(lang) : via === 'inworld' ? ttss.inworld!(lang) : via === 'models' ? ttss.models!(lang) : via === 'mock' ? ttss.mock!() : ttss.gemini!())
        .speak(text, voice, new AbortController().signal)
        .then(async (r) => (r.ok ? trim(new Uint8Array(await r.arrayBuffer())) : undefined))
        .catch(() => undefined),
    )
  return cache.get(key)!
}

/**
 * A fixed phrase without its edges: 10 ms before the first sound, 120 ms after the last. xAI's "Okay." is 950 ms
 * of which ~550 ms is silence (116 ms before, 431 after, measured), and the agent's answer queued behind an
 * acknowledgment waited out that tail.
 */
function trim(pcm: Uint8Array, lead = 10, tail = 120): Uint8Array {
  const s = new Int16Array(pcm.slice().buffer, 0, pcm.length >> 1)
  let a = 0
  while (a < s.length && Math.abs(s[a]!) < 330) a++
  let b = s.length - 1
  while (b > a && Math.abs(s[b]!) < 330) b--
  if (a >= s.length) return pcm
  return pcm.slice(Math.max(0, a - lead * 24) * 2, Math.min(s.length, b + 1 + tail * 24) * 2)
}
