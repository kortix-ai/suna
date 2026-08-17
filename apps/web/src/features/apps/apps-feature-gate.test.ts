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
  expect(menu).toContain("requiresFlag: 'apps'");
  expect(view).toContain("useFeatureFlag(projectId, 'apps')");
  expect(nav).not.toContain('useAppsFeatureEnabled');
  expect(view).not.toContain('useAppsFeatureEnabled');
});

test('Apps is an ordinary feature flag — nothing calls it experimental', () => {
  // Apps shipped labelled Experimental on every surface. It is now a STABLE
  // flag: still opt-in per project, but no badge on the sidebar entry and none
  // on the page header. The stability badge in Settings → Feature flags is
  // rendered from the registry's `stability`, so that list follows on its own.
  const nav = readFileSync(
    resolve(root, 'features/workspace/project-sidebar/footer/project-apps-nav.tsx'),
    'utf8',
  );
  const view = readFileSync(resolve(root, 'features/apps/apps-view.tsx'), 'utf8');

  expect(nav).not.toContain('Experimental');
  expect(view).not.toContain('Experimental');
});

test('Apps sits with Customize in the sidebar, not in the bottom alert group', () => {
  const sidebar = readFileSync(
    resolve(root, 'features/workspace/project-sidebar/project-sidebar.tsx'),
    'utf8',
  );

  // It is a project surface you configure and operate, so it belongs on the
  // Customize row — not below Files among the bottom-anchored alerts, which
  // shift as late-arriving billing and sandbox state lands.
  const customizeAt = sidebar.indexOf('<ProjectCustomizeNavItem />');
  const appsAt = sidebar.indexOf('<ProjectAppsNavItem />');
  const filesAt = sidebar.indexOf('<ProjectFilesNavItem />');
  expect(customizeAt).toBeGreaterThan(-1);
  expect(appsAt).toBeGreaterThan(customizeAt);
  expect(appsAt).toBeLessThan(filesAt);
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
  expect(view).toContain('className="max-w-5xl px-4"');
});

test('the Apps row matches the row contract of the group it sits in', () => {
  // The sidebar has TWO row conventions. The top group (New session, Customize)
  // pads with px-3 and rests muted; the bottom group (Files, Settings) does
  // neither. Apps moved from the bottom group to the top one and kept the old
  // class list, so its icon and label sat ~8px left of its neighbours and read a
  // shade darker — visibly out of line.
  const apps = readFileSync(
    resolve(root, 'features/workspace/project-sidebar/footer/project-apps-nav.tsx'),
    'utf8',
  );
  const customize = readFileSync(
    resolve(root, 'features/workspace/project-sidebar/project-settings-nav.tsx'),
    'utf8',
  );

  const ROW = 'group/menu-button text-muted-foreground hover:text-sidebar-foreground flex items-center gap-2 px-3 text-sm! font-medium [&_svg]:size-4!';
  // The same string the sibling rows in this group use — if that contract is
  // ever restyled, this fails rather than letting Apps silently drift out.
  expect(customize).toContain(ROW);
  expect(apps).toContain(ROW);
  // The glyph keeps its box on a narrow sidebar, like its neighbours.
  expect(apps).toContain('<span className="shrink-0">');
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
