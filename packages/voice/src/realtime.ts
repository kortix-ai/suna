// OpenAI Realtime protocol. Serves xAI Grok Voice, ElevenLabs Eleven Realtime and OpenAI
// gpt-realtime; they differ only in URL, auth header and session shape. A tool result is held until the model is idle, then spoken.
import { type Hooks, type Opts, type Provider, b64, unb64 } from './model'

// A vendor's error text reaches stderr verbatim: drop line breaks so it cannot forge log lines (CodeQL js/log-injection).
const oneline = (v: unknown) => String(v).replace(/[\r\n]+/g, ' ')

const vendors = {
  xai: {
    url: (_: string) => 'wss://api.x.ai/v1/realtime',
    auth: () => ({ Authorization: `Bearer ${process.env.XAI_API_KEY}` }),
    model: 'grok-voice-3.0',
    session: (o: Opts) => ({
      ...(o.model && { model: o.model }),
      instructions: o.instructions,
      voice: o.voice ?? 'Ara',
      turn_detection: o.manual ? null : { type: 'server_vad', ...(o.vad && { silence_duration_ms: o.vad }) },
      audio: { input: { format: { type: 'audio/pcm', rate: 24000 } }, output: { format: { type: 'audio/pcm', rate: 24000 } } },
      input_audio_transcription: { model: 'grok-stt' },
      tools: o.tools.map((t) => ({ type: 'function', ...t })),
    }),
  },
  openai: {
    url: (model: string) => `wss://api.openai.com/v1/realtime?model=${model}`,
    auth: () => ({ Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }),
    model: 'gpt-realtime-2.1',
    session: (o: Opts) => ({
      type: 'realtime',
      instructions: o.instructions,
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          turn_detection: o.manual ? null : o.vad ? { type: 'server_vad', silence_duration_ms: o.vad } : { type: 'semantic_vad' },
          transcription: { model: 'gpt-realtime-whisper' },
        },
        output: { format: { type: 'audio/pcm', rate: 24000 }, voice: o.voice ?? 'marin' },
      },
      tools: o.tools.map((t) => ({ type: 'function', ...t })),
    }),
  },
  eleven: {
    url: (model: string) => `wss://api.elevenlabs.io/v1/convai/realtime?model=${model}`,
    auth: () => ({ 'xi-api-key': process.env.ELEVENLABS_API_KEY! }),
    model: 'eleven_realtime_v1_max',
    session: (o: Opts) => ({
      type: 'realtime',
      model: o.model ?? 'eleven_realtime_v1_max',
      instructions: o.instructions,
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          turn_detection: o.manual ? null : o.vad ? { type: 'server_vad', silence_duration_ms: o.vad } : { type: 'semantic_vad' },
          transcription: { model: 'scribe_v2_realtime' },
        },
        output: { format: { type: 'audio/pcm', rate: 24000 }, ...(o.voice && { voice: o.voice }) },
      },
      tools: o.tools.map((t) => ({ type: 'function', ...t })),
    }),
  },
}

export const realtime =
  (vendor: keyof typeof vendors): Provider =>
  (o: Opts, h: Hooks) => {
    const v = vendors[vendor]
    const ws = new WebSocket(v.url(o.model ?? v.model), { headers: v.auth() } as any)
    const send = (m: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m))
    let busy = false // a response is being generated
    let talking = false // the user is speaking
    let ready = false
    // Turns we start ourselves (tool results, injections) wait here until nobody is talking.
    let queue: { item: object; instructions?: string; transient?: boolean }[] = []
    const enqueue = (q: (typeof queue)[number]) => {
      queue = queue.filter((x) => !x.transient)
      queue.push(q)
      drain()
    }
    const drain = () => {
      if (busy || talking || !queue.length) return
      busy = true
      const { item, instructions } = queue.shift()!
      send({ type: 'conversation.item.create', item })
      send({ type: 'response.create', ...(instructions && { response: { instructions } }) })
    }
    const system = (text: string) => ({ type: 'message', role: 'system', content: [{ type: 'input_text', text }] })

    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data))
      if (process.env.DEBUG && !m.type.endsWith('.delta')) console.error(vendor, performance.now() | 0, oneline(m.type))
      switch (m.type) {
        case 'session.created':
          return send({ type: 'session.update', session: v.session(o) })
        case 'session.updated':
          if (!ready) (ready = true), h.ready()
          return
        case 'response.output_audio.delta':
          return h.audio(unb64(m.delta))
        case 'input_audio_buffer.speech_started':
          talking = true
          return h.clear()
        case 'input_audio_buffer.speech_stopped':
          talking = false
          return
        case 'response.created':
          busy = true
          return
        case 'response.done':
          busy = false
          return drain()
        case 'conversation.item.input_audio_transcription.completed':
          if (m.status === undefined || m.status === 'completed') h.text('user', m.transcript)
          return
        case 'response.output_audio_transcript.done':
          return h.text('agent', m.transcript.replace(/\[[a-z ]+\]\s*/gi, '').trim())
        case 'response.function_call_arguments.done':
          return h.tool(m.call_id, m.name, JSON.parse(m.arguments || '{}'))
        case 'error':
          return console.error(`[${vendor}]`, oneline(m.error?.message ?? m))
      }
    }
    ws.onclose = (e) => h.close(`${vendor} ${e.code} ${e.reason}`)

    return {
      inRate: 24000,
      outRate: 24000,
      audio: (pcm) => send({ type: 'input_audio_buffer.append', audio: b64(pcm) }),
      result: (call_id, _name, output) => {
        enqueue({ item: { type: 'function_call_output', call_id, output } })
      },
      // A system item alone is read as context; per-response instructions make the model speak it.
      say: (text, transient) =>
        enqueue({ item: system(`Update: ${text}`), instructions: `${o.instructions}\n\nNow tell the user: ${text}`, transient }),
      turn: (state) => {
        if (state === 'start') {
          talking = true
          h.clear()
          if (busy) send({ type: 'response.cancel' })
          return
        }
        talking = false
        busy = true
        send({ type: 'input_audio_buffer.commit' })
        send({ type: 'response.create' })
      },
      input: (text) => {
        h.text('user', text)
        enqueue({ item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
      },
      note: (text) => send({ type: 'conversation.item.create', item: system(`Context update, do not reply: ${text}`) }),
      close: () => ws.close(),
    }
  }
