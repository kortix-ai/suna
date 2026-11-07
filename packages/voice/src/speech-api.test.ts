import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Speech with or without a call (POST /speech, src/speech-api.ts): the agent's voice into an audio file, an audio file's
// words. A channel's voice note reached the agent as a file with "No speech-to-text tool is preinstalled", and its voice
// reached nothing but its own calls. A fake models base stands in for the gateway: no network, no real voice.
const keys = ['VOICE_MODELS_URL', 'VOICE_MODELS_TOKEN', 'VOICE_MEDIA_DIR', 'VOICE_TTS', 'VOICE_MOCK_TTS_MS', 'INWORLD_VOICE', 'INWORLD_MODEL', 'INWORLD_WORKSPACE', 'KORTIX_WORKSPACE', 'VOICE_TOKEN', 'WHISPER_MODEL']
const saved = keys.map((k) => process.env[k])
const dir = mkdtempSync(join(tmpdir(), 'speech-api-test-'))
type Got = { path: string; json?: any; form?: Record<string, string>; file?: { name: string; size: number } }
const got: Got[] = []
const gateway = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const u = new URL(req.url)
    if (u.pathname === '/v1/audio/voices') return Response.json({ data: [{ id: 'Ashley', description: 'warm female' }, { id: 'Dennis', description: 'deep calm male narrator' }, { id: 'other-ws__clone', description: 'deep calm male' }] })
    if (u.pathname === '/v1/audio/speech') {
      const json = await req.json()
      got.push({ path: u.pathname, json })
      return new Response(new TextEncoder().encode(`[${json.input.length}]`), { headers: { 'content-type': 'audio/mpeg' } })
    }
    if (u.pathname === '/v1/audio/transcriptions') {
      const f = await req.formData()
      const form: Record<string, string> = {}
      let file: Got['file']
      f.forEach((v, k) => (typeof v === 'string' ? (form[k] = v) : (file = { name: (v as File).name, size: v.size })))
      got.push({ path: u.pathname, form, file })
      // A file of 1111 bytes: unclear audio, where Whisper reads its prompt back.
      if (file?.size === 1111) return Response.json({ language: 'english', duration: 2, segments: [{ text: ' Kortix, Bun, TypeScript.', no_speech_prob: 0.2, avg_logprob: -0.5, compression_ratio: 1 }] })
      return Response.json({ language: 'serbian', duration: 3.42, text: 'Здраво, како си? Thank you.', segments: [
        { text: 'Здраво, како си?', no_speech_prob: 0.01, avg_logprob: -0.2, compression_ratio: 1.1 },
        { text: ' Thank you.', no_speech_prob: 0.9, avg_logprob: -1.3, compression_ratio: 1 }, // noise Whisper made words of
      ] })
    }
    return new Response('not found', { status: 404 })
  },
})
let relay: { port?: number; stop(force?: boolean): void }
const post = async (body: unknown) => {
  const r = await fetch(`http://127.0.0.1:${relay.port}/speech`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, body: (await r.json()) as any }
}

beforeAll(async () => {
  for (const k of keys) delete process.env[k]
  process.env.VOICE_MODELS_URL = `http://127.0.0.1:${gateway.port}/v1`
  process.env.VOICE_MEDIA_DIR = dir
  process.env.VOICE_TTS = 'mock'
  process.env.VOICE_MOCK_TTS_MS = '0'
  const { serve } = await import('./server')
  relay = serve(0)
})
afterAll(() => {
  relay?.stop(true)
  gateway.stop(true)
  rmSync(dir, { recursive: true, force: true })
  keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i] })
})

test('a short text is one mp3 file in the session folder, in the default voice', async () => {
  const n = got.length
  const r = await post({ session: 'ses-1', speak: { text: 'Hello from the voice.' } })
  expect(r.status).toBe(200)
  expect(r.body.format).toBe('mp3')
  const file = r.body.files[0] as string
  expect(file.startsWith(join(dir, 'ses-1'))).toBe(true)
  expect(readFileSync(file).toString()).toBe('[21]')
  expect(r.body.text).toContain(file)
  expect(got.slice(n).map((g) => g.json)).toEqual([{ model: 'inworld-tts-2', input: 'Hello from the voice.', voice: 'Ashley', response_format: 'mp3' }])
})

test('a long text goes in parts of at most 1,000 characters, cut after sentences, joined in order', async () => {
  const long = 'This sentence is here to make the text long enough to need several parts. '.repeat(40).trim()
  const n = got.length
  const r = await post({ speak: { text: long } })
  const parts = got.slice(n).map((g) => g.json.input as string)
  expect(r.status).toBe(200)
  expect(parts.length).toBe(4)
  expect(parts.every((p) => p.length <= 1000 && p.endsWith('.'))).toBe(true)
  expect(parts.join(' ')).toBe(long)
  expect(readFileSync(r.body.files[0]).toString()).toBe(parts.map((p) => `[${p.length}]`).join(''))
})

test('two files at once are two files', async () => {
  const [a, b] = await Promise.all([post({ speak: { text: 'One.' } }), post({ speak: { text: 'Two.' } })])
  expect(a.body.files[0]).not.toBe(b.body.files[0])
})

