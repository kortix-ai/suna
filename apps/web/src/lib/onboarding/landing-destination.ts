/**
 * Where an authenticated user lands by default.
 *
 * The product is a workspace. Every default entry point
 * (post-auth redirect, `/`, the desktop shell) resolves to a workspace page. The
 * legacy `/projects` entry point stays reachable for compatibility.
 *
 * `WORKSPACE_LANDING_PATH` is the id-free door used when we do not yet know which
 * workspace to open. It paints instantly and resolves the real workspace behind the
 * UI, so no caller ever has to block on a backend round-trip to build a
 * redirect. See `app/(app)/workspaces/start/page.tsx`.
 */
export const WORKSPACE_LANDING_PATH = '/workspaces/start';
/** Non-httpOnly so middleware can read it and the workspace page can set it. */
export const LAST_WORKSPACE_COOKIE = 'kortix_last_project';

/**
 * Set at the moment authentication completes — by the `/auth/callback` route
 * on its redirect response, and by the `/auth` page before its client-side
 * redirect. It marks the navigation that follows as "the user just signed
 * in", which is the strongest possible proof of intent the landing door can
 * ask for before provisioning a first workspace.
 *
 * This exists because `document.referrer` cannot carry that proof: a magic
 * link opened from Gmail arrives with a `https://mail.google.com/` referrer,
 * an OAuth signup arrives from the IdP, and a client-side redirect keeps
 * whatever referrer `/auth` itself was loaded with (often a search engine).
 * All of those are cross-origin, so a referrer-only CSRF gate demoted exactly
 * the users it must never demote — brand-new signups — to the workspaces list.
 * A cross-site attacker can strip a referrer, but cannot set this cookie.
 */
export const POST_AUTH_INTENT_COOKIE = 'kortix_post_auth';

/** Short-lived on purpose: it only has to outlive the post-auth redirect. */
export const POST_AUTH_INTENT_MAX_AGE = 60 * 5;

/** One year. The value is a workspace id, not a credential. */
export const LAST_WORKSPACE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The cookie is written by the browser, so treat it as untrusted input. Only a
 * well-formed UUID is ever interpolated into a redirect path — that keeps a
 * tampered cookie from turning the `/` redirect into an open redirect or a
 * path-traversal.
 */
export function isValidWorkspaceId(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * The cookie stores `<userId>:<workspaceId>`, NOT a bare workspace id.
 *
 * One browser outlives one session. Signing out of account A and into account B
 * left A's cookie in place, and a bare workspace id gave B a redirect straight
 * into A's workspace — landing on "Request access to this workspace" on EVERY
 * login, because an access-denied screen is a legitimate 403 surface and not an
 * error the stale-cookie self-heal catches.
 *
 * Binding the id to its owner makes that state unrepresentable: a cookie whose
 * user does not match the authenticated user is ignored. That holds for
 * sign-out, session expiry, a closed tab, and two accounts sharing a browser —
 * none of which "clear it on sign-out" covers on its own.
 */
export function serializeLastWorkspace(userId: string, workspaceId: string): string | null {
  if (!isValidWorkspaceId(userId) || !isValidWorkspaceId(workspaceId)) return null;
  return `${userId}:${workspaceId}`;
}

/**
 * The workspace id in the cookie, but ONLY when it belongs to `currentUserId`.
 * Returns null for a mismatch, a malformed value, or a legacy bare Workspace id
 * cookie written before this binding existed.
 */
export function parseLastWorkspaceForUser(
  cookieValue: string | null | undefined,
  currentUserId: string | null | undefined,
): string | null {
  if (!cookieValue || !isValidWorkspaceId(currentUserId)) return null;
  const separator = cookieValue.indexOf(':');
  if (separator === -1) return null; // legacy bare id — unowned, so never trusted
  const ownerId = cookieValue.slice(0, separator);
  const workspaceId = cookieValue.slice(separator + 1);
  if (ownerId !== currentUserId) return null;
  return isValidWorkspaceId(workspaceId) ? workspaceId : null;
}

/** `/workspaces/<id>` for a trusted-shaped id, else null. */
export function workspacePathFromId(workspaceId: string | null | undefined): string | null {
  return isValidWorkspaceId(workspaceId) ? `/workspaces/${workspaceId}` : null;
}

/**
 * The default destination for an authenticated user, given whatever the browser
 * remembered. Falls back to the instant landing door, never to the list.
 *
 * `currentUserId` is required for the remembered workspace to be used at all —
 * callers without it get the door, which re-resolves correctly.
 */
export function resolveDefaultLandingPath(
  cookieValue: string | null | undefined,
  currentUserId: string | null | undefined,
): string {
  return (
    workspacePathFromId(parseLastWorkspaceForUser(cookieValue, currentUserId)) ??
    WORKSPACE_LANDING_PATH
  );
}
