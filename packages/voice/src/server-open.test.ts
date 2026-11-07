// A call whose socket closes while it is still opening (server.ts open()) builds no provider and never joins the live
// calls: before, end() ran first, open() went on, built the call's speech and agent sockets and added a call nothing
// would ever close, which /inject could still make speak. A fake agent (brain.use), the mock voice. No network, no model.
import { afterAll, expect, test } from 'bun:test'

process.env.VOICE_TTS = 'mock'
delete process.env.VOICE_MODELS_URL
delete process.env.VOICE_TOKEN
const brain = await import('./brain')
const { serve } = await import('./server')

let release!: (sid: string) => void
const opening = new Promise<string>((r) => (release = r))
let buses = 0
brain.use({
  session: () => opening,
  ask: async () => '',
  remember: async () => {},
  recall: async () => ({ text: '', thread: undefined as never }),
  progress: async () => '',
  bus: () => (buses++, { on: () => () => {}, close() {} }),
  turn: async () => {},
  steer: async () => false,
  send: async () => {},
  abort: async () => undefined,
})
const server = serve(0)
afterAll(() => {
  server.stop(true)
  brain.use(undefined)
})

test('a socket closed during open() leaves no live call and builds no provider', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/stream?greet=0&recall=0`)
  await new Promise((r) => (ws.onopen = r))
  const closed = new Promise((r) => (ws.onclose = r))
  ws.close()
  await closed
  await Bun.sleep(5) // a socket close crosses the loopback: the relay's close handler (end()) runs first
  release('ses_open')
  for (let i = 0; i < 5; i++) await Bun.sleep(0) // open() resumes past its awaits
  expect(buses).toBe(0) // no cascade was built for it
  expect(await (await fetch(`http://127.0.0.1:${server.port}/health`)).json()).toEqual({ ok: true, calls: 0 })
})
