import assert from 'node:assert/strict'
import test from 'node:test'

import { getPublicRequestOrigin, getPublicRequestUrl } from './request-origin.ts'

function request(url: string, headers: Record<string, string | undefined> = {}) {
  const parsed = new URL(url)
  const lowerHeaders = new Map(
    Object.entries(headers)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([key, value]) => [key.toLowerCase(), value]),
  )

  return {
    url,
    nextUrl: {
      origin: parsed.origin,
      pathname: parsed.pathname,
      search: parsed.search,
    },
    headers: {
      get(name: string) {
        return lowerHeaders.get(name.toLowerCase()) ?? null
      },
    },
  }
}

test('uses the forwarded public host instead of the internal Next origin', () => {
  const req = request('https://localhost:3001/projects', {
    host: 'ai.kplxr.com',
    'x-forwarded-proto': 'https',
  })

  assert.equal(getPublicRequestOrigin(req, 'https://ai.kplxr.com'), 'https://ai.kplxr.com')
  assert.equal(getPublicRequestUrl(req, '/auth').toString(), 'https://ai.kplxr.com/auth')
})

test('falls back to configured public app origin when only loopback host is visible', () => {
  const req = request('https://localhost:3001/projects', {
    host: 'localhost:3001',
    'x-forwarded-host': 'localhost:3001',
    'x-forwarded-proto': 'https',
  })

  assert.equal(getPublicRequestOrigin(req, 'https://ai.kplxr.com'), 'https://ai.kplxr.com')
})

test('preserves normal localhost development origins', () => {
  const req = request('http://localhost:3000/projects', {
    host: 'localhost:3000',
    'x-forwarded-proto': 'http',
  })

  assert.equal(getPublicRequestOrigin(req, 'http://localhost:3000'), 'http://localhost:3000')
})