test('a voice asked for by description is the catalog voice, never another workspace\'s clone', async () => {
  const n = got.length
  const r = await post({ speak: { text: 'Deep and calm.', voice: 'deep calm male' } })
  expect(r.body.voice).toBe('Dennis')
  expect(got[n]?.json.voice).toBe('Dennis')
  const none = await post({ speak: { text: 'Hm.', voice: 'a squeaky robot from mars' } })
  expect(none.status).toBe(400)
  expect(none.body.error).toContain('no voice like')
})

test('wav comes from the call\'s own voice: PCM16 mono 24 kHz in a valid header', async () => {
  const r = await post({ speak: { text: 'A wave file, please.', format: 'wav' } })
  const w = readFileSync(r.body.files[0])
  const pcm = w.length - 44
  expect(w.toString('ascii', 0, 4) + w.toString('ascii', 8, 12)).toBe('RIFFWAVE')
  expect([w.readUInt16LE(20), w.readUInt16LE(22), w.readUInt32LE(24), w.readUInt16LE(34), w.readUInt32LE(40), w.readUInt32LE(4)]).toEqual([1, 1, 24000, 16, pcm, 36 + pcm])
  expect(pcm).toBeGreaterThan(0)
  expect(Math.abs(r.body.seconds - pcm / 48000)).toBeLessThan(0.06)
})

test('speak refuses what it cannot do, with what to do instead', async () => {
  for (const [body, error] of [
    [{ speak: { text: '  ' } }, /text/],
    [{ speak: { text: 'a'.repeat(20_001) } }, /20000/],
    [{ speak: { text: 'Hi.', format: 'flac' } }, /mp3 or wav/],
    [{ session: 'x' }, /speak|transcribe/],
  ] as const) {
    const r = await post(body)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(error)
  }
})

test('no page reaches it: text/plain and any request with Origin are refused, a vendor voice is never a path', async () => {
  const n = got.length
  const plain = await fetch(`http://127.0.0.1:${relay.port}/speech`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ speak: { text: 'From a page.' } }) })
  expect(plain.status).toBe(415)
  const page = await fetch(`http://127.0.0.1:${relay.port}/speech`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ transcribe: { file: '/etc/hosts.mp3' } }) })
  expect(page.status).toBe(403)
  expect((await fetch(`http://127.0.0.1:${relay.port}/call`, { headers: { origin: 'https://evil.example' } })).status).toBe(403)
  expect(got.length).toBe(n)
  const path = await post({ speak: { text: 'Hm.', voice: '../../user/subscription', format: 'wav' } })
  expect(path.status).toBe(400)
  expect(path.body.error).toContain('voice id')
})

test('transcribe: a Telegram voice note goes up as Ogg, only the words Whisper believes, Serbian in Latin', async () => {
  const note = join(dir, 'voice_message.oga')
  writeFileSync(note, Buffer.alloc(2048, 7))
  const n = got.length
  const r = await post({ transcribe: { file: note, language: 'SR' } })
  expect(r.body).toEqual({ text: 'Zdravo, kako si?', language: 'sr', seconds: 3.4 })
  expect(got[n]?.file).toEqual({ name: 'audio.ogg', size: 2048 })
  expect(got[n]?.form).toMatchObject({ model: 'whisper-large-v3', language: 'sr', temperature: '0', response_format: 'verbose_json' })
  // The call's hint: the product's names spelled as they are ("Kortix", not "Cordix").
  expect(got[n]?.form?.prompt).toContain('Kortix')
  process.env.KORTIX_WORKSPACE = dir
  const relative = await post({ transcribe: { file: 'voice_message.oga' } })
  expect(relative.body.text).toBe('Zdravo, kako si?')
  expect(got.at(-1)?.form?.language).toBeUndefined()
})

test('transcribe: the hint read back on unclear audio is no speech', async () => {
  const murmur = join(dir, 'murmur.ogg')
  writeFileSync(murmur, Buffer.alloc(1111, 3))
  const r = await post({ transcribe: { file: murmur } })
  expect(r.body.text).toBe('(no speech in it)')
})

test('transcribe refuses a missing, unreadable or too large file, sending nothing', async () => {
  const big = join(dir, 'big.mp3')
  writeFileSync(big, '')
  truncateSync(big, 26 * 1024 * 1024)
  writeFileSync(join(dir, 'notes.txt'), 'hello')
  for (const [file, status, error] of [
    ['', 400, /file/],
    [join(dir, 'gone.mp3'), 404, /no file/],
    [join(dir, 'notes.txt'), 400, /not a file Whisper reads/],
    [big, 400, /more than 25/],
  ] as const) {
    const before = got.length
    const r = await post({ transcribe: { file } })
    expect(r.status).toBe(status)
    expect(r.body.error).toMatch(error)
    expect(got.length).toBe(before)
  }
})

test('the voice_speak and voice_transcribe tools send /speech, not /call', async () => {
  const { META_TOOLS, callRelay } = await import('./voice-tools')
  const tool = (name: string) => META_TOOLS.find((t) => t.name === name)!
  const relayUrl = { url: `http://127.0.0.1:${relay.port}`, session: 'ses-2' }
  const said = await callRelay(relayUrl, tool('voice_speak'), { text: 'Through the tool.' })
  expect(said.files[0]?.startsWith(join(dir, 'ses-2'))).toBe(true)
  const heard = await callRelay(relayUrl, tool('voice_transcribe'), { file: join(dir, 'voice_message.oga') })
  expect(heard.text).toBe('Zdravo, kako si?')
  expect(tool('voice_transcribe').readOnly).toBe(true)
  expect(tool('voice_speak').readOnly).toBeUndefined()
})
