import { readFileSync } from '@/i18n/test-source';
import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { BACKEND_NAME_PATTERN, backendDeployCommand, backendEnvText } from './backends-view';
import { formatBackupSize, sizeChanges, sizeDraft, sizeFieldValid, sizeMin } from './backend-dialogs';

const root = resolve(import.meta.dir, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('backend names follow the API rule', () => {
  for (const ok of ['a', 'web-demo', 'a1-b2', `a${'b'.repeat(62)}`]) expect(BACKEND_NAME_PATTERN.test(ok)).toBe(true);
  for (const bad of ['', '1abc', '-a', 'A', 'a_b', 'a b', `a${'b'.repeat(63)}`])
    expect(BACKEND_NAME_PATTERN.test(bad)).toBe(false);
});

test('copy helpers produce the documented strings', () => {
  expect(backendDeployCommand('web-demo')).toBe('kortix backends deploy web-demo --dir backends/web-demo');
  expect(
    backendEnvText({ CONVEX_SELF_HOSTED_URL: 'https://x', CONVEX_SELF_HOSTED_ADMIN_KEY: 'k' }),
  ).toBe('CONVEX_SELF_HOSTED_URL=https://x\nCONVEX_SELF_HOSTED_ADMIN_KEY=k');
});

test('Backends is a flag-gated Customize tab, never a sidebar row, and the page gates on it', () => {
  const tabs = read('features/workspace/capabilities/shared/capability-tabs.tsx');
  const routes = read('features/workspace/capabilities/shared/capability-tab-routes.ts');
  const view = read('features/backends/backends-view.tsx');
  const menu = read('lib/menu-registry.ts');
  const sidebar = read('features/workspace/project-sidebar/project-sidebar.tsx');
  expect(tabs).toContain("useFeatureFlag(projectId, 'backends')");
  expect(routes).toContain("{ key: 'backends', label: 'Backends', flag: 'backends' }");
  expect(menu).toContain("requiresFlag: 'backends'");
  expect(menu).toContain("href: '/projects/{projectId}/customize/backends'");
  expect(sidebar).not.toContain('ProjectBackendsNavItem');
  expect(view).toContain("useFeatureFlag(projectId, 'backends')");
  expect(view).toContain('<FeatureGateScreen');
  expect(view).toContain('<CapabilityPageShell');
});

test('one click anywhere on a row opens the backend; its own controls do not', () => {
  const view = read('features/backends/backends-view.tsx');
  expect(view).toContain('onClick={openRow}');
  expect(view).toContain('const href = backendHref(projectId, backend.backend_id);');
  // The copy button and the menu (whose items render in a portal, and React
  // events bubble through portals) stop the click before the row sees it.
  expect(view).toContain('<TableCell onClick={own}>');
  expect(view).toContain('<span className="flex items-center gap-1" onClick={own}>');
});

test('write actions are gated and the admin key is never rendered', () => {
  const view = read('features/backends/backends-view.tsx');
  expect(view).toContain('PROJECT_ACTIONS.PROJECT_BACKEND_WRITE');
  expect(view).not.toContain('admin_key');
  expect(view).toContain('<ConfirmDialog');
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

test('Resize and Backups are row actions; resize and restore are write-gated; the size and operation show in the row', () => {
  const view = read('features/backends/backends-view.tsx');
  const dialogs = read('features/backends/backend-dialogs.tsx');
  expect(view).toContain('<ResizeBackendDialog');
  expect(view).toContain('<BackendBackupsDialog');
  expect(view).toContain('backendSizeLabel(backend, t)');
  expect(view).toContain('backend.last_operation_error');
  expect(view).toMatch(/canWrite \? \(\s*<DropdownMenuItem\s+disabled=\{backend\.status !== 'running' \|\| backend\.operation !== null\}\s+onClick=\{onResize\}/);
  expect(dialogs).toContain('{canWrite ? (');
  expect(dialogs).toContain('<ConfirmDialog');
  expect(dialogs).not.toContain('admin_key');
});
