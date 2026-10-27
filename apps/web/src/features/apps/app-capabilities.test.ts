import { readFileSync } from '@/i18n/test-source';
import type { App } from '@kortix/sdk';
import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { PROJECT_ACTIONS } from '@kortix/ui/workspace';
import { appCan } from '@kortix/ui/apps';
import { uiSourcePath } from '@/test-utils/read-source';

const root = resolve(import.meta.dir, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const webApp = (overrides: Partial<App> = {}): App => ({
  app_id: 'app-1', account_id: 'account-1', project_id: 'project-1', slug: 'site', name: 'Site',
  capabilities: ['deployments', 'rollback', 'preview', 'sleep', 'member_tokens'],
  url: 'https://site.example.test', access_mode: 'project', access_revision: 1, desired_state: 'running',
  active_deployment_id: null, machine: { cpu: 1, memory_gb: 1, disk_gb: 10 }, idle_timeout_seconds: 300,
  last_request_at: null,
  created_at: '2026-10-09T00:00:00.000Z', updated_at: '2026-10-09T00:00:00.000Z',
  ...overrides,
});

test('the UI branches on capabilities', () => {
  expect(appCan(webApp(), 'preview')).toBe(true);
  expect(appCan(webApp({ capabilities: ['deployments'] }), 'preview')).toBe(false);
  expect(appCan(webApp({ capabilities: undefined }), 'member_tokens')).toBe(false);
});

test('one Apps page: no Backends tab, page, palette entry or flag remains in the web app', () => {
  const tabs = readFileSync(uiSourcePath('customize/shared/capability-tabs.tsx'), 'utf8');
  const routes = readFileSync(uiSourcePath('internal/lib/capability-tab-routes.ts'), 'utf8');
  const menu = read('lib/menu-registry.ts');
  const flags = readFileSync(uiSourcePath('internal/lib/use-project-feature-flags.ts'), 'utf8');
  for (const source of [tabs, routes, menu, flags]) expect(source).not.toContain("'backends'");
  expect(Object.keys(PROJECT_ACTIONS).filter((key) => key.includes('BACKEND'))).toEqual([]);
  // The retired routes redirect to the Apps page; an id opens that App.
  const config = readFileSync(resolve(root, '../next.config.ts'), 'utf8');
  expect(config).toContain("['/projects/:id/backends', '/projects/:id/customize/backends']");
  expect(config).toContain("destination: '/projects/:id/apps?app=:appId'");
  expect(read('features/apps/apps-view.tsx')).toContain("searchParams.get('app')");
});

test('the detail modal takes its body and its capability items from app.capabilities', () => {
  const detail = read('features/apps/app-detail.tsx');
  const view = read('features/apps/apps-view.tsx');
  expect(detail).toContain("const preview = appCan(app, 'preview');");
  expect(detail).toContain("appCan(app, 'member_tokens') ? (");
  expect(detail).toContain("canRollback={canDeploy && appCan(app, 'rollback')}");
  expect(detail).toContain('{canDeploy && canSleep ? (');
  // An App without a preview never asks for an access session (the API answers 409).
  expect(detail).toContain('session: canAccess && preview');
  expect(view).toContain('session: canAccess && preview');
  // The header shows the App, not its wiring: no uses / used-by links, service chips or labels.
  expect(detail).not.toMatch(/app\.uses|app\.used_by|AppServices|app\.labels/);
});

test('no App kind, instance tile, snapshot, credential or dashboard control remains in the Apps UI', () => {
  const sources = [
    ...['app-detail.tsx', 'apps-view.tsx', 'app-connect.tsx'].map((file) => read(`features/apps/${file}`)),
    readFileSync(uiSourcePath('apps/app-shared.tsx'), 'utf8'),
  ];
  for (const source of sources) {
    expect(source).not.toMatch(/convex|appKindLabel|InstanceTile|snapshots|rotateCredentials|getAppCredentials|admin_credentials|app\.instance/i);
  }
});
