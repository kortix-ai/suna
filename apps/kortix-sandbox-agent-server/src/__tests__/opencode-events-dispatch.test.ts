import { describe, expect, test } from 'bun:test'

import { dispatch, type OpencodeTurnError } from '../opencode-events'

describe('dispatch — session.error flattening', () => {
  test('flattens an APIError (out of credits) into name/message/statusCode', () => {
    let got: { id?: string; error?: OpencodeTurnError } | null = null
    dispatch(
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_root',
          error: {
            name: 'APIError',
            data: { message: 'Payment Required: Insufficient credits. Balance: $-0.06', statusCode: 402 },
          },
        },
      },
      { onSessionError: (id, error) => (got = { id, error }) },
    )
    expect(got).not.toBeNull()
    expect(got!.id).toBe('ses_root')
    expect(got!.error).toEqual({
      name: 'APIError',
      message: 'Payment Required: Insufficient credits. Balance: $-0.06',
      statusCode: 402,
      isRetryable: undefined,
      providerID: undefined,
    })
  })

  test('flattens isRetryable (APIError) and providerID (ProviderAuthError)', () => {
    let api: OpencodeTurnError | undefined
    dispatch(
      {
        type: 'session.error',
        properties: { sessionID: 's', error: { name: 'APIError', data: { message: 'oops', statusCode: 503, isRetryable: true } } },
      },
      { onSessionError: (_id, e) => (api = e) },
    )
    expect(api?.isRetryable).toBe(true)
    expect(api?.statusCode).toBe(503)

    let auth: OpencodeTurnError | undefined
    dispatch(
      {
        type: 'session.error',
        properties: { sessionID: 's', error: { name: 'ProviderAuthError', data: { message: 'bad key', providerID: 'anthropic' } } },
      },
      { onSessionError: (_id, e) => (auth = e) },
    )
    expect(auth?.providerID).toBe('anthropic')
  })

  test('session.error with no error payload passes undefined (still finalizes)', () => {
    let called = false
    let error: OpencodeTurnError | undefined = { name: 'sentinel' }
    dispatch(
      { type: 'session.error', properties: { sessionID: 'ses_root' } },
      { onSessionError: (_id, e) => { called = true; error = e } },
    )
    expect(called).toBe(true)
    expect(error).toBeUndefined()
  })

  test('session.error without a sessionID is ignored (no root to close)', () => {
    let called = false
    dispatch(
      { type: 'session.error', properties: { error: { name: 'APIError', data: { message: 'x' } } } },
      { onSessionError: () => (called = true) },
    )
    expect(called).toBe(false)
  })

  test('session.idle dispatches the idle handler with the sessionID', () => {
    let id: string | undefined
    dispatch(
      { type: 'session.idle', properties: { sessionID: 'ses_root' } },
      { onSessionIdle: (sid) => (id = sid) },
    )
    expect(id).toBe('ses_root')
  })
  test('session.status dispatches busy state for execution leasing', () => {
    const seen: Array<[string, string]> = []
    dispatch({ type: 'session.status', properties: { sessionID: 'root', status: { type: 'busy' } } }, { onSessionStatus: (id, status) => seen.push([id, status]) })
    expect(seen).toEqual([['root', 'busy']])
  })
})
