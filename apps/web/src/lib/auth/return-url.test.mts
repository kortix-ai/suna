import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_AUTH_RETURN_URL, sanitizeAuthReturnUrl } from './return-url.ts'

test('keeps safe relative auth return paths', () => {
  assert.equal(sanitizeAuthReturnUrl('/projects?tab=recent'), '/projects?tab=recent')
})

test('rejects legacy auth return paths', () => {
  assert.equal(sanitizeAuthReturnUrl('/instances/abc123?foo=bar'), DEFAULT_AUTH_RETURN_URL)
  assert.equal(sanitizeAuthReturnUrl('/dashboard?foo=bar'), DEFAULT_AUTH_RETURN_URL)
  assert.equal(sanitizeAuthReturnUrl('/sessions/abc123'), DEFAULT_AUTH_RETURN_URL)
  assert.equal(sanitizeAuthReturnUrl('/subscription'), DEFAULT_AUTH_RETURN_URL)
})

test('rejects javascript scheme payloads', () => {
  assert.equal(sanitizeAuthReturnUrl('javascript:alert(1)'), DEFAULT_AUTH_RETURN_URL)
})

test('rejects protocol-relative open redirects', () => {
  assert.equal(sanitizeAuthReturnUrl('//attacker.example/pwn'), DEFAULT_AUTH_RETURN_URL)
})

test('rejects bare relative paths', () => {
  assert.equal(sanitizeAuthReturnUrl('instances'), DEFAULT_AUTH_RETURN_URL)
})
