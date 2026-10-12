import { expect, test } from 'bun:test';
import { normalizeApiUrl, pkce } from './auth';

test('pkce: the challenge is base64url(sha256(verifier))', async () => {
  const { verifier, challenge, state } = await pkce();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const expected = Buffer.from(digest).toString('base64url');
  expect(challenge).toBe(expected);
  expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(state.length).toBeGreaterThanOrEqual(16);
  expect((await pkce()).verifier).not.toBe(verifier);
});

test('normalizeApiUrl keeps the origin, requires https except loopback', () => {
  expect(normalizeApiUrl(' https://api.kortix.com/v1/ ')).toBe('https://api.kortix.com');
  expect(normalizeApiUrl('http://localhost:8008')).toBe('http://localhost:8008');
  expect(() => normalizeApiUrl('http://evil.test')).toThrow();
});
