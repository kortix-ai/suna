import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');

test('every Apps discovery surface hides until the apps feature flag is on', () => {
  const nav = readFileSync(
    resolve(root, 'features/workspace/project-sidebar/footer/project-apps-nav.tsx'),
    'utf8',
  );
  const menu = readFileSync(resolve(root, 'lib/menu-registry.ts'), 'utf8');
  const view = readFileSync(resolve(root, 'features/apps/apps-view.tsx'), 'utf8');

  // ONE gating primitive everywhere — the SDK's `useFeatureFlag`, never a
  // per-feature hook and never a hand-rolled `experimental?.apps` read.
  expect(nav).toContain("useFeatureFlag(projectId, 'apps')");
  expect(nav).toContain('if (!appsGate.enabled) return null;');
  expect(nav).toContain('Experimental');
  expect(menu).toContain("requiresFlag: 'apps'");
  expect(view).toContain("useFeatureFlag(projectId, 'apps')");
  expect(view).toContain('Experimental');
  expect(nav).not.toContain('useAppsFeatureEnabled');
  expect(view).not.toContain('useAppsFeatureEnabled');
});

test('the Apps page cannot enable Apps — activation lives only in Feature flags', () => {
  const view = readFileSync(resolve(root, 'features/apps/apps-view.tsx'), 'utf8');
  const gate = readFileSync(resolve(root, 'features/workspace/feature-gate-screen.tsx'), 'utf8');

  // A disabled feature never offers its own switch. The gate screen POINTS at
  // Customize → Feature flags; it does not mutate anything.
  expect(view).toContain('<FeatureGateScreen');
  expect(view).toContain('featureName="Apps"');
  expect(view).not.toContain('updateExperimentalFeature');
  expect(view).not.toContain('updateFeatureFlag');
  expect(view).not.toContain('Enable Apps');

  // The shared screen opens the one place a flag can be flipped. `main`
  // authored this against the Customize overlay (`openCustomize('feature-
  // flags')`); this branch deleted that overlay, so the same single control
  // is the settings panel's Experimental tab.
  expect(gate).toContain("openSettings('experimental')");
  expect(gate).not.toContain('useCustomizeStore');
  expect(gate).toContain('Feature flags');
  expect(gate).not.toContain('updateFeatureFlag');
  expect(gate).not.toContain('useMutation');
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
