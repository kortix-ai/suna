import { describe, expect, test } from 'bun:test';
import { automaticMaintenanceConfig, isMaintenanceProductRoute } from './maintenance-client';

describe('maintenance client fallback', () => {
  test('activates blocking maintenance after a status request failure', () => {
    expect(automaticMaintenanceConfig()).toMatchObject({
      level: 'blocking',
      title: 'Service maintenance',
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
