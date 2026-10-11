import { readFileSync } from '@/i18n/test-source';
import type { UiTranslator } from '@/i18n/translator';
import type { App, AppInstance } from '@kortix/sdk';
import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { credentialsEnvText } from './app-connect';
import {
  formatBackupSize,
  manualSnapshotCount,
  sizeChanges,
  sizeDraft,
  sizeFieldValid,
  sizeMin,
  timeUntil,
} from './app-instance-dialogs';
import { appCan, appKindLabel, appStatus } from './app-shared';

const root = resolve(import.meta.dir, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const t = Object.assign((key: string) => key, { raw: (key: string) => key }) as unknown as UiTranslator;

const instance = (overrides: Partial<AppInstance> = {}): AppInstance => ({
  status: 'running', url: 'https://api.example.test', site_url: 'https://site.example.test',
  dashboard_url: 'https://dash.example.test', error: null, operation: null, last_operation_error: null,
  health: null, auth_env: null, client_version: '1.0.0', budget_alert: null, purge_after: null,
  ...overrides,
});
const convexApp = (overrides: Partial<App> = {}): App => ({
  app_id: 'app-1', account_id: 'account-1', project_id: 'project-1', kind: 'convex', slug: 'db', name: 'DB',
  capabilities: ['deployments', 'snapshots', 'restore', 'admin_credentials', 'dashboard', 'logs', 'member_tokens'],
  url: 'https://api.example.test', access_mode: 'project', access_revision: 1, desired_state: 'running',
  active_deployment_id: null, machine: { cpu: 1, memory_gb: 1, disk_gb: 10 }, idle_timeout_seconds: 300,
  monthly_budget_usd: 5, last_request_at: null, instance: instance(),
  created_at: '2026-10-09T00:00:00.000Z', updated_at: '2026-10-09T00:00:00.000Z',
  ...overrides,
});

test('an App with its own machine reads its state from the machine, not the deployment pointer', () => {
  // Its deployments never move `active_deployment_id`: a running machine is live without one.
  expect(appStatus(convexApp(), t)).toMatchObject({ deployed: true, live: true, label: 'textf4ccae29e1bb' });
  expect(appStatus(convexApp({ instance: instance({ status: 'provisioning' }) }), t)).toMatchObject({
    live: false,
    label: 'textc2b1b8e2e039',
  });
  // An operation in flight wins over the machine state.
  expect(appStatus(convexApp({ instance: instance({ operation: 'resizing' }) }), t)).toMatchObject({
    live: false,
    label: 'text6f2769b24c0f',
  });
  const unhealthy = instance({
    health: { ok: false, checked_at: '', machine_state: null, failures: 2, error: 'timeout', disk_used_pct: null, repair: null },
  });
  expect(appStatus(convexApp({ instance: unhealthy }), t)).toMatchObject({ live: false, label: 'textd14f65e63358' });
  expect(appStatus(convexApp({ instance: instance({ status: 'error' }) }), t)).toMatchObject({ deployed: false, label: 'text54a0e8c17ebb' });
});

test('the UI branches on capabilities; only kind convex carries a kind badge', () => {
  expect(appCan(convexApp(), 'snapshots')).toBe(true);
  expect(appCan(convexApp(), 'preview')).toBe(false);
  expect(appCan(convexApp({ capabilities: undefined }), 'snapshots')).toBe(false);
  expect(appKindLabel(convexApp(), t)).toBe('text2fb4019a35e4');
  expect(appKindLabel(convexApp({ kind: 'web' }), t)).toBeNull();
});

test('the revealed admin credentials render as .env.local lines', () => {
  expect(
    credentialsEnvText({ CONVEX_SELF_HOSTED_URL: 'https://x', CONVEX_SELF_HOSTED_ADMIN_KEY: 'k' }),
  ).toBe('CONVEX_SELF_HOSTED_URL=https://x\nCONVEX_SELF_HOSTED_ADMIN_KEY=k');
});

test('one Apps page: no Backends tab, page, palette entry or flag remains in the web app', () => {
  const tabs = read('features/workspace/capabilities/shared/capability-tabs.tsx');
  const routes = read('features/workspace/capabilities/shared/capability-tab-routes.ts');
  const menu = read('lib/menu-registry.ts');
  const flags = read('lib/use-project-feature-flags.ts');
  const actions = read('lib/project-actions.ts');
  for (const source of [tabs, routes, menu, flags]) expect(source).not.toContain("'backends'");
  expect(actions).not.toContain('PROJECT_BACKEND');
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
  expect(detail).toContain("appCan(app, 'dashboard') ? (");
  expect(detail).toContain("appCan(app, 'admin_credentials') ? (");
  expect(detail).toContain("const holdsData = appCan(app, 'snapshots');");
  expect(detail).toContain("canAdmin && appCan(app, 'admin_credentials') ? (");
  expect(detail).toContain("canDeploy={canDeploy && appCan(app, 'rollback')}");
  expect(detail).toContain('{canDeploy && canSleep ? (');
  // An App without a preview never asks for an access session (the API answers 409).
  expect(detail).toContain('session: canAccess && preview');
  expect(view).toContain('session: canAccess && preview');
  expect(view).toContain('<InstanceTile projectId={projectId} app={app} />');
  // Uses / used-by links in the header.
  expect(detail).toContain('slugs={app.uses}');
  expect(detail).toContain('slugs={app.used_by}');
});

test('an App that holds data deletes only with project.app.admin and its slug typed back', () => {
  const detail = read('features/apps/app-detail.tsx');
  expect(detail).toContain('{(holdsData ? canAdmin : canWrite) ? (');
  expect(detail).toContain('confirmDisabled={holdsData && typedSlug !== app.slug}');
  expect(detail).toContain('holdsData ? { appId: app.app_id, confirm: typedSlug } : app.app_id');
});

test('the admin key is revealed only on an explicit, admin-gated click and never rendered by the dashboard', () => {
  const dialog = read('features/apps/app-connect.tsx');
  const dashboard = read('features/apps/app-dashboard.tsx');
  expect(dialog).toContain("from '@kortix/shared/app-connect'");
  expect(dialog).toContain('appConnectSnippets(app)');
  expect(dialog).toMatch(/const reveal = async \(\) => \{[\s\S]*getAppCredentials\(projectId, app\.app_id\)/);
  expect(dialog).toContain('onClick={() => void reveal()}');
  expect(dialog).toContain('{canAdmin ? (');
  // The dashboard key goes only to the dashboard's own origin.
  expect(dashboard).toContain('if (event.origin !== origin || event.source !== frame.current?.contentWindow) return;');
  expect(dashboard).toContain('if (!canAdmin) return');
  expect(dashboard).not.toContain('{credentials');
});

const current = { cpu: 2, memory_gb: 4, disk_gb: 20 };

test('size validation follows the API limits and the disk minimum is the current disk', () => {
  expect(sizeMin('disk_gb', current)).toBe(20);
  expect(sizeMin('disk_gb', { ...current, disk_gb: 5 })).toBe(10);
  expect(sizeFieldValid('cpu', '16', current)).toBe(true);
  expect(sizeFieldValid('cpu', '17', current)).toBe(false);
  expect(sizeFieldValid('cpu', '0', current)).toBe(false);
  expect(sizeFieldValid('memory_gb', '1.5', current)).toBe(false);
  expect(sizeFieldValid('memory_gb', '', current)).toBe(false);
  expect(sizeFieldValid('disk_gb', '19', current)).toBe(false);
  expect(sizeFieldValid('disk_gb', '100', current)).toBe(true);
  expect(sizeFieldValid('disk_gb', '101', current)).toBe(false);
});

test('a resize sends only the changed fields', () => {
  expect(sizeChanges(sizeDraft(current), current)).toEqual({});
  expect(sizeChanges({ cpu: '3', memory_gb: '4', disk_gb: '30' }, current)).toEqual({ cpu: 3, disk_gb: 30 });
});

test('backup sizes are human readable', () => {
  expect(formatBackupSize(null)).toBe('—');
  expect(formatBackupSize(512)).toBe('512 B');
  expect(formatBackupSize(1048576)).toBe('1.0 MB');
});

test('snapshot expiry reads as a future time; a passed expiry is null', () => {
  const now = Date.parse('2026-10-07T00:00:00.000Z');
  const at = (ms: number) => new Date(now + ms).toISOString();
  expect(timeUntil(at(-1), now)).toBeNull();
  expect(timeUntil(at(30 * 60_000), now)).toMatch(/30/);
  expect(timeUntil(at(24 * 3_600_000), now)).toMatch(/24/);
  expect(timeUntil(at(7 * 86_400_000), now)).toMatch(/7/);
});

test('only manual snapshots count against the limit', () => {
  expect(manualSnapshotCount([{ kind: 'manual' }, { kind: 'automatic' }, { kind: 'resize' }, { kind: 'final' }])).toBe(1);
});
