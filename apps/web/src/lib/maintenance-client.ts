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
  return ['/projects', '/accounts', '/invites'].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
