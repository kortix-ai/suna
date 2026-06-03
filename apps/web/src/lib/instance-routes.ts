export const ACTIVE_INSTANCE_COOKIE = 'kortix-active-instance';

export function getCurrentInstanceIdFromWindow(): string | null {
  if (typeof window === 'undefined') return null;
  return getActiveInstanceIdFromCookie();
}

function getActiveInstanceIdFromCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${ACTIVE_INSTANCE_COOKIE}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function setActiveInstanceCookie(_instanceId?: string | null): void {
  if (typeof document === 'undefined') return;

  document.cookie = `${ACTIVE_INSTANCE_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
}

export function toInstanceAwarePath(pathname: string, _instanceId?: string | null): string {
  return pathname;
}

export function normalizeAppPathname(pathname: string): string {
  return pathname;
}
