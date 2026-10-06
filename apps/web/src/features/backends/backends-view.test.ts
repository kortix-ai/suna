import { readFileSync } from '@/i18n/test-source';
import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { BACKEND_NAME_PATTERN, backendDeployCommand, backendEnvText } from './backends-view';

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

test('Backends discovery hides until the backends flag is on, and the page gates on it', () => {
  const nav = read('features/workspace/project-sidebar/footer/project-backends-nav.tsx');
  const view = read('features/backends/backends-view.tsx');
  const menu = read('lib/menu-registry.ts');
  const sidebar = read('features/workspace/project-sidebar/project-sidebar.tsx');
  expect(nav).toContain("useFeatureFlag(projectId, 'backends')");
  expect(nav).toContain('if (!backendsGate.enabled) return null;');
  expect(menu).toContain("requiresFlag: 'backends'");
  expect(view).toContain("useFeatureFlag(projectId, 'backends')");
  expect(view).toContain('<FeatureGateScreen');
  expect(sidebar.indexOf('<ProjectBackendsNavItem />')).toBeGreaterThan(sidebar.indexOf('<ProjectAppsNavItem />'));
});

test('write actions are gated and the admin key is never rendered', () => {
  const view = read('features/backends/backends-view.tsx');
  expect(view).toContain('PROJECT_ACTIONS.PROJECT_BACKEND_WRITE');
  expect(view).not.toContain('admin_key');
  expect(view).toContain('<ConfirmDialog');
});
