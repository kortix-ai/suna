/**
 * Read the Supabase session cookie WITHOUT verifying or parsing it through
 * auth-js.
 *
 * `@supabase/ssr` stores the session JSON in `<name>` or in chunks
 * `<name>.0`, `<name>.1`, …, optionally encoded as `base64-<base64url>`.
 *
 * The middleware needs exactly one fact from this cookie — whether the stored
 * session is still fresh — BEFORE it may touch an auth client, because
 * creating one is not read-only: `getSession()`/`getClaims()`/`getUser()`
 * refresh a session whose access token is expired or inside auth-js's
 * refresh margin, and a server-side refresh rotates the single-use refresh
 * token on a response surface whose Set-Cookie may not reach the browser
 * (KRTX-2111). The browser is the only writer that is guaranteed to see its
 * own rotation; the middleware must never race it.
 *
 * Like `unverifiedSessionLocale`, this is never an identity: a forged cookie
 * yields at most a bounce, and every protected decision still runs through
 * the verified resolver.
 */

function decodeBase64Url(value: string): string | null {
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The parsed session JSON from the Supabase auth cookie, or null when there
 * is no readable cookie. Callers narrow the fields they use.
 */
export function readUnverifiedSession(
  cookies: ReadonlyArray<{ name: string; value: string }>,
  cookieName: string,
): Record<string, unknown> | null {
  const whole = cookies.find((cookie) => cookie.name === cookieName)?.value;
  let raw = whole;
  if (!raw) {
    const chunks: string[] = [];
    for (let index = 0; ; index += 1) {
      const chunk = cookies.find((cookie) => cookie.name === `${cookieName}.${index}`)?.value;
      if (chunk === undefined) break;
      chunks.push(chunk);
    }
    raw = chunks.length > 0 ? chunks.join('') : undefined;
  }
  if (!raw) return null;

  let json: string | null = raw;
  if (raw.startsWith('base64-')) json = decodeBase64Url(raw.slice('base64-'.length));
  if (!json) return null;
  try {
    const session = JSON.parse(json) as Record<string, unknown> | null;
    return session && typeof session === 'object' ? session : null;
  } catch {
    return null;
  }
}
