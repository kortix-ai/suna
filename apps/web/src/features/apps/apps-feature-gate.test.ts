import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');

test('Apps stays discoverable while execution remains behind the project experimental gate', () => {
  const nav = readFileSync(
    resolve(root, 'features/workspace/project-sidebar/footer/project-apps-nav.tsx'),
    'utf8',
  );
  const menu = readFileSync(resolve(root, 'lib/menu-registry.ts'), 'utf8');
  const view = readFileSync(resolve(root, 'features/apps/apps-view.tsx'), 'utf8');

  expect(nav).not.toContain('useAppsFeatureEnabled');
  expect(nav).toContain('Experimental');
  expect(menu).not.toContain("requiresExperimental: 'apps'");
  expect(view).toContain('useAppsFeatureEnabled');
  expect(view).toContain("updateExperimentalFeature(projectId, 'apps', true)");
  expect(view).toContain('Enable Apps');
  expect(view).toContain('Experimental');
});

test('Apps UI is operational only and has no creation action or modal', () => {
  const view = readFileSync(resolve(root, 'features/apps/apps-view.tsx'), 'utf8');

  expect(view).not.toContain('CreateAppModal');
  expect(view).not.toContain('New App');
  expect(view).not.toContain('Create App');
  expect(view).toContain('kortix apps deploy .');
  expect(view).toContain('<iframe');
});
