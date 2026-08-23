import { beforeEach, describe, expect, test } from 'bun:test'

import {
  __resetTrackedRootTurnSessions,
  proxiedPromptSessionId,
  trackRootTurnSession,
  trackedRootTurnSessions,
} from '../turn-tracking'

// The reconnect reconcile can only ask about roots it KNOWS a turn started on.
// Three observers feed this registry: the proxy (control-plane prompt
// delivery), the status-frame relay (`busy`/`retry`), and the turn-begin relay.

beforeEach(() => __resetTrackedRootTurnSessions())

describe('turn-tracking registry', () => {
  test('tracks in first-seen order and dedups repeats', () => {
    trackRootTurnSession('ses_a', 'proxied_prompt', 1)
    trackRootTurnSession('ses_b', 'status_frame', 2)
    trackRootTurnSession('ses_a', 'turn_begin_relay', 3)
    expect(trackedRootTurnSessions()).toEqual(['ses_a', 'ses_b'])
  })

  test('ignores empty ids', () => {
    trackRootTurnSession('', 'proxied_prompt')
    trackRootTurnSession('   ', 'proxied_prompt')
    expect(trackedRootTurnSessions()).toEqual([])
  })

  test('is bounded: the oldest entry is evicted past the cap', () => {
    for (let i = 0; i < 70; i++) trackRootTurnSession(`ses_${i}`, 'proxied_prompt', i)
    const ids = trackedRootTurnSessions()
    expect(ids.length).toBe(64)
    expect(ids[0]).toBe('ses_6')
    expect(ids[ids.length - 1]).toBe('ses_69')
  })
})

describe('proxiedPromptSessionId — which proxied requests start a turn', () => {
  test.each([
    ['POST', '/session/ses_abc123/prompt_async', 'ses_abc123'],
    ['POST', '/session/ses_abc123/message', 'ses_abc123'],
    ['POST', '/session/ses_abc123/command', 'ses_abc123'],
    ['POST', '/session/ses_abc123/shell', 'ses_abc123'],
  ])('%s %s names %s', (method, path, expected) => {
    expect(proxiedPromptSessionId(method, path)).toBe(expected)
  })

  test.each([
    ['GET', '/session/ses_abc123/message'],
    ['POST', '/session/ses_abc123/abort'],
    ['POST', '/session/ses_abc123/revert'],
    ['POST', '/session'],
    ['GET', '/session/status'],
    ['POST', '/session/ses_abc123/message/extra'],
    ['POST', '/session/../message'],
  ])('%s %s is not a turn start', (method, path) => {
    expect(proxiedPromptSessionId(method, path)).toBeNull()
  })
})
