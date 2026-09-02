import { PROJECT_LANDING_PATH } from '@/lib/onboarding/landing-destination';

// Post-auth landing goes to a project, never to the projects list. The landing
// door paints immediately and resolves (or provisions) the project behind the
// UI, so no auth path has to block on the backend to build this redirect.
const DEFAULT_AUTH_RETURN_URL = PROJECT_LANDING_PATH;
const LEGACY_AUTH_RETURN_PREFIXES = [
  // Not legacy — but the same rule applies: a sign-in must never RETURN here.
  // `?redirect=/logout` would undo the sign-in that just happened, so it is
  // replaced with the landing door. See `app/logout/page.tsx`.
  '/logout',
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
 *    identity renders them exactly like an old one. `/use-cases` is the live
 *    one: its CTA is what started the signup. `/marketplace` is held for the
 *    public subproject catalog and has no page yet, so a return there answers
 *    `404` rather than being blocked — the right failure, and the reason the
 *    prefix stays rather than being removed and re-added.
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
  // door. Otherwise a new account renders /projects while its first project is
  // being provisioned.
  if (normalizedValue === '/projects') return PROJECT_LANDING_PATH;

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
  if (matchesReturnPrefix(returnUrl, PROJECT_LANDING_PATH)) return true;
  return SIGNUP_SAFE_RETURN_PREFIXES.some((prefix) => matchesReturnPrefix(returnUrl, prefix));
}

/**
 * The post-auth destination for an account that has just been created.
 *
 * Middleware turns any unauthenticated request into `?redirect=<path>`, so the
 * return URL is whatever the visitor happened to have open — very often a link
 * to somebody else's project. Replaying that after a SIGNUP drops a
 * seconds-old account on "Request access to this project": the one page it can
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
 * Whether the visitor's return URL must be resolved through the new-account
 * rule instead of replayed verbatim.
 *
 * Two cases, one answer:
 *  - `isNewUser` — the account is seconds old and cannot own anything that
 *    predates it. This is the rule that already shipped.
 *  - an ATTRIBUTED bounce whose owner is not the user who just signed in. The
 *    middleware wrote `/auth?redirect=<path>` for somebody else's session, and
 *    replaying it drops this user on a stranger's "Request access" page. An
 *    existing account is exactly the population the `isNewUser` rule excludes,
 *    which is why a second account on the same browser kept landing there.
 *
 * An UNATTRIBUTED bounce (`bouncedOwnerId` empty) NEVER demotes. Middleware
 * cannot always name an owner, and a pasted or bookmarked
 * `/auth?redirect=<path>` link carries no bounce cookie at all — treating
 * "unknown" as "foreign" would break both.
 *
 * A named owner with no known signer DOES demote: that is the fail-closed half.
 */
export function shouldDemoteReturnUrl({
  bouncedOwnerId,
  signedInUserId,
  isNewUser,
}: {
  bouncedOwnerId?: string | null;
  signedInUserId?: string | null;
  isNewUser?: boolean | null;
}): boolean {
  if (isNewUser) return true;
  const owner = typeof bouncedOwnerId === 'string' ? bouncedOwnerId : '';
  if (owner.length === 0) return false;
  return owner !== (typeof signedInUserId === 'string' ? signedInUserId : '');
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
 * A wildcard bind address (0.0.0.0 / [::]) and an AWS private compute hostname
 * are never client-facing origins. ECS can expose the latter as
 * `ip-10-…us-west-2.compute.internal:3000` even when an ALB received the public
 * request. In both cases, fall back to the configured public APP_URL. Loopback
 * (localhost / 127.0.0.1) stays unchanged so local development remains local.
 */
export function resolveAuthRedirectBaseUrl(
  requestOrigin: string | null | undefined,
  appUrl: string | null | undefined,
): string {
  const origin = requestOrigin || '';
  const cleanAppUrl = appUrl ? appUrl.replace(/\/+$/, '') : '';
  const isWildcardBindOrigin = /^https?:\/\/(0\.0\.0\.0|\[::\])(:\d+)?$/i.test(origin);
  let isPrivateComputeOrigin = false;
  try {
    isPrivateComputeOrigin = new URL(origin).hostname.toLowerCase().endsWith('.compute.internal');
  } catch {
    // The existing fallback below owns malformed or absent origins.
  }
  if ((isWildcardBindOrigin || isPrivateComputeOrigin) && cleanAppUrl) return cleanAppUrl;
  return origin || cleanAppUrl || 'http://localhost:3000';
}

export { DEFAULT_AUTH_RETURN_URL };
