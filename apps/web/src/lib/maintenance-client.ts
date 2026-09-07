import type { MaintenanceConfig } from './maintenance-store';

/**
 * What the client assumes when it cannot read the maintenance state at all
 * (`GET /api/maintenance` failed or answered non-2xx).
 *
 * Normal operation, NOT a lockdown. This used to return `level: 'blocking'`,
 * and `MaintenanceBannerHost` reacts to `blocking` by navigating the browser to
 * `/maintenance` — so one failed poll on a flaky connection threw the user out
 * of the app onto a maintenance page while the service was healthy. Same rule
 * as the server paths in `maintenance-store.ts`: a blocking lockdown is only
 * ever an explicit admin state, never the result of a failed read.
 */
export function unknownMaintenanceConfig(): MaintenanceConfig {
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
