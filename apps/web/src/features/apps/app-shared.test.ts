import { expect, test } from 'bun:test';
import type { App } from '@kortix/sdk';
import type { UiTranslator } from '@/i18n/translator';
import { appStatus, appTabLabel, childApps, gridApps } from './app-shared';

const t = { raw: (key: string) => key } as unknown as UiTranslator;
const app = (overrides: Partial<App>): App => ({
  app_id: 'app-1', account_id: 'account-1', project_id: 'project-1', slug: 'site', name: 'Site',
  url: 'https://site.apps.example.test', access_mode: 'public', access_revision: 1, desired_state: 'running',
  active_deployment_id: 'deployment-1', machine: { cpu: 1, memory_gb: 2, disk_gb: 10 }, idle_timeout_seconds: 300,
  last_request_at: null, created_at: '2026-10-07T00:00:00.000Z', updated_at: '2026-10-07T00:00:00.000Z',
  ...overrides,
});

test('a static App with an active deployment is live even when desired_state says stopped', () => {
  expect(appStatus(app({ hosting_type: 'static', desired_state: 'stopped' }), t).live).toBe(true);
});

test('a stopped server App is not live; an undeployed App is not deployed', () => {
  expect(appStatus(app({ hosting_type: 'sandbox', desired_state: 'stopped' }), t)).toMatchObject({ deployed: true, live: false });
  expect(appStatus(app({ active_deployment_id: null, hosting_type: null }), t)).toMatchObject({ deployed: false, live: false });
});


test('display: the grid drops an unlisted App and a tab whose parent exists; a tab of a missing parent stays a card', () => {
  const backend = app({ app_id: 'b', slug: 'crm-data', name: 'crm-data', display: { preview: 'none' } });
  const dashboard = app({ app_id: 'd', slug: 'crm-data-dashboard', name: 'crm-data-dashboard', display: { parent: 'crm-data' } });
  const worker = app({ app_id: 'w', slug: 'worker', display: { listed: false } });
  const orphan = app({ app_id: 'o', slug: 'orphan', display: { parent: 'gone' } });
  const all = [backend, dashboard, worker, orphan];
  expect(gridApps(all).map((row) => row.slug)).toEqual(['crm-data', 'orphan']);
  expect(childApps(all, backend).map((row) => row.slug)).toEqual(['crm-data-dashboard']);
  expect(childApps(all, worker)).toEqual([]);
  expect(appTabLabel(dashboard, backend)).toBe('Dashboard');
  expect(appTabLabel(app({ name: 'Admin console' }), backend)).toBe('Admin console');
});
