import {
  LAST_WORKSPACE_COOKIE,
  LAST_WORKSPACE_COOKIE_MAX_AGE,
  parseLastWorkspaceForUser,
  resolveDefaultLandingPath,
  serializeLastWorkspace,
} from '@/lib/onboarding/landing-destination';

/**
 * Browser-side access to the "workspace you had open last" cookie.
 *
 * Deliberately a cookie and not localStorage: middleware has to read it to send
 * `/` and post-auth redirects straight to a workspace, and middleware cannot see
 * localStorage. It holds `<userId>:<workspaceId>` — never a token — and every
 * consumer re-validates it, because the browser can write anything here.
 *
 * EVERY read and write is scoped to a user id. A browser outlives a session, so
 * an unscoped cookie sent the next person to sign in on this machine straight
 * into the previous person's project. Callers that cannot supply the current
 * user id get null / the landing door, which re-resolves correctly.
 */
export function readRawLastWorkspaceCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie
    .split('; ')
    .find((entry) => entry.startsWith(`${LAST_WORKSPACE_COOKIE}=`));
  if (!match) return null;
  return decodeURIComponent(match.slice(LAST_WORKSPACE_COOKIE.length + 1));
}

/** The remembered project, but only if it belongs to `userId`. */
export function readLastWorkspaceId(userId: string | null | undefined): string | null {
  return parseLastWorkspaceForUser(readRawLastWorkspaceCookie(), userId);
}

export function writeLastWorkspaceId(userId: string | null | undefined, workspaceId: string): void {
  if (typeof document === 'undefined') return;
  if (!userId) return;
  const value = serializeLastWorkspace(userId, workspaceId);
  if (!value) return;
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie =
    `${LAST_WORKSPACE_COOKIE}=${encodeURIComponent(value)}` +
    `; Path=/; Max-Age=${LAST_WORKSPACE_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
}

export function clearLastWorkspaceId(): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${LAST_WORKSPACE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

/**
 * Where "take me into the app" goes from client code: the latest workspace this
 * user had open, else the landing door that resolves one.
 *
 * Use this for every implicit destination — post-flow returns, the logo, the
 * marketing "launch app" CTA. Never use the legacy `/projects` route as a
 * default destination.
 *
 * Pass the CURRENT user's id. Omitting it is safe (you get the door) but loses
 * the direct hop. Do NOT use this after an account switch — the cookie names a
 * workspace in the account the user just left, which is still theirs and so still
 * passes the ownership check. Those callers must use `WORKSPACE_LANDING_PATH`.
 */
export function latestWorkspacePath(userId: string | null | undefined): string {
  return resolveDefaultLandingPath(readRawLastWorkspaceCookie(), userId);
}
