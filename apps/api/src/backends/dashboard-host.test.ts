import { afterEach, describe, expect, test } from 'bun:test';

process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.FRONTEND_URL = 'https://app.example.com';
delete process.env.KORTIX_APPS_BASE_DOMAIN;
delete process.env.KORTIX_APPS_LOCAL;

const { config } = await import('../config');
const { resolveAppHost } = await import('../apps/hostnames');
const { backendDashboardUrl, resolveBackendDashboardHost } = await import('./dashboard-host');

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const HEX = '0f8fad5bd9cb469fa16570867728950e';
const originalUrl = config.KORTIX_URL;
const row = (patch: Record<string, unknown> = {}) =>
  ({ backendId: ID, status: 'running', url: 'https://3210-x.sbx.example', metadata: { dashboard: true }, ...patch }) as never;

afterEach(() => {
  (config as { KORTIX_URL: string }).KORTIX_URL = originalUrl;
});

describe('backend dashboard host', () => {
  test('cloud: one host per backend on the Apps domain, round-tripping the id', () => {
    (config as { KORTIX_URL: string }).KORTIX_URL = 'https://dev-api.kortix.com';
    const url = backendDashboardUrl(row());
    expect(url).toBe(`https://dev-backend-${HEX}.apps.kortix.com`);
    expect(resolveBackendDashboardHost(new URL(url!).hostname)).toEqual({ backendId: ID, local: false });
    // Never an App host, and another environment's dashboard is not ours.
    expect(resolveAppHost(new URL(url!).hostname)).toBeNull();
    expect(resolveBackendDashboardHost(`prod-backend-${HEX}.apps.kortix.com`)).toBeNull();
    expect(resolveBackendDashboardHost(`dev-backend-${HEX}.apps.example.com`)).toBeNull();
  });

  test('local: bd-<id>.apps.localhost on the API port', () => {
    (config as { KORTIX_URL: string }).KORTIX_URL = 'http://localhost:8008';
    expect(backendDashboardUrl(row())).toMatch(new RegExp(`^http://bd-${HEX}\\.apps\\.localhost:\\d+$`));
    expect(resolveBackendDashboardHost(`bd-${HEX}.apps.localhost`)).toEqual({ backendId: ID, local: true });
    expect(resolveBackendDashboardHost(`bd-${HEX.slice(1)}.apps.localhost`)).toBeNull();
  });

  test('no URL for a machine without the dashboard or not running', () => {
    expect(backendDashboardUrl(row({ metadata: {} }))).toBeNull();
    expect(backendDashboardUrl(row({ status: 'provisioning' }))).toBeNull();
  });
});
