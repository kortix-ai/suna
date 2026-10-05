import { describe, expect, test } from 'bun:test';
import {
  isMaintenanceProductRoute,
  MAINTENANCE_PUBLIC_CACHE_CONTROL,
  unknownMaintenanceConfig,
} from './maintenance-client';

describe('maintenance client fallback', () => {
  test('stays out of maintenance after a status request failure', () => {
    // Fail open. `MaintenanceBannerHost` navigates to /maintenance on
    // `blocking`, so returning it here ejected users from a healthy app on one
    // failed poll.
    expect(unknownMaintenanceConfig()).toMatchObject({
      level: 'none',
      title: '',
      message: '',
    });
  });

  test('redirects product routes but keeps public and admin routes available', () => {
    expect(isMaintenanceProductRoute('/projects')).toBe(true);
    expect(isMaintenanceProductRoute('/projects/project-id')).toBe(true);
    // `/accounts` is not a route: the account hub is a modal over one of the
    // paths above (`?accountId=`), so the page it opens on is what this gates.
    expect(isMaintenanceProductRoute('/accounts')).toBe(false);
    expect(isMaintenanceProductRoute('/projects/p1?accountId=acc_1')).toBe(true);
    expect(isMaintenanceProductRoute('/invites/token')).toBe(true);
    // The post-sign-in destination for an account with no app access.
    expect(isMaintenanceProductRoute('/settings')).toBe(true);
    expect(isMaintenanceProductRoute('/settings/billing')).toBe(true);
    expect(isMaintenanceProductRoute('/')).toBe(false);
    expect(isMaintenanceProductRoute('/pricing')).toBe(false);
    expect(isMaintenanceProductRoute('/admin/utils')).toBe(false);
    expect(isMaintenanceProductRoute('/maintenance')).toBe(false);
  });

  test('the public poll is served from a short shared cache, never the browser cache', () => {
    // Every open tab polls GET /api/maintenance. The CDN absorbs the fleet;
    // `max-age=0` keeps a tab from reusing its own copy past the CDN window,
    // so an admin change reaches tabs within ~10-40 s.
    const directives = MAINTENANCE_PUBLIC_CACHE_CONTROL.split(',').map((d) => d.trim());
    expect(directives).toContain('public');
    expect(directives).toContain('max-age=0');
    expect(directives).toContain('s-maxage=10');
    expect(directives.some((d) => d.startsWith('stale-while-revalidate='))).toBe(true);
    expect(directives).not.toContain('no-store');
  });
});
