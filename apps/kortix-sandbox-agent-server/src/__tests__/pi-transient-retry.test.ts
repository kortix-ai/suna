import { describe, expect, test } from 'bun:test'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { TURN_RETRY_MAX_ATTEMPTS, isTransientModelError, retryDelayMs } from '@/harness/pi/transient-retry'

const failed = (errorMessage: string) => ({ role: 'assistant', stopReason: 'error', errorMessage }) as unknown as AssistantMessage

describe('pi transient retry', () => {
  test('the default schedule rides out a blip in ~60 s and an outage for ~7 more minutes', () => {
    const delays = Array.from({ length: TURN_RETRY_MAX_ATTEMPTS }, (_, i) => retryDelayMs(i + 1, 2_000) / 1_000)
    expect(delays).toEqual([2, 4, 8, 16, 30, 60, 120, 240])
    expect(delays.slice(0, 5).reduce((a, b) => a + b, 0)).toBe(60)
    expect(delays.reduce((a, b) => a + b, 0)).toBe(480)
  })

  test.each([
    'Stream ended without finish_reason',
    'terminated',
    'fetch failed',
    '503 Service Unavailable',
    'JSON Parse error: Unable to parse JSON string',
    'JSON parsing failed: Text: {"id":"chatcmpl-x","choices":[{"delta":{"reasoning_content":"th',
    'Could not parse message into JSON: {"id"',
    'Error reading response: malformed server-sent event JSON.',
    'deepseek-v4.1-flash is temporarily unavailable.',
    'The operation timed out.',
  ])('transient: %s', (message) => {
    expect(isTransientModelError(failed(message))).toBe(true)
  })

  test.each([
    'Model not found: glm-5.3-flash/.',
    'Connect Codex to use this model.',
    'insufficient_quota: You exceeded your current quota',
    'Monthly usage limit reached; request timed out',
    '400 Bad Request',
  ])('not transient: %s', (message) => {
    expect(isTransientModelError(failed(message))).toBe(false)
  })

  test('only a failed message is ever retried', () => {
    const ok = { role: 'assistant', stopReason: 'stop', errorMessage: 'terminated' } as unknown as AssistantMessage
    const aborted = { role: 'assistant', stopReason: 'aborted', errorMessage: 'terminated' } as unknown as AssistantMessage
    expect(isTransientModelError(ok)).toBe(false)
    expect(isTransientModelError(aborted)).toBe(false)
  })
})
