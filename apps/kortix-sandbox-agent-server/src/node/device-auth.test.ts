import { afterEach, describe, expect, mock, test } from 'bun:test'
import { parseNodeDeviceChallenge, pollNodeDeviceAuth } from './device-auth'

const realFetch = globalThis.fetch

afterEach(() => { globalThis.fetch = realFetch })

function challenge(overrides: Record<string, unknown> = {}) {
  return {
    device_code: 'ABCD-1234',
    device_secret: 'a'.repeat(32),
    verification_url: 'https://app.kortix.com/nodes/authorize/ABCD-1234',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    poll_interval_ms: 250,
    ...overrides,
  }
}

describe('native kortixd device authorization', () => {
  test('accepts HTTPS and loopback HTTP verification URLs', () => {
    expect(parseNodeDeviceChallenge(challenge()).device_code).toBe('ABCD-1234')
    expect(parseNodeDeviceChallenge(challenge({ verification_url: 'http://127.0.0.1:3000/nodes/authorize/ABCD-1234' })).verification_url).toContain('127.0.0.1')
  })

  test('rejects remote HTTP, credentials, invalid secrets, and excessive expiry', () => {
    expect(() => parseNodeDeviceChallenge(challenge({ verification_url: 'http://example.com/auth' }))).toThrow('unsafe')
    expect(() => parseNodeDeviceChallenge(challenge({ verification_url: 'https://user:pass@example.com/auth' }))).toThrow('unsafe')
    expect(() => parseNodeDeviceChallenge(challenge({ device_secret: 'short' }))).toThrow('invalid device challenge')
    expect(() => parseNodeDeviceChallenge(challenge({ expires_at: new Date(Date.now() + 11 * 60_000).toISOString() }))).toThrow('invalid device expiration')
  })

  test('polls through pending state and returns approved enrollment material', async () => {
    let calls = 0
    globalThis.fetch = mock(async () => new Response(JSON.stringify(++calls === 1
      ? { status: 'pending' }
      : { status: 'approved', enrollment_token: 'kortix_enroll_token', artifact_signing_public_key: 'public-key' }), { status: 200 })) as unknown as typeof fetch
    const result = await pollNodeDeviceAuth('https://api.kortix.com/v1', parseNodeDeviceChallenge(challenge()), async () => {})
    expect(result).toEqual({ enrollmentToken: 'kortix_enroll_token', signingPublicKey: 'public-key' })
    expect(calls).toBe(2)
  })

  test('stops immediately when the owner denies enrollment', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ status: 'denied' }), { status: 200 })) as unknown as typeof fetch
    await expect(pollNodeDeviceAuth('https://api.kortix.com/v1', parseNodeDeviceChallenge(challenge()), async () => {})).rejects.toThrow('denied')
  })
})
