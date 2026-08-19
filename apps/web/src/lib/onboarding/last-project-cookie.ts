import {
  LAST_PROJECT_COOKIE,
  LAST_PROJECT_COOKIE_MAX_AGE,
  parseLastProjectForUser,
  resolveDefaultLandingPath,
  serializeLastProject,
} from '@/lib/onboarding/landing-destination';

/**
 * Browser-side access to the "project you had open last" cookie.
 *
 * Deliberately a cookie and not localStorage: middleware has to read it to send
 * `/` and post-auth redirects straight to a project, and middleware cannot see
 * localStorage. It holds `<userId>:<projectId>` — never a token — and every
 * consumer re-validates it, because the browser can write anything here.
 *
 * EVERY read and write is scoped to a user id. A browser outlives a session, so
 * an unscoped cookie sent the next person to sign in on this machine straight
 * into the previous person's project. Callers that cannot supply the current
 * user id get null / the landing door, which re-resolves correctly.
 */
export function readRawLastProjectCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie
    .split('; ')
    .find((entry) => entry.startsWith(`${LAST_PROJECT_COOKIE}=`));
  if (!match) return null;
  return decodeURIComponent(match.slice(LAST_PROJECT_COOKIE.length + 1));
}

/** The remembered project, but only if it belongs to `userId`. */
export function readLastProjectId(userId: string | null | undefined): string | null {
  return parseLastProjectForUser(readRawLastProjectCookie(), userId);
}

export function writeLastProjectId(userId: string | null | undefined, projectId: string): void {
  if (typeof document === 'undefined') return;
  if (!userId) return;
  const value = serializeLastProject(userId, projectId);
  if (!value) return;
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie =
    `${LAST_PROJECT_COOKIE}=${encodeURIComponent(value)}` +
    `; Path=/; Max-Age=${LAST_PROJECT_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
}

export function clearLastProjectId(): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${LAST_PROJECT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

/**
 * Where "take me into the app" goes from client code: the latest project this
 * user had open, else the landing door that resolves one.
 *
 * Use this for every implicit destination — post-flow returns, the logo, the
 * marketing "launch app" CTA. Never send those to `/projects`: the list is a
 * place the user chooses to visit, not a place the app drops them.
 *
 * Pass the CURRENT user's id. Omitting it is safe (you get the door) but loses
 * the direct hop. Do NOT use this after an account switch — the cookie names a
 * project in the account the user just left, which is still theirs and so still
 * passes the ownership check. Those callers must use `PROJECT_LANDING_PATH`.
 */
export function latestProjectPath(userId: string | null | undefined): string {
  return resolveDefaultLandingPath(readRawLastProjectCookie(), userId);
}
