// A hung-up call does nothing more (cascade.ts close()): a line queued to be said, a goodbye's hang-up check and a
// say() that comes after close() start no turn on the box's shared session, speak nothing and close nothing again.
// A fake agent (brain.use), the mock voice, a fake clock. No network, no model.
import { afterEach, beforeEach, expect, jest, test } from 'bun:test'

process.env.VOICE_TTS = 'mock'
process.env.VOICE_STT = 'whisper'
delete process.env.VOICE_MODELS_URL
const brain = await import('./brain')
const { cascade } = await import('./cascade')

type Seen = { turns: number; texts: string[]; closes: string[]; audio: number }

function call() {
  const seen: Seen = { turns: 0, texts: [], closes: [], audio: 0 }
  brain.use({
    session: async () => 'ses_close',
    ask: async () => '',
    remember: async () => {},
    recall: async () => ({ text: '', thread: undefined as never }),
    progress: async () => '',
    bus: () => ({ on: () => () => {}, close() {} }),
    turn: async () => void seen.turns++,
    steer: async () => false,
    send: async () => void seen.turns++,
    abort: async () => undefined,
  })
  const model = cascade(
    { session: 'ses_close', instructions: '', tools: [], lang: 'en' },
    {
      ready() {},
      audio: () => void seen.audio++,
      clear() {},
      text: (_role, text) => void seen.texts.push(text),
      tool() {},
      close: (why) => void seen.closes.push(why),
    },
  )
  return { model, seen }
}

beforeEach(() => jest.useFakeTimers())
afterEach(() => {
  jest.useRealTimers()
  brain.use(undefined)
})

test('a line queued to be said before hang-up is never said after it', async () => {
  const { model, seen } = call()
  await model.control!({ say: 'Your build finished.' })
  await model.close()
  jest.advanceTimersByTime(5_000)
  await Promise.resolve()
  expect(seen.texts).toEqual([])
  expect(seen.turns).toBe(0)
})

test("a goodbye's hang-up check stops with the call: the call is not closed a second time", async () => {
  const { model, seen } = call()
  await model.control!({ end: true })
  await model.close()
  jest.advanceTimersByTime(5_000)
  expect(seen.closes).toEqual([])
})

test('say() and a typed turn after close() start nothing', async () => {
  const { model, seen } = call()
  await model.close()
  model.say('Anything new?')
  model.input('What changed today?')
  jest.advanceTimersByTime(5_000)
  await Promise.resolve()
  expect(seen.texts).toEqual([])
  expect(seen.turns).toBe(0)
})
