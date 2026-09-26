/**
 * Every daemon relay (turn stream, turn begin, questions, audit events, boot
 * timeline, runtime projection, both harness adapters) reads the control plane
 * through `relay-context.ts`. This table owns the URL normalization and the
 * "no control plane → relay nothing" rule; each relay's own suite keeps one
 * wiring row.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { readControlPlaneEnv, sandboxRelayContext } from '../relay-context'

const KEYS = ['KORTIX_PROJECT_ID', 'KORTIX_SESSION_ID', 'KORTIX_TOKEN', 'KORTIX_API_URL'] as const
const saved = new Map<string, string | undefined>()

beforeEach(() => {
  for (const key of KEYS) saved.set(key, process.env[key])
  process.env.KORTIX_PROJECT_ID = 'proj-1'
  process.env.KORTIX_SESSION_ID = 'sess-1'
  process.env.KORTIX_TOKEN = 'sandbox-token'
  process.env.KORTIX_API_URL = 'https://api.kortix.test'
})

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('control-plane API root', () => {
  test.each([
    ['https://api.kortix.test', 'https://api.kortix.test/v1'],
    ['https://api.kortix.test/', 'https://api.kortix.test/v1'],
    ['https://api.kortix.test/v1', 'https://api.kortix.test/v1'],
    ['https://api.kortix.test/v1/', 'https://api.kortix.test/v1'],
    ['https://api.kortix.test/v1//', 'https://api.kortix.test/v1'],
    [' https://api.kortix.test/v1 ', 'https://api.kortix.test/v1'],
    ['', null],
    ['   ', null],
  ])('KORTIX_API_URL=%j → apiRoot %j', (raw, expected) => {
    process.env.KORTIX_API_URL = raw
    expect(readControlPlaneEnv().apiRoot).toBe(expected)
  })
})

describe('sandboxRelayContext', () => {
  test('returns all four fields, trimmed, when the control plane is configured', () => {
    process.env.KORTIX_TOKEN = '  sandbox-token\n'
    expect(sandboxRelayContext()).toEqual({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      token: 'sandbox-token',
      apiRoot: 'https://api.kortix.test/v1',
    })
  })

  test.each([...KEYS])('is null when %s is unset or blank', (key) => {
    delete process.env[key]
    expect(sandboxRelayContext()).toBeNull()
    process.env[key] = '  '
    expect(sandboxRelayContext()).toBeNull()
  })
})
