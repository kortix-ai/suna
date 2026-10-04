/**
 * The token of an `Authorization: Bearer <token>` header: everything after the
 * case-sensitive `Bearer ` prefix, untrimmed (`''` for a bare `Bearer `). Null
 * when the header is absent or names another scheme.
 *
 * The one parser for a Kortix bearer credential. Headers with other rules keep
 * their own: Basic (git proxy, trigger webhooks), a case-insensitive scheme
 * (SCIM, rate limiting, the gateway's internal token), a signature compare
 * (RevenueCat), the Bot Framework JWT (Teams).
 */
export function bearerToken(header: string | null | undefined): string | null {
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}
