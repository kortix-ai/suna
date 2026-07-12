export const ACTIVE_INSTANCE_COOKIE = 'kortix-active-instance';

export const INSTANCE_SCOPED_ROUTES = [
  '/dashboard',
  '/agents',
  '/p',
  '/workspace',
  '/settings',
  '/browser',
  '/desktop',
  '/services',
  '/sessions',
  '/terminal',
  '/files',
  '/scheduled-tasks',
  '/commands',
  '/tools',
  '/configuration',
  '/changelog',
  '/legacy',
  '/credits-explained',
] as const;

export function isInstanceScopedAppPath(pathname: string): boolean {
  return INSTANCE_SCOPED_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

export function extractInstanceRoute(pathname: string): { instanceId: string; innerPath: string } | null {
  const match = pathname.match(/^\/instances\/([^/]+)(?:\/(.*))?$/);
  if (!match) return null;
  const instanceId = decodeURIComponent(match[1]);
  const rest = match[2] ?? '';
  return {
    instanceId,
    innerPath: rest ? `/${rest}` : '',
  };
}

export function isInstanceDetailPath(pathname: string): boolean {
  const parsed = extractInstanceRoute(pathname);
  return !!parsed && parsed.innerPath === '';
}

export function stripInstancePrefix(pathname: string): string {
  const parsed = extractInstanceRoute(pathname);
  if (!parsed || !parsed.innerPath) return pathname;
  return parsed.innerPath;
}

export function buildInstancePath(instanceId: string, pathname: string): string {
  if (!instanceId) return pathname;
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  if (pathname.startsWith('/instances/')) {
    const parsed = extractInstanceRoute(pathname);
    if (!parsed) return pathname;
    return `/instances/${encodeURIComponent(instanceId)}${parsed.innerPath}`;
  }
  if (!isInstanceScopedAppPath(pathname)) return pathname;
  return `/instances/${encodeURIComponent(instanceId)}${pathname}`;
}

export function getCurrentInstanceIdFromPathname(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  return extractInstanceRoute(pathname)?.instanceId ?? null;
}

export function getCurrentInstanceIdFromWindow(): string | null {
  if (typeof window === 'undefined') return null;
  // Pathname first (if not rewritten), then cookie (set by middleware before rewrite)
  return getCurrentInstanceIdFromPathname(window.location.pathname) || getActiveInstanceIdFromCookie();
}

export function getActiveInstanceIdFromCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${ACTIVE_INSTANCE_COOKIE}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function setActiveInstanceCookie(instanceId?: string | null): void {
  if (typeof document === 'undefined') return;
  // The one write site every branch below calls, instead of touching `document` directly.
  const writeCookie = (value: string): void => { document.cookie = value; };

  // Project routes must NEVER carry the legacy active-instance cookie.
  // With it set, middleware redirects any instance-scoped client-side nav
  // (/sessions/<id>, /files, /terminal/<id>, …) to /instances/<cookie>/...
  // which is the legacy dashboard the user explicitly does not want to
  // see. Always force-clear instead of writing the requested value.
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/projects')) {
    writeCookie(`${ACTIVE_INSTANCE_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`);
    return;
  }

  if (!instanceId) {
    writeCookie(`${ACTIVE_INSTANCE_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`);
    return;
  }

  writeCookie(`${ACTIVE_INSTANCE_COOKIE}=${encodeURIComponent(instanceId)}; Path=/; SameSite=Lax`);
}

export function toInstanceAwarePath(pathname: string, instanceId?: string | null): string {
  return instanceId ? buildInstancePath(instanceId, pathname) : pathname;
}

export function normalizeAppPathname(pathname: string): string {
  const parsed = extractInstanceRoute(pathname);
  if (!parsed) return pathname;
  return parsed.innerPath || '/dashboard';
}
