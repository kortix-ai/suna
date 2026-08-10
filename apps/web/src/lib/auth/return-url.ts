import { WORKSPACE_LANDING_PATH } from '@/lib/onboarding/landing-destination';

// Post-auth landing goes to a workspace, never to the workspaces list. The landing
// door paints immediately and resolves (or provisions) the workspace behind the
// UI, so no auth path has to block on the backend to build this redirect.
const DEFAULT_AUTH_RETURN_URL = WORKSPACE_LANDING_PATH;
const LEGACY_AUTH_RETURN_PREFIXES = [
  '/dashboard',
  '/instances',
  '/sessions',
  '/subscription',
] as const;

/**
 * Return paths that still mean something to an account created seconds ago.
 *
 * Two kinds qualify:
 *  - *join / authorize* flows — the signup happened FOR this destination (an
 *    invite, a CLI pairing code, an OAuth consent screen). Dropping these
 *    strands the very flow that sent the user to sign up.
 *  - *public* pages — nothing behind them is account-scoped, so a brand-new
 *    identity renders them exactly like an old one. These are the marketplace
 *    and use-case CTAs that started the signup in the first place.
 *
 * Everything else is account-scoped, and a brand-new account cannot own a
 * resource that existed before it did. See `resolveNewAccountReturnUrl`.
 */
const SIGNUP_SAFE_RETURN_PREFIXES = [
  '/invites',
  '/oauth/authorize',
  '/cli/authorize',
  '/tunnel/authorize',
  '/slack/login',
  '/teams/login',
  '/github/setup',
  '/marketplace',
  '/use-cases',
] as const;

/** Prefix match on path segment boundaries, so `/marketplace` never matches `/marketplace-evil`. */
function matchesReturnPrefix(value: string, prefix: string): boolean {
  return value === prefix || value.startsWith(`${prefix}/`) || value.startsWith(`${prefix}?`);
}

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

  // Canonicalize BEFORE any prefix check, and return the canonical form.
  //
  // Every consumer eventually rebuilds this path through `new URL()` — the
  // password flow to attach auth_event, the callback to prepend the origin —
  // and that collapses dot segments. So a prefix test against the raw string
  // is testing a path the browser will never visit:
  // `/marketplace/../projects/<id>` passes a `/marketplace` check and then
  // lands on `/projects/<id>`, which is exactly the foreign-project bug the
  // signup rule below exists to prevent (and would equally slip a
  // `/x/../dashboard` past LEGACY_AUTH_RETURN_PREFIXES). Normalizing here
  // means every downstream rule sees the path that will actually be opened.
  let normalizedValue: string;
  try {
    const resolved = new URL(trimmedValue, 'https://kortix.local');
    if (resolved.origin !== 'https://kortix.local') return fallback;
    normalizedValue = `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return fallback;
  }

  // Middleware preserves an unauthenticated request as the post-auth return
  // path. A request for the bare list must still enter through the landing
  // door. Otherwise a new account renders the collection while its first
  // workspace is being provisioned.
  if (normalizedValue === '/workspaces' || normalizedValue === '/projects') {
    return WORKSPACE_LANDING_PATH;
  }

  if (LEGACY_AUTH_RETURN_PREFIXES.some((prefix) => matchesReturnPrefix(normalizedValue, prefix))) {
    return fallback;
  }

  return normalizedValue;
}

/**
 * True when an (already-sanitized) return URL is one a brand-new account can
 * actually act on.
 */
export function isSignupSafeReturnUrl(returnUrl: string | null | undefined): boolean {
  if (typeof returnUrl !== 'string' || returnUrl.length === 0) return false;
  if (matchesReturnPrefix(returnUrl, WORKSPACE_LANDING_PATH)) return true;
  return SIGNUP_SAFE_RETURN_PREFIXES.some((prefix) => matchesReturnPrefix(returnUrl, prefix));
}

/**
 * The post-auth destination for an account that has just been created.
 *
 * Middleware turns any unauthenticated request into `?redirect=<path>`, so the
 * return URL is whatever the visitor happened to have open — very often a link
 * to somebody else's project. Replaying that after a SIGNUP drops a
 * seconds-old account on "Request access to this workspace": the one page it can
 * never act on, because the account did not exist when that project was
 * created and no amount of waiting changes that. The first thing a new user
 * sees is a locked door belonging to a stranger.
 *
 * So a signup keeps its return URL only when the URL is signup-safe, and
 * otherwise enters through the landing door into its own first project.
 *
 * This is an allowlist on purpose. An account-scoped route added later fails
 * safe — the new user lands in their own project — instead of silently reviving
 * this bug, which is exactly what a denylist would do.
 */
export function resolveNewAccountReturnUrl(
  returnUrl: string | null | undefined,
  fallback = DEFAULT_AUTH_RETURN_URL,
): string {
  const sanitized = sanitizeAuthReturnUrl(returnUrl, fallback);
  return isSignupSafeReturnUrl(sanitized) ? sanitized : fallback;
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
