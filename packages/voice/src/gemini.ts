// Gemini Live (BidiGenerateContent). Async tools use NON_BLOCKING + WHEN_IDLE, so the vendor
// decides when a late result is spoken. A connection lives ~10 min: on goAway the adapter opens a
// fresh session at the next turn boundary, seeded with this call's transcript. Session resumption
// is not used because it makes Google retain session state for up to 24 h (no zero retention).
import { type Provider, b64, unb64 } from './model'

const URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'

export const gemini: Provider = (o, h) => {
  let ws: WebSocket
  const history: string[] = [] // this call's finished turns, to seed a replacement session
  let away = false // server asked us to move to a new connection
  let retries = 0
  let closed = false
  let ready = false
  const pending = new Set<string>() // tool calls the model still waits on
  const dropped = new Set<string>() // tool calls the model gave up on (barge-in, reconnect)
  const said = { user: '', agent: '' }
  const send = (m: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m))
  const flush = (role: 'user' | 'agent') => {
    if (said[role].trim()) h.text(role, said[role].trim()), history.push(`${role}: ${said[role].trim()}`)
    said[role] = ''
  }
  const turn = (text: string, turnComplete: boolean) =>
    send({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete } })
  // Spoken injections never start over the user or over the model's own turn.
  let talking = false
  let speaking = false
  let later: { text: string; transient?: boolean }[] = []
  const flushLater = () => !talking && !speaking && later.length && turn(later.shift()!.text, true)
  const say = (text: string, transient?: boolean) => {
    later = later.filter((l) => !l.transient)
    later.push({ text: `[system] Tell the user: ${text}`, transient })
    flushLater()
  }

  function connect() {
    const sock = (ws = new WebSocket(`${URL}?key=${process.env.GEMINI_API_KEY}`))
    sock.onopen = () =>
      send({
        setup: {
          model: `models/${o.model ?? 'gemini-3.8-live'}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            ...(o.voice && { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: o.voice } } } }),
            ...(o.think && { thinkingConfig: isNaN(+o.think) ? { thinkingLevel: o.think } : { thinkingBudget: +o.think } }),
          },
          ...(o.vad && { realtimeInputConfig: { automaticActivityDetection: { endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH', silenceDurationMs: o.vad } } }),
          ...(o.manual && { realtimeInputConfig: { automaticActivityDetection: { disabled: true } } }),
          systemInstruction: { parts: [{ text: o.instructions + (history.length ? `\n\nThis call so far, oldest first:\n${history.slice(-30).join('\n')}` : '') }] },
          tools: [{ functionDeclarations: o.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters, behavior: 'NON_BLOCKING' })) }],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          contextWindowCompression: { slidingWindow: {} }, // lifts the 15 min audio session cap
        },
      })
    sock.onmessage = (e) => {
      const m = JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data as ArrayBuffer))
      if (process.env.DEBUG) console.error('gemini', performance.now() | 0, JSON.stringify(m, (k, v) => (k === 'data' ? `<${v.length}>` : v)).slice(0, 300))
      if (m.setupComplete) return (retries = 0), ready || ((ready = true), h.ready())
      if (m.goAway) away = true
      // Audio arrives faster than real time, so the vendor's turn is often over while the user still
      // hears it and `interrupted` never fires. Its VAD start (~60 ms) is the reliable barge-in cue.
      if (m.voiceActivity?.type === 'ACTIVITY_START') (talking = true), h.clear()
      if (m.voiceActivity?.type === 'ACTIVITY_END') talking = false
      for (const id of m.toolCallCancellation?.ids ?? []) pending.delete(id), dropped.add(id)
      for (const f of m.toolCall?.functionCalls ?? []) pending.add(f.id), h.tool(f.id, f.name, f.args ?? {})
      const sc = m.serverContent
      if (!sc) return
      for (const p of sc.modelTurn?.parts ?? []) if (p.inlineData?.data) (speaking = true), h.audio(unb64(p.inlineData.data))
      if (sc.inputTranscription?.text) said.user += sc.inputTranscription.text
      if (sc.outputTranscription?.text) flush('user'), (said.agent += sc.outputTranscription.text)
      if (sc.interrupted) h.clear()
      if (sc.turnComplete || sc.interrupted) flush('user'), flush('agent'), (speaking = false), flushLater()
      if (sc.turnComplete && away) away = false, sock.close(4000, 'goAway')
    }
    sock.onclose = (e) => {
      if (closed) return
      for (const id of pending) dropped.add(id)
      pending.clear()
      if (e.code !== 1007 && e.code !== 1008 && retries++ < 3) return connect() // 1007/1008: bad config, do not retry
      h.close(`gemini ${e.code} ${e.reason}`)
    }
  }
  connect()
  // Test hook: force the goAway path every N ms to exercise reconnects without 10 min calls.
  if (process.env.GEMINI_CYCLE_MS) setInterval(() => (away = true), +process.env.GEMINI_CYCLE_MS)

  return {
    inRate: 16000,
    outRate: 24000,
    audio: (pcm) => send({ realtimeInput: { audio: { data: b64(pcm), mimeType: 'audio/pcm;rate=16000' } } }),
    result: (id, name, output) => {
      later = later.filter((l) => !l.transient)
      if (!pending.delete(id)) return say(`Kortix finished. ${output}`) // the call was dropped: speak it anyway
      send({ toolResponse: { functionResponses: [{ id, name, response: { result: output, scheduling: 'WHEN_IDLE' } }] } })
    },
    say,
    input: (text) => (h.text('user', text), turn(text, true)),
    // Manual mode: the client owns turns. Hybrid (vendor VAD on): an external endpointer may only
    // hurry a turn end with audioStreamEnd; the vendor VAD still handles barge-in and backchannels.
    turn: (state) => {
      if (!o.manual) return state === 'end' && send({ realtimeInput: { audioStreamEnd: true } })
      talking = state === 'start'
      if (talking) h.clear()
      send({ realtimeInput: state === 'start' ? { activityStart: {} } : { activityEnd: {} } })
    },
    note: (text) => turn(`[system] Context update, do not reply: ${text}`, false),
    close: () => ((closed = true), ws.close()),
  }
}
