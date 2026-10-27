/**
 * The token of an `Authorization: Bearer <token>` header value, or null when the
 * value does not start with `Bearer ` (RFC 7235: the scheme is case-insensitive,
 * one space). The token is returned as sent: not trimmed, and `''` for a bare
 * `Bearer `.
 */
export function bearerToken(authorization: string | null | undefined): string | null {
  if (!authorization) return null;
  // RFC 7235 §2.1: the auth-scheme is case-insensitive. Only the 7-byte prefix
  // is rewritten; the token bytes stay exactly as sent.
  if (authorization.slice(0, 7).toLowerCase() !== 'bearer ') return null;
  return authorization.slice(7);
}
