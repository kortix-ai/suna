import { describe, expect, test } from 'bun:test';
import { isMaintenanceProductRoute, unknownMaintenanceConfig } from './maintenance-client';

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
    expect(isMaintenanceProductRoute('/accounts')).toBe(true);
    expect(isMaintenanceProductRoute('/invites/token')).toBe(true);
    // The post-sign-in destination for an account with no app access.
    expect(isMaintenanceProductRoute('/settings')).toBe(true);
    expect(isMaintenanceProductRoute('/settings/billing')).toBe(true);
    expect(isMaintenanceProductRoute('/')).toBe(false);
    expect(isMaintenanceProductRoute('/pricing')).toBe(false);
    expect(isMaintenanceProductRoute('/admin/utils')).toBe(false);
    expect(isMaintenanceProductRoute('/maintenance')).toBe(false);
  });
});
