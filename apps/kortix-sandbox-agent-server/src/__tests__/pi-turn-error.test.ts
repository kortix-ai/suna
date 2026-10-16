import { describe, expect, test } from 'bun:test'
import { assistantMessageError } from '@/harness/pi/turn-events'
import { turnEndAfterBegin, turnErrorCode } from '@/harness/shared/turn-relay'

const failed = (errorMessage: string) => assistantMessageError({ stopReason: 'error', errorMessage })

describe('pi turn errors carry a TurnErrorCode', () => {
  test('a leading HTTP status becomes data.statusCode and the code', () => {
    expect(failed('402 Payment Required: Insufficient credits. Balance: $-0.06')).toEqual({
      name: 'UnknownError',
      data: { message: '402 Payment Required: Insufficient credits. Balance: $-0.06', statusCode: 402 },
      code: 'credits',
    })
    expect(failed('429: rate limited')?.code).toBe('rate_limit')
    expect(failed('401 {"error":"invalid api key"}')?.code).toBe('auth')
    expect(failed('403 forbidden')?.code).toBe('auth')
    expect(failed('500 upstream broke')).toMatchObject({ data: { statusCode: 500 }, code: 'unknown' })
  })

  test('a number that is not a leading status stays unknown', () => {
    expect(failed('Stream ended without finish_reason')).toEqual({
      name: 'UnknownError',
      data: { message: 'Stream ended without finish_reason' },
      code: 'unknown',
    })
    expect(failed('200 tokens left')?.code).toBe('unknown')
  })

  test('a context overflow is context_length', () => {
    expect(failed('prompt is too long: 213462 tokens > 200000 maximum')).toMatchObject({
      name: 'ContextOverflowError',
      code: 'context_length',
    })
  })

  test('aborted and length stops', () => {
    expect(assistantMessageError({ stopReason: 'aborted', errorMessage: undefined })).toEqual({
      name: 'MessageAbortedError',
      data: { message: 'The message was aborted' },
      code: 'aborted',
    })
    expect(assistantMessageError({ stopReason: 'length', errorMessage: undefined })).toEqual({
      name: 'MessageOutputLengthError',
      data: {},
      code: 'output_length',
    })
    expect(assistantMessageError({ stopReason: 'stop', errorMessage: undefined })).toBeUndefined()
  })

  test('the relay code for errors an adapter names itself', () => {
    expect(turnErrorCode({ name: 'ProviderAuthError' })).toBe('auth')
    expect(turnErrorCode({ name: 'APIError', statusCode: 429 })).toBe('rate_limit')
    expect(turnErrorCode({ name: 'RuntimeAbortedTurn' })).toBe('unknown')
    expect(turnErrorCode({ name: 'TimeoutError' })).toBe('unknown')
  })
})

describe('a pi turn end waits for its begin relay (turnEndAfterBegin)', () => {
  test('the end goes after the begin settles, however fast the turn ended', async () => {
    const order = turnEndAfterBegin()
    const sent: string[] = []
    let settle!: () => void
    order.begin('msg_a', new Promise<void>((resolve) => (settle = resolve)).then(() => void sent.push('begin')))
    const end = order.end('msg_a').then(() => void sent.push('end'))
    await Bun.sleep(20)
    expect(sent).toEqual([])
    settle()
    await end
    expect(sent).toEqual(['begin', 'end'])
  })

  test('a hung begin delays the end at most the bound', async () => {
    const order = turnEndAfterBegin(50)
    order.begin('msg_b', new Promise(() => {}))
    const t0 = Date.now()
    await order.end('msg_b')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45)
    expect(Date.now() - t0).toBeLessThan(1_000)
  })

  test('an end with no begin, or a second end, does not wait', async () => {
    const order = turnEndAfterBegin(10_000)
    order.begin('msg_c', new Promise(() => {}))
    const t0 = Date.now()
    await order.end('msg_none')
    void order.end('msg_c')
    await order.end('msg_c')
    expect(Date.now() - t0).toBeLessThan(500)
  })
})
