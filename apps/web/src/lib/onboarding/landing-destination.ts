/**
 * Where an authenticated user lands by default.
 *
 * The product is a project, not a list of projects. Every default entry point
 * (post-auth redirect, `/`, the desktop shell) resolves to a project page. The
 * `/projects` list stays reachable, but only when the user asks for it.
 *
 * `PROJECT_LANDING_PATH` is the id-free door used when we do not yet know which
 * project to open. It paints instantly and resolves the real project behind the
 * UI, so no caller ever has to block on a backend round-trip to build a
 * redirect. See `app/(app)/projects/start/page.tsx`.
 */
export const PROJECT_LANDING_PATH = '/projects/start';

/** Non-httpOnly so middleware can read it and the project page can set it. */
export const LAST_PROJECT_COOKIE = 'kortix_last_project';

/**
 * Set at the moment authentication completes — by the `/auth/callback` route
 * on its redirect response, and by the `/auth` page before its client-side
 * redirect. It marks the navigation that follows as "the user just signed
 * in", which is the strongest possible proof of intent the landing door can
 * ask for before provisioning a first project.
 *
 * This exists because `document.referrer` cannot carry that proof: a magic
 * link opened from Gmail arrives with a `https://mail.google.com/` referrer,
 * an OAuth signup arrives from the IdP, and a client-side redirect keeps
 * whatever referrer `/auth` itself was loaded with (often a search engine).
 * All of those are cross-origin, so a referrer-only CSRF gate demoted exactly
 * the users it must never demote — brand-new signups — to the projects list.
 * A cross-site attacker can strip a referrer, but cannot set this cookie.
 */
export const POST_AUTH_INTENT_COOKIE = 'kortix_post_auth';

/** Short-lived on purpose: it only has to outlive the post-auth redirect. */
export const POST_AUTH_INTENT_MAX_AGE = 60 * 5;

/**
 * Written by the middleware at the exact moment it turns an unauthenticated
 * request into `/auth?redirect=<path>`. Value: `<ownerId>:<encoded path>`.
 *
 * The `redirect` query param carries the path but no identity, so the auth
 * flows downstream cannot tell "this user's own session just expired" from
 * "a different user was here 30 seconds ago". They are opposite answers: the
 * first must return to the path, the second must never see it. Signing in as B
 * on a screen bounced from A's project sent B to A's "Request access" page,
 * because the only guard in place ran for brand-new accounts.
 *
 * The owner half is allowed to be EMPTY. Middleware does not always have a user
 * id to attach (the stale-session self-heal may have already nulled it), and a
 * pasted or bookmarked `/auth?redirect=…` link arrives with no cookie at all.
 * An empty owner means UNATTRIBUTED, which never demotes — see
 * `shouldDemoteReturnUrl`.
 */
export const AUTH_BOUNCE_COOKIE = 'kortix_auth_bounce';

/** Short-lived on purpose: it only has to outlive one trip through /auth. */
export const AUTH_BOUNCE_MAX_AGE = 60 * 5;

/** One year. The value is a project id, not a credential. */
export const LAST_PROJECT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The cookie is written by the browser, so treat it as untrusted input. Only a
 * well-formed UUID is ever interpolated into a redirect path — that keeps a
 * tampered cookie from turning the `/` redirect into an open redirect or a
 * path-traversal.
 */
export function isValidProjectId(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * The cookie stores `<userId>:<projectId>`, NOT a bare project id.
 *
 * One browser outlives one session. Signing out of account A and into account B
 * left A's cookie in place, and a bare project id gave B a redirect straight
 * into A's project — landing on "Request access to this project" on EVERY
 * login, because an access-denied screen is a legitimate 403 surface and not an
 * error the stale-cookie self-heal catches.
 *
 * Binding the id to its owner makes that state unrepresentable: a cookie whose
 * user does not match the authenticated user is ignored. That holds for
 * sign-out, session expiry, a closed tab, and two accounts sharing a browser —
 * none of which "clear it on sign-out" covers on its own.
 */
export function serializeLastProject(userId: string, projectId: string): string | null {
  if (!isValidProjectId(userId) || !isValidProjectId(projectId)) return null;
  return `${userId}:${projectId}`;
}

/**
 * The project id in the cookie, but ONLY when it belongs to `currentUserId`.
 * Returns null for a mismatch, a malformed value, or a legacy bare-project-id
 * cookie written before this binding existed.
 */
export function parseLastProjectForUser(
  cookieValue: string | null | undefined,
  currentUserId: string | null | undefined,
): string | null {
  if (!cookieValue || !isValidProjectId(currentUserId)) return null;
  const separator = cookieValue.indexOf(':');
  if (separator === -1) return null; // legacy bare id — unowned, so never trusted
  const ownerId = cookieValue.slice(0, separator);
  const projectId = cookieValue.slice(separator + 1);
  if (ownerId !== currentUserId) return null;
  return isValidProjectId(projectId) ? projectId : null;
}

/**
 * The owner half of a `<ownerId>:<rest>` cookie, or `''` when the cookie is
 * absent, has no separator, or names something that is not a user id.
 *
 * Both cookies written by this module use that shape, and both are written by
 * the browser, so the owner is validated before anyone compares against it.
 * `''` is the honest answer for "no identity here", never a wildcard.
 */
function ownerIdFromCookie(cookieValue: string | null | undefined): string {
  if (!cookieValue) return '';
  const separator = cookieValue.indexOf(':');
  if (separator === -1) return '';
  const ownerId = cookieValue.slice(0, separator);
  return isValidProjectId(ownerId) ? ownerId : '';
}

/**
 * The `AUTH_BOUNCE_COOKIE` value for one middleware bounce.
 *
 * The path is percent-encoded here rather than left to the cookie serializer,
 * because a request path can legally hold characters a cookie value cannot (a
 * comma, a semicolon, a space) and a truncated header is not worth the risk.
 * Only the owner half is ever read back; the path rides along so a bounce is
 * legible in a browser inspector and in a bug report.
 */
export function serializeAuthBounce(ownerId: string | null | undefined, path: string): string {
  return `${isValidProjectId(ownerId) ? ownerId : ''}:${encodeURIComponent(path)}`;
}

/** Who owned the session that got bounced, or `''` for an UNATTRIBUTED bounce. */
export function parseAuthBounceOwner(cookieValue: string | null | undefined): string {
  return ownerIdFromCookie(cookieValue);
}

/**
 * Who the remembered project belongs to, or `''`. The middleware falls back to
 * this when the bounce happens after the stale-session self-heal has already
 * dropped the Supabase cookies and there is no user id left to read.
 */
export function parseLastProjectOwner(cookieValue: string | null | undefined): string {
  return ownerIdFromCookie(cookieValue);
}

/** `/projects/<id>` for a trusted-shaped id, else null. */
export function projectPathFromId(projectId: string | null | undefined): string | null {
  return isValidProjectId(projectId) ? `/projects/${projectId}` : null;
}

/**
 * The default destination for an authenticated user, given whatever the browser
 * remembered. Falls back to the instant landing door, never to the list.
 *
 * `currentUserId` is required for the remembered project to be used at all —
 * callers without it get the door, which re-resolves correctly.
 */
export function resolveDefaultLandingPath(
  cookieValue: string | null | undefined,
  currentUserId: string | null | undefined,
): string {
  return (
    projectPathFromId(parseLastProjectForUser(cookieValue, currentUserId)) ?? PROJECT_LANDING_PATH
  );
}
