/**
 * The last project the user opened, mirrored into a cookie.
 *
 * localStorage is invisible to middleware and to a server component, and `/`
 * has to resolve where to send someone before any client code runs. So the
 * zustand store mirrors here — same trick as `sidebar-cookie.ts`.
 *
 * The value is interpolated straight into a redirect path, so it MUST be
 * validated. An unvalidated cookie here is a path-injection vector: a value of
 * `../admin` or `//evil.com` would otherwise become the redirect target.
 */

export const LAST_PROJECT_COOKIE = 'kortix_last_project';

/** One year — this is a convenience hint, not a session. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Project ids are UUIDs. Anything else is not ours and is discarded. */
export function isValidProjectId(value: string | null | undefined): boolean {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Read the cookie out of a `document.cookie` / `Cookie:` header string. */
export function parseLastProjectCookie(
  cookieHeader: string | null | undefined,
): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rest] = part.split('=');
    if (rawName.trim() !== LAST_PROJECT_COOKIE) continue;
    const raw = rest.join('=').trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // A malformed escape sequence is not a project id.
      return undefined;
    }
    return isValidProjectId(value) ? value : undefined;
  }
  return undefined;
}

export function serializeLastProjectCookie(projectId: string): string | null {
  if (!isValidProjectId(projectId)) return null;
  return `${LAST_PROJECT_COOKIE}=${projectId}; path=/; max-age=${MAX_AGE_SECONDS}; samesite=lax`;
}

export function clearLastProjectCookieValue(): string {
  return `${LAST_PROJECT_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

/** Client-side write. No-op on the server or for an invalid id. */
export function writeLastProjectCookie(projectId: string): void {
  if (typeof document === 'undefined') return;
  const serialized = serializeLastProjectCookie(projectId);
  if (!serialized) return;
  document.cookie = serialized;
}

export function clearLastProjectCookie(): void {
  if (typeof document === 'undefined') return;
  document.cookie = clearLastProjectCookieValue();
}
