import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');

test('every Apps discovery surface hides until the project enables the apps experiment', () => {
  const nav = readFileSync(
    resolve(root, 'features/workspace/project-sidebar/footer/project-apps-nav.tsx'),
    'utf8',
  );
  const menu = readFileSync(resolve(root, 'lib/menu-registry.ts'), 'utf8');
  const view = readFileSync(resolve(root, 'features/apps/apps-view.tsx'), 'utf8');

  expect(nav).toContain('useAppsFeatureEnabled');
  expect(nav).toContain('if (!appsGate.enabled) return null;');
  expect(nav).toContain('Experimental');
  expect(menu).toContain("requiresExperimental: 'apps'");
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
  expect(view).toContain('className="max-w-5xl"');
});

test('a suspended App preview issues the request that wakes its active deployment', () => {
  const view = readFileSync(resolve(root, 'features/apps/apps-view.tsx'), 'utf8');

  expect(view).toContain('if (!app.active_deployment_id)');
  expect(view).toContain('if (!url)');
  expect(view).toContain('src={url}');
  expect(view).toContain('data-testid="app-live-preview"');
  expect(view).not.toContain("app.desired_state === 'stopped'");
  expect(view).not.toContain('Suspended. Open the App or use Wake App to resume it.');
});

test('an active App never looks undeployed while its signed preview URL loads', () => {
  const view = readFileSync(resolve(root, 'features/apps/apps-view.tsx'), 'utf8');

  expect(view).toContain('if (!app.active_deployment_id)');
  expect(view).toContain("data-testid={accessError ? 'app-preview-access-denied' : 'app-preview-loading'}");
  expect(view).toContain('Preparing preview');
  expect(view).not.toContain('if (!app.active_deployment_id || !url)');
});
