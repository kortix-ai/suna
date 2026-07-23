import { describe, expect, test } from 'bun:test';
import { generatePKCE, pkceChallengeFromVerifier } from './pkce';

describe('PKCE — RFC 7636 S256', () => {
  test('matches the RFC 7636 Appendix B published test vector', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const expectedChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(await pkceChallengeFromVerifier(verifier)).toBe(expectedChallenge);
  });

  test('generatePKCE produces a verifier/challenge pair that round-trips through the same derivation', async () => {
    const pair = await generatePKCE();
    expect(pair.method).toBe('S256');
    expect(await pkceChallengeFromVerifier(pair.verifier)).toBe(pair.challenge);
  });

  test('verifier and challenge are base64url (no +, /, or = padding)', async () => {
    const pair = await generatePKCE();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  test('verifier is 32 random bytes base64url-encoded (43 chars, no padding)', async () => {
    const pair = await generatePKCE();
    expect(pair.verifier.length).toBe(43);
  });

  test('challenge is a SHA-256 digest base64url-encoded (43 chars, no padding)', async () => {
    const pair = await generatePKCE();
    expect(pair.challenge.length).toBe(43);
  });

  test('two calls never produce the same verifier (32 random bytes, collision-negligible)', async () => {
    const a = await generatePKCE();
    const b = await generatePKCE();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});
