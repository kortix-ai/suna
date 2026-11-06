import { describe, expect, test } from 'bun:test'
import type { SimpleStreamOptions } from '@earendil-works/pi-ai'
import { MESSAGE_ID_HEADER, THREAD_ID_HEADER, TURN_ID_HEADER, withMessageIdentity } from '@/harness/pi/message-identity'
import { PiTurnEvents } from '@/harness/pi/turn-events'

function recorder() {
  const calls: Array<SimpleStreamOptions | undefined> = []
  const stream = ((_model: unknown, _context: unknown, options?: SimpleStreamOptions) => {
    calls.push(options)
    return {} as never
  }) as never
  return { calls, stream }
}

function adapter() {
  let n = 0
  return new PiTurnEvents({
    sessionID: 'ses_root',
    mintMessageId: () => `msg_${++n}`,
    parentMessageId: () => 'msg_user',
    model: () => ({ providerID: 'kortix', modelID: 'm' }),
    agent: () => 'kortix',
    workspace: '/workspace',
    now: () => 0,
  })
}

const assistantStart = { type: 'message_start', message: { role: 'assistant', content: [], usage: {}, stopReason: 'stop' } } as never
const startedId = (events: PiTurnEvents) => {
  events.translate(assistantStart)
  return events.messageId
}
// The agent loop spreads its config into the stream options; `convertToLlm` is how a step is told from a summary.
const step = { convertToLlm: (messages: unknown) => messages } as never as SimpleStreamOptions

describe('PiTurnEvents.reserveMessageId', () => {
  test('the next assistant message takes the reserved id', () => {
    const events = adapter()
    const reserved = events.reserveMessageId()
    expect(startedId(events)).toBe(reserved)
  })

  test('a request that started no message leaves its id for the next one', () => {
    const events = adapter()
    const first = events.reserveMessageId()
    expect(events.reserveMessageId()).toBe(first)
    expect(startedId(events)).toBe(first)
  })

  test('a reservation is used once: the following message mints a new id', () => {
    const events = adapter()
    const first = events.reserveMessageId()
    expect(startedId(events)).toBe(first)
    expect(startedId(events)).not.toBe(first)
    expect(events.reserveMessageId()).not.toBe(first)
  })
})

describe('withMessageIdentity', () => {
  test('an agent-loop step names its message and its turn, and keeps the caller headers', () => {
    const events = adapter()
    const r = recorder()
    const fn = withMessageIdentity(r.stream, { reserveMessageId: () => events.reserveMessageId(), turnId: () => 'msg_user' })
    fn({} as never, {} as never, { ...step, headers: { 'x-other': '1' } })
    const headers = r.calls[0]!.headers!
    expect(headers).toEqual({ 'x-other': '1', [MESSAGE_ID_HEADER]: 'msg_1', [TURN_ID_HEADER]: 'msg_user' })
    expect(startedId(events)).toBe('msg_1')
  })

  test('a compaction or summary request names the turn only and reserves nothing', () => {
    const events = adapter()
    const r = recorder()
    const fn = withMessageIdentity(r.stream, { reserveMessageId: () => events.reserveMessageId(), turnId: () => 'msg_user' })
    fn({} as never, {} as never, { reasoning: 'low' })
    expect(r.calls[0]!.headers).toEqual({ [TURN_ID_HEADER]: 'msg_user' })
    expect(startedId(events)).toBe('msg_1')
  })

  test('a subagent request names its thread; no turn means no turn header', () => {
    const r = recorder()
    const fn = withMessageIdentity(r.stream, { reserveMessageId: () => 'msg_child', turnId: () => null, threadId: 'ses_pichild' })
    fn({} as never, {} as never, step)
    expect(r.calls[0]!.headers).toEqual({ [MESSAGE_ID_HEADER]: 'msg_child', [THREAD_ID_HEADER]: 'ses_pichild' })
  })
})
