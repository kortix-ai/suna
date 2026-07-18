// Post-auth landing goes to the projects list.
const DEFAULT_AUTH_RETURN_URL = '/projects';
const LEGACY_AUTH_RETURN_PREFIXES = [
  '/dashboard',
  '/instances',
  '/sessions',
  '/subscription',
] as const;

export function sanitizeAuthReturnUrl(
  value?: string | null,
  fallback = DEFAULT_AUTH_RETURN_URL,
): string {
  if (!value) return fallback;

  const trimmedValue = value.trim();
  let decodedValue = trimmedValue;
  try {
    decodedValue = decodeURIComponent(trimmedValue);
  } catch {
    return fallback;
  }

  if (
    !trimmedValue.startsWith('/') ||
    trimmedValue.startsWith('//') ||
    trimmedValue.includes('\\') ||
    decodedValue.startsWith('//') ||
    decodedValue.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(trimmedValue)
  ) {
    return fallback;
  }

  try {
    const resolved = new URL(trimmedValue, 'https://kortix.local');
    if (resolved.origin !== 'https://kortix.local') return fallback;
  } catch {
    return fallback;
  }

  if (LEGACY_AUTH_RETURN_PREFIXES.some((prefix) => {
    return trimmedValue === prefix || trimmedValue.startsWith(`${prefix}/`) || trimmedValue.startsWith(`${prefix}?`);
  })) {
    return fallback;
  }

  return trimmedValue;
}

/**
 * True when a (already-sanitized) return URL points at an invite acceptance
 * page. Invited users must land here verbatim after sign-up so they see the
 * accept/decline dialog — they must NOT be bounced to a freshly-provisioned
 * first project, which would skip the dialog and leave the invite unaccepted.
 */
export function isInviteReturnUrl(returnUrl: string | null | undefined): boolean {
  return typeof returnUrl === 'string' && returnUrl.startsWith('/invites/');
}

/**
 * Resolve the public base URL to use for post-auth redirects (OAuth/SSO/magic
 * link callbacks).
 *
 * `request.nextUrl.origin` is normally the right answer and is preferred so
 * local dev keeps redirecting to whatever host the browser is actually on
 * (e.g. http://localhost:3000, not a configured staging APP_URL). But on a
 * self-host instance the frontend runs as a Next.js standalone server bound to
 * HOSTNAME=0.0.0.0 behind a reverse proxy (caddy), and the request origin
 * resolves to the internal wildcard BIND address `https://0.0.0.0:3000` instead
 * of the public host. Redirecting there drops the user on a dead address right
 * after they authenticate (observed live: SSO on a self-host landing on
 * `https://0.0.0.0:3000/projects?auth_event=signup&auth_method=sso:...`).
 *
 * A wildcard bind address (0.0.0.0 / [::]) is never a real client-facing
 * origin, so when we see one we fall back to the configured public APP_URL.
 * loopback (localhost / 127.0.0.1) is deliberately left as-is so the local-dev
 * behavior above is preserved.
 */
export function resolveAuthRedirectBaseUrl(
  requestOrigin: string | null | undefined,
  appUrl: string | null | undefined,
): string {
  const origin = requestOrigin || '';
  const cleanAppUrl = appUrl ? appUrl.replace(/\/+$/, '') : '';
  const isWildcardBindOrigin = /^https?:\/\/(0\.0\.0\.0|\[::\])(:\d+)?$/i.test(origin);
  if (isWildcardBindOrigin && cleanAppUrl) return cleanAppUrl;
  return origin || cleanAppUrl || 'http://localhost:3000';
}

export { DEFAULT_AUTH_RETURN_URL };
