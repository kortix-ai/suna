import type { MaintenanceConfig } from './maintenance-store';

export function automaticMaintenanceConfig(): MaintenanceConfig {
  return {
    level: 'blocking',
    title: 'Service maintenance',
    message: 'Kortix is temporarily unavailable. Service will resume automatically.',
    updatedAt: new Date().toISOString(),
  };
}

/**
 * "Nothing is wrong" — the config used where the maintenance gate cannot be
 * consulted at all, as opposed to consulted and found failing.
 *
 * The distinction matters because automaticMaintenanceConfig() above is
 * `blocking`: treating "cannot ask" as "outage" is correct on the web, where a
 * failed same-origin call really does imply the origin is down. It is wrong in
 * the desktop bundle, which ships no route handlers, so the call can never
 * succeed and the app would block itself on every launch.
 */
export function noMaintenanceConfig(): MaintenanceConfig {
  return {
    level: 'none',
    title: '',
    message: '',
    updatedAt: new Date().toISOString(),
  };
}

export function isMaintenanceProductRoute(pathname: string): boolean {
  // `/settings` earns its entry the same way `/accounts` did: the sign-in
  // redirect for an account with no app access lands there
  // (`app/(auth)/auth/callback/route.ts`), so leaving it out would walk that
  // user straight past a blocking maintenance screen.
  return ['/projects', '/accounts', '/invites', '/settings'].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
