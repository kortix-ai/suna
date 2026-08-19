/**
 * The daemon must not abort a turn that is still being computed.
 *
 * opencode withholds the response to `POST /session/:id/message` and
 * `POST /session/:id/command` until the ENTIRE reasoning + tool-call turn is
 * done. The proxy bounded every upstream wait at 10s, so any command longer
 * than that got aborted and answered `502 {"error":"upstream unreachable"}` —
 * the banner users saw in chat.
 *
 * It got worse downstream: that 502 is exactly the signal apps/api's retry loop
 * was built to act on, so a fail-fast meant to trigger a retry met a retry loop
 * that assumed idempotency. Session 9f6b0d87 recorded one `/webapp` submit as
 * four identical user messages ~10.75s apart (the 10s bound plus apps/api's
 * [250, 1000, 3000] delays), each retry aborting the turn the last one started.
 */
import { describe, expect, test } from 'bun:test'

import { isBlockingTurnRequest } from '../proxy'

describe('isBlockingTurnRequest', () => {
  test('both blocking turn endpoints match', () => {
    expect(isBlockingTurnRequest('POST', '/session/ses_abc/message')).toBe(true)
    expect(isBlockingTurnRequest('POST', '/session/ses_abc/command')).toBe(true)
  })

  test('/command matches — the omission that produced "upstream unreachable"', () => {
    expect(isBlockingTurnRequest('post', '/session/ses_abc/command')).toBe(true)
    expect(isBlockingTurnRequest('POST', '/session/ses_abc/command?x=1')).toBe(true)
  })

  test('the non-blocking sibling keeps the short bound', () => {
    // `prompt_async` answers immediately and streams over /global/event, so a
    // 10s silence there really does mean opencode is wedged.
    expect(isBlockingTurnRequest('POST', '/session/ses_abc/prompt_async')).toBe(false)
  })

  test('SSE and reads keep the short bound', () => {
    expect(isBlockingTurnRequest('GET', '/global/event')).toBe(false)
    expect(isBlockingTurnRequest('GET', '/session/ses_abc/message')).toBe(false)
  })

  test('lookalike paths do not match', () => {
    expect(isBlockingTurnRequest('POST', '/session/ses_abc/commands')).toBe(false)
    expect(isBlockingTurnRequest('POST', '/session/ses_abc/messages')).toBe(false)
    expect(isBlockingTurnRequest('POST', '/not-session/ses_abc/command')).toBe(false)
  })
})

describe('the two proxy layers agree on which calls block', () => {
  // The daemon sits INSIDE the sandbox and cannot import from apps/api, so the
  // predicate is duplicated. Duplicated and unchecked is how they drift, and a
  // drift here means the inner layer aborts what the outer one is patiently
  // waiting for — silently, as a 502 that looks like a dead sandbox.
  const API_PREDICATE = new URL(
    '../../../api/src/sandbox-proxy/preview-retry-budget.ts',
    import.meta.url,
  ).pathname

  test('apps/api bounds the same two endpoints', async () => {
    const source = await Bun.file(API_PREDICATE).text()
    const match = source.match(
      /export function isLongTurnCompletionRequest[\s\S]*?\n}/,
    )
    expect(match).not.toBeNull()
    const body = match![0]
    expect(body).toContain('message')
    expect(body).toContain('command')
  })

  test('every path apps/api treats as long-turn, the daemon does too', async () => {
    const source = await Bun.file(API_PREDICATE).text()
    // Drive the daemon's predicate with the SAME inputs and require identical
    // verdicts, rather than comparing two regex literals as strings.
    for (const path of [
      '/session/ses_abc/message',
      '/session/ses_abc/command',
      '/session/ses_abc/prompt_async',
      '/session/ses_abc/messages',
    ]) {
      const apiSaysLong = /\/\(\?:message\|command\)/.test(source)
        ? /\/session\/[^/]+\/(?:message|command)(?:$|[/?#])/.test(path)
        : null
      expect(apiSaysLong).not.toBeNull()
      expect(isBlockingTurnRequest('POST', path)).toBe(apiSaysLong as boolean)
    }
  })
})
