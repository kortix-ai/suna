// The voice in a Kortix box (kortix.ts): one relay per box, each session bound under its Kortix session id. Two fake
// pi sessions share a box: a message for one reaches only that one, both get the meta tools, the relay answers
// /health, the models go through the box's LLM proxy, and a session that shuts down is unbound. No network, no model.
import { expect, test } from 'bun:test'

process.env.KORTIX_VOICE_PORT = '0' // any free port
process.env.VOICE_TTS = 'mock'
delete process.env.VOICE_MODELS_URL
process.env.KORTIX_LLM_PROXY_URL = 'http://127.0.0.1:9' // the box's model proxy (never called here)
const { attach, relayPort } = await import('./kortix')
const brain = await import('./brain')
const { META_TOOLS } = await import('./voice-tools')

type Handler = (event: unknown, ctx?: unknown) => unknown
function fakePi(id: string) {
  const handlers = new Map<string, Handler[]>()
  const sent: string[] = []
  const tools: string[] = []
  const ctx = { isIdle: () => true, abort() {}, sessionManager: { getSessionId: () => id, getBranch: () => [] } }
  const pi = {
    on(event: string, fn: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), fn]); return () => {} },
    sendMessage() {},
    sendUserMessage(text: string) { sent.push(text) },
    registerTool(tool: { name: string }) { tools.push(tool.name) },
  }
  const emit = async (event: string) => { for (const fn of handlers.get(event) ?? []) await fn({ type: event }, ctx) }
  return { pi, sent, tools, emit }
}

test('sessions sharing a box each get their own calls, one relay serves them, a shut-down one is unbound', async () => {
  const a = fakePi('ses_pi_a'), b = fakePi('ses_pi_b')
  attach(a.pi, 'ses_a')
  attach(b.pi, 'ses_b')
  await a.emit('session_start')
  await b.emit('session_start')
  expect(a.tools).toEqual(META_TOOLS.map((t) => t.name))
  expect(b.tools).toEqual(META_TOOLS.map((t) => t.name))
  expect(await brain.session('ses_a')).toBe('ses_a')
  expect(await brain.session('ses_b')).toBe('ses_b')
  await brain.send('ses_a', 'What changed today?')
  await brain.send('ses_b', 'Read me the last error.')
  expect(a.sent).toEqual(['What changed today?'])
  expect(b.sent).toEqual(['Read me the last error.'])
  expect(process.env.VOICE_MODELS_URL).toBe('http://127.0.0.1:9')

  const port = await relayPort()
  expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toEqual({ ok: true, calls: 0 })
  expect(await relayPort()).toBe(port)

  await a.emit('session_shutdown')
  await brain.send('ses_b', 'Still here?')
  expect(b.sent.at(-1)).toBe('Still here?')
  expect(a.sent).toHaveLength(1)
})
