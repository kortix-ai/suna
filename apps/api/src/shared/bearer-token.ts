/**
 * The token of an `Authorization: Bearer <token>` header value, or null when the
 * value does not start with `Bearer ` (case-sensitive, one space). The token is
 * returned as sent: not trimmed, and `''` for a bare `Bearer `.
 */
export function bearerToken(authorization: string | null | undefined): string | null {
  return authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
}
