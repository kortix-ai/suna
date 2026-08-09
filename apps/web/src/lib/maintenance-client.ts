import type { MaintenanceConfig } from './maintenance-store';

export function automaticMaintenanceConfig(): MaintenanceConfig {
  return {
    level: 'blocking',
    title: 'Service maintenance',
    message: 'Kortix is temporarily unavailable. Service will resume automatically.',
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
