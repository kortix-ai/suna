import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');

test('every Apps discovery surface hides until the apps feature flag is on', () => {
  // Apps lost its standalone sidebar row when Customize became a rail. It is a
  // Customize pane now, so the rail row IS the discovery surface and
  // `settings-panel.tsx` is where it is gated.
  const panel = readFileSync(
    resolve(root, 'features/workspace/settings/settings-panel.tsx'),
    'utf8',
  );
  const rail = readFileSync(resolve(root, 'features/workspace/settings/rail.ts'), 'utf8');
  const menu = readFileSync(resolve(root, 'lib/menu-registry.ts'), 'utf8');
  const view = readFileSync(resolve(root, 'features/apps/apps-view.tsx'), 'utf8');

  // Fail-closed, and gated exactly like the panel's three other flag-gated
  // rows (marketplace, voice, review) — off the project detail the panel has
  // already resolved, which is the same `qk.project.detail` entry the SDK's
  // `useFeatureFlag` reads.
  expect(panel).toContain('const appsEnabled = project?.experimental?.apps ?? false;');
  expect(rail).toContain('...(flags.appsEnabled ? [APPS_ITEM] : [])');

  // ONE gate, not two. The registry's `proj-apps` row (its own `requiresFlag`)
  // duplicated the derived rail row, so the palette listed Apps twice and the
  // two entries could disagree about whether the flag was on.
  expect(menu).not.toContain("id: 'proj-apps'");

  // ONE gating primitive on the page itself — the SDK's `useFeatureFlag`,
  // never a per-feature hook.
  expect(view).toContain("useFeatureFlag(projectId, 'apps')");
  expect(view).not.toContain('useAppsFeatureEnabled');
});

test('Apps is an ordinary feature flag — nothing calls it experimental', () => {
  // Apps shipped labelled Experimental on every surface. It is now a STABLE
  // flag: still opt-in per project, but no badge on its rail row and none on
  // the page header. The stability badge in Settings → Feature flags is
  // rendered from the registry's `stability`, so that list follows on its own.
  const rail = readFileSync(resolve(root, 'features/workspace/settings/rail.ts'), 'utf8');
  const view = readFileSync(resolve(root, 'features/apps/apps-view.tsx'), 'utf8');

  expect(rail.slice(rail.indexOf('const APPS_ITEM'), rail.indexOf('const CHANNELS_ITEM'))).not.toContain(
    'Experimental',
  );
  expect(view).not.toContain('Experimental');
});

test('Apps sits with Customize — inside it, on the Reach row', () => {
  const rail = readFileSync(resolve(root, 'features/workspace/settings/rail.ts'), 'utf8');

  // It used to be its own sidebar row placed directly under Customize, for the
  // reason that survives the move: it is a project surface you configure and
  // operate. Customize is a rail now, so "with Customize" means a row IN it —
  // under Reach, beside Connectors and Channels, because an App is one more
  // way the outside world reaches this project.
  const reach = rail.slice(rail.indexOf("label: 'Reach'"), rail.indexOf("label: 'Automate'"));
  expect(reach).toContain('APPS_ITEM');
  expect(reach).toContain('CONNECTORS_ITEM');
  expect(reach).toContain('CHANNELS_ITEM');
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

test('an App with no deployment never claims to be Running', () => {
  // `desired_state` defaults to 'running' when the App row is created, so
  // reading the badge off it alone painted a green "Running" pill on an App
  // that had never been deployed and had no runtime at all.
  const view = readFileSync(resolve(root, 'features/apps/apps-view.tsx'), 'utf8');

  expect(view).toContain('const deployed = Boolean(app.active_deployment_id);');
  expect(view).toContain("const live = deployed && app.desired_state === 'running';");
  expect(view).toContain("!deployed ? 'Not deployed'");
  // The badge and its tint must both follow real state, not intent.
  expect(view).not.toContain("variant={app.desired_state === 'running' ? 'success' : 'muted'}");
  expect(view).not.toContain("{app.desired_state === 'running' ? 'Running' : 'Suspended'}");
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
