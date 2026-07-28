import {
  LAST_PROJECT_COOKIE,
  LAST_PROJECT_COOKIE_MAX_AGE,
  isValidProjectId,
} from '@/lib/onboarding/landing-destination';

/**
 * Browser-side access to the "project you had open last" cookie.
 *
 * Deliberately a cookie and not localStorage: middleware has to read it to send
 * `/` and post-auth redirects straight to a project, and middleware cannot see
 * localStorage. It holds a project id only — never a token — and every consumer
 * re-validates it, because the browser can write anything here.
 */
export function readLastProjectId(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie
    .split('; ')
    .find((entry) => entry.startsWith(`${LAST_PROJECT_COOKIE}=`));
  if (!match) return null;
  const value = decodeURIComponent(match.slice(LAST_PROJECT_COOKIE.length + 1));
  return isValidProjectId(value) ? value : null;
}

export function writeLastProjectId(projectId: string): void {
  if (typeof document === 'undefined') return;
  if (!isValidProjectId(projectId)) return;
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie =
    `${LAST_PROJECT_COOKIE}=${encodeURIComponent(projectId)}` +
    `; Path=/; Max-Age=${LAST_PROJECT_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
}

export function clearLastProjectId(): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${LAST_PROJECT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}
