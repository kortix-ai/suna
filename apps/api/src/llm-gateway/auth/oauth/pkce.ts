/**
 * PKCE (RFC 7636) utilities — Web Crypto API, works identically in Node
 * 20+/Bun and browsers, no dependency.
 *
 * Ported near-verbatim from pi/packages/ai/src/auth/oauth/pkce.ts (read in
 * full 2026-07-22, github.com/earendil-works/pi) per docs/specs/2026-07-22-
 * unified-auth-gateway.md §2.5/§10.3 Step 1. Only change from the source:
 * the base64url encoder is inlined as a named helper here too (matches the
 * original) and the challenge method is exported as a named constant rather
 * than a bare string literal, since this module's only caller
 * (`auth/registry.ts`'s `OAuthClientConfig.pkce`, and the future CLI
 * browser-login flow, Step 4) needs to assert the method it's using.
 */

const CHALLENGE_METHOD = 'S256' as const;

function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: typeof CHALLENGE_METHOD;
}

/**
 * S256 challenge for a given verifier — SHA-256 digest of the verifier's
 * ASCII bytes (not the raw random bytes), base64url-encoded. Split out from
 * `generatePKCE` (Pi inlines this) so `registry.test.ts`/`pkce.test.ts` can
 * assert against RFC 7636 Appendix B's published test vector without
 * mocking `crypto.getRandomValues` — the only deviation from a verbatim
 * port; the algorithm itself is unchanged.
 */
export async function pkceChallengeFromVerifier(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return base64urlEncode(new Uint8Array(hashBuffer));
}

/**
 * Generate a PKCE code verifier and its S256 challenge. 32 random bytes ->
 * base64url verifier; see `pkceChallengeFromVerifier` for the challenge
 * derivation — matches the RFC 7636 `S256` method exactly as Pi's
 * implementation does.
 */
export async function generatePKCE(): Promise<PkcePair> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64urlEncode(verifierBytes);
  const challenge = await pkceChallengeFromVerifier(verifier);

  return { verifier, challenge, method: CHALLENGE_METHOD };
}
