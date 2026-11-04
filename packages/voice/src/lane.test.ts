// The fast lane (lane.ts) through a gateway that keeps its stream open: "(agent" and ")" as two deltas, the usage chunk
// still to come. The lane stops that stream on a hand-over, and on Bun 1.4 leaving the loop then throws an AbortError;
// the verdict went with it and every hand-over on a Kortix call came back 'error'. A loopback server, no model.
import { afterAll, expect, test } from 'bun:test'

let deltas: string[] = []
const server = Bun.serve({
  port: 0,
  fetch: () => {
    const enc = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '' } }] })}\n\n`))
        await Bun.sleep(60) // the first token after the hedge, as on the gateway: two streams
        c.enqueue(enc.encode(deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`).join('')))
      },
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  },
})
afterAll(() => server.stop(true))
process.env.VOICE_MODELS_URL = `http://127.0.0.1:${server.port}`
process.env.VOICE_LANE_HEDGE_MS = '20'
const { lane } = await import('./lane')

const ask = async (d: string[]) => {
  deltas = d
  let out = ''
  const result = await lane('You are a voice assistant.', [], 'What do you remember about me?', '', AbortSignal.timeout(3000), (x) => void (out += x), 2000)
  return { result, out }
}

test('a hand-over split over two deltas, the stream still open, stays a hand-over', async () => {
  expect(await ask(['(agent', ')'])).toEqual({ result: 'agent', out: '' })
  expect(await ask(['(agent)'])).toEqual({ result: 'agent', out: '' })
})

test('an answer before the marker stands; reasoning instead of an answer is no answer', async () => {
  const said = await ask(['Twelve times eleven is ', '132.', ' (agent)'])
  expect(said.result).toBe('ok')
  expect(said.out).toBe('Twelve times eleven is 132.')
  expect(await ask(['The user is asking what I remember.'])).toEqual({ result: 'error', out: '' })
})
