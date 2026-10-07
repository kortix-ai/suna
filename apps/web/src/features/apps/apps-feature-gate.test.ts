import { readFileSync } from '@/i18n/test-source';
import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');

// Structural assertions follow the owning modules after extraction.
const appsSource = () => ['apps-view', 'app-detail', 'app-shared', 'app-preview', 'app-density', 'app-access']
  .map((name) => readFileSync(resolve(root, `features/apps/${name}.tsx`), 'utf8'))
  .join('\n');

test('every Apps discovery surface hides until the apps feature flag is on', () => {
  const tabs = readFileSync(
    resolve(root, 'features/workspace/capabilities/shared/capability-tabs.tsx'),
    'utf8',
  );
  const routes = readFileSync(
    resolve(root, 'features/workspace/capabilities/shared/capability-tab-routes.ts'),
    'utf8',
  );
  const menu = readFileSync(resolve(root, 'lib/menu-registry.ts'), 'utf8');
  const view = appsSource();

  // ONE gating primitive everywhere — the SDK's `useFeatureFlag`, never a
  // per-feature hook and never a hand-rolled `experimental?.apps` read.
  expect(tabs).toContain("useFeatureFlag(projectId, 'apps')");
  expect(tabs).toContain('FLAGGED_CAPABILITY_TABS.filter((tab) => enabled[tab.flag])');
  expect(routes).toContain("{ key: 'apps', label: 'Apps', flag: 'apps' }");
  expect(menu).toContain("requiresFlag: 'apps'");
  expect(view).toContain("useFeatureFlag(projectId, 'apps')");
  expect(view).not.toContain('useAppsFeatureEnabled');
});

test('Apps is an ordinary feature flag — nothing calls it experimental', () => {
  expect(appsSource()).not.toContain('Experimental');
});

test('Apps is a Customize tab, not a sidebar row (Marko, 2026-10-07)', () => {
  const sidebar = readFileSync(
    resolve(root, 'features/workspace/project-sidebar/project-sidebar.tsx'),
    'utf8',
  );
  const menu = readFileSync(resolve(root, 'lib/menu-registry.ts'), 'utf8');
  expect(sidebar).not.toContain('ProjectAppsNavItem');
  expect(menu).toContain("href: '/projects/{projectId}/customize/apps'");
  // The retired route still resolves, carrying `?open_app=` deep links along.
  const retired = readFileSync(resolve(root, 'app/[locale]/(app)/projects/[id]/apps/page.tsx'), 'utf8');
  expect(retired).toContain("redirect(withSearch(capabilityTabHref(id, 'apps'), await searchParams))");
});

test('the Apps page cannot enable Apps — activation lives only in Feature flags', () => {
  const view = appsSource();
  const gate = readFileSync(resolve(root, 'features/workspace/feature-gate-screen.tsx'), 'utf8');

  // A disabled feature never offers its own switch. The gate screen POINTS at
  // Customize → Feature flags; it does not mutate anything.
  expect(view).toContain('<FeatureGateScreen');
  expect(view).toContain('featureName="Apps"');
  expect(view).not.toContain('updateExperimentalFeature');
  expect(view).not.toContain('updateFeatureFlag');
  expect(view).not.toContain('Enable Apps');

  // The shared screen links to the one place a flag can be flipped: the
  // Customize bar's Settings tab, Feature flags section — through the shared
  // href builder, so the route can move without this link going stale. A
  // real link, not a store call.
  expect(gate).toContain("projectSettingsSectionHref(projectId, 'feature-flags')");
  expect(gate).not.toContain('useCustomizeStore');
  expect(gate).not.toContain('useSettingsPanelStore');
  expect(gate).toContain('Feature flags');
  expect(gate).not.toContain('updateFeatureFlag');
  expect(gate).not.toContain('useMutation');
});

test('Apps UI is operational only and has no creation action or modal', () => {
  const view = appsSource();

  expect(view).not.toContain('CreateAppModal');
  expect(view).not.toContain('New App');
  expect(view).not.toContain('Create App');
  expect(view).toContain('kortix apps deploy .');
  expect(view).toContain('<iframe');
  expect(view).toContain('<CapabilityPageShell\n        wide');
});

test('the Apps header is the Customize bar plus the shared page shell', () => {
  const view = appsSource();
  // The bar above is the Customize tab bar; the page draws no bar of its own
  // and no second sidebar opener.
  expect(view).not.toContain('<ProjectPageHeader');
  expect(view).not.toContain('CustomizeSectionWrapper');
  expect(view).not.toContain('<SidebarToggle');
  expect(view).not.toContain('absolute top-2 left-2');
  // One heading, one header group, one scroll container: the same shell every
  // Customize tab uses, in its wide column.
  expect(view).toContain('<CapabilityPageShell');
  expect(view).not.toContain('h-svh');
});

test('an App card shows the App, not a stock glyph standing in for it', () => {
  const view = appsSource();

  // The card led with a size-9 tinted globe tile directly under a live
  // thumbnail of the App itself. Same glyph on every card, zero information,
  // and the identity it stood in for was already rendered above it.
  expect(view).not.toContain('bg-kortix-green/15');
  // The tile's own box, not the glyph inside it. A file-wide ban on
  // `weight="fill"` also caught the header's sleep/wake PauseIcon, which is
  // filled because that is what a media control looks like — an unrelated
  // control failing a card assertion is the assertion being wrong, not the UI.
  expect(view).not.toContain('size-9');
  // Status is the house dot.
  expect(view).toContain("dot: live ? 'bg-kortix-green'");
});

test("a card caption is the App's name and its state — not its hostname", () => {
  const view = appsSource();
  const card = view.slice(
    view.indexOf('function AppCard('),
    view.indexOf("\n'use client';", view.indexOf('function AppCard(')),
  );

  // Every App's URL is the same `<key>.apps.<domain>` shape, so a column of
  // them differs only in a random token nobody reads or types — a third of the
  // caption's height spent on noise, on the surface whose job is to show the
  // App. Neither the derived host nor the raw URL belongs on a tile.
  expect(card).not.toContain('appHost(');
  expect(card).not.toContain('{app.url}');
  expect(card).not.toContain('font-mono');

  // The caption is ONE row now, not a stack — a leftover `space-y` wrapper
  // would keep reserving the line the host used to occupy.
  expect(card).toContain('className="mt-3 flex items-center gap-2"');
  expect(card).not.toContain('mt-3 space-y-1');

  // …and the skeleton loses its second bar with it, or the grid shifts the
  // moment real data lands.
  const skeleton = view.slice(view.indexOf('function AppGridSkeleton('));
  expect(skeleton.slice(0, skeleton.indexOf('\n}'))).not.toContain('space-y-1');

  // The URL is not gone from the product — the detail layer still names it on
  // the control that opens the App.
  expect(view).toContain('appHost(app.url)');
});

test('an App with no deployment never claims to be Running', () => {
  // `desired_state` defaults to 'running' when the App row is created, so
  // reading the badge off it alone painted a green "Running" pill on an App
  // that had never been deployed and had no runtime at all.
  const view = appsSource();

  expect(view).toContain('const deployed = Boolean(app.active_deployment_id);');
  expect(view).toContain("const live = deployed && app.desired_state === 'running';");
  expect(view).toContain("!deployed ? 'Not deployed'");
  // The badge and its tint must both follow real state, not intent.
  expect(view).not.toContain("variant={app.desired_state === 'running' ? 'success' : 'muted'}");
  expect(view).not.toContain("{app.desired_state === 'running' ? 'Running' : 'Suspended'}");
});

test('a suspended App preview issues the request that wakes its active deployment', () => {
  const view = appsSource();

  expect(view).toContain('if (!app.active_deployment_id)');
  expect(view).toContain('if (!url)');
  expect(view).toContain('src={url}');
  expect(view).toContain('data-testid="app-live-preview"');
  expect(view).not.toContain("app.desired_state === 'stopped'");
  expect(view).not.toContain('Suspended. Open the App or use Wake App to resume it.');
});

test('an active App never looks undeployed while its signed preview URL loads', () => {
  const view = appsSource();

  expect(view).toContain('if (!app.active_deployment_id)');
  expect(view).toContain(
    "data-testid={accessError ? 'app-preview-access-denied' : 'app-preview-loading'}",
  );
  expect(view).toContain("raw('text2158038765cc')");
  expect(view).not.toContain('if (!app.active_deployment_id || !url)');
});

test('the App detail header is a title bar, not a debug readout', () => {
  const view = appsSource();
  const header = view.slice(view.indexOf('<header'), view.indexOf('</header>'));

  // It carried five competing things. What must NOT be back:
  // the raw pipeline stage printed verbatim…
  expect(header).not.toContain('{latest.status}');
  // …a floating access-mode badge (the mode belongs on the control that
  // changes it, where it reads as a current value)…
  expect(header).not.toContain('<Badge size="xs" variant="outline">');
  // …and the hostname in monospace under the name.
  expect(header).not.toContain('font-mono');
  expect(header).not.toContain('{appHost(app.url)}</p>');

  // The status WORD appears only when it is not the happy path — the green dot
  // already says "Running", and a permanent label restating it is noise.
  expect(header).toContain('{status.live ? (');
  // The dot is aria-hidden, so the state is still announced — exactly once,
  // as sr-only when running and as the visible label when it is not.
  expect(header).toContain('<span className="sr-only">{status.label}</span>');
  expect(header.match(/\{status\.label\}/g)).toHaveLength(2);
});

test("the header separates the App's actions from the window's Close", () => {
  const view = appsSource();
  const header = view.slice(view.indexOf('<header'), view.indexOf('</header>'));

  // Close used to be the fifth button INSIDE the group, which made "stop this
  // App" and "shut this panel" read as peers. It sits outside now, and it is
  // ghost rather than outline because it is chrome, not an action.
  const groupEndsAt = header.indexOf('</ButtonGroup>');
  const closeAt = header.indexOf('text7d9eb7acb13e');
  expect(groupEndsAt).toBeGreaterThan(-1);
  expect(closeAt).toBeGreaterThan(groupEndsAt);
  expect(header.slice(groupEndsAt)).toContain('variant="ghost"');
});

test('Delete lives in the header menu, never buried in the version drawer', () => {
  const view = appsSource();
  const header = view.slice(view.indexOf('<header'), view.indexOf('</header>'));

  // A destructive action reachable only by first opening a history panel is an
  // action you find by looking for something else.
  expect(header).toContain("raw('textd1b0a6e3985a')");
  expect(header).toContain('variant="destructive"');
  // …and it still goes through the confirm step.
  expect(view).toContain('<ConfirmDialog');
  expect(view).toContain('confirmVariant="destructive"');

  // The versions drawer keeps only the deploy command.
  const drawer = view.slice(view.indexOf('{versionsOpen ? ('));
  expect(drawer.slice(0, drawer.indexOf('DeploymentRow'))).not.toContain('Delete App');
});

test('internal infrastructure names are not shown to App owners', () => {
  const view = appsSource();

  // `hosting_provider` is the sandbox fleet a build landed on ("daytona",
  // "platinum") — something the reader neither chose nor can change. It was
  // printed on every version row where the age should have been.
  expect(view).not.toContain('deployment.hosting_provider');
  expect(view).toContain('relativeTime(deployment.created_at)');
});

test('the Apps grid is a gallery: bordered thumbnails, captions hanging below', () => {
  const view = appsSource();
  const card = view.slice(
    view.indexOf('function AppCard('),
    view.indexOf("\n'use client';", view.indexOf('function AppCard(')),
  );

  // The grid and the skeleton read the SAME chosen ladder, so nothing reflows
  // when data lands under a non-default choice. The skeleton takes it as a
  // prop; the grid reads the state directly.
  expect(view).toContain("cn('grid gap-6', APP_GRID_COLUMN_OPTIONS[gridColumns].grid)");
  expect(view).toContain("cn('grid gap-6', APP_GRID_COLUMN_OPTIONS[columns].grid)");
  expect(view).toContain('<AppGridSkeleton columns={gridColumns} />');
  // The 3-or-4 control is back (2026-08-31) after a three-way density picker
  // was removed. The thing that made the old one wrong was three options and no
  // sane default, so what has to hold is the DEFAULT, not the absence.
  expect(view).toContain('export const APP_GRID_DEFAULT_COLUMNS: AppGridColumns = 3;');
  expect(view).not.toContain('AppGridDensity');
  // A picker over the feature gate, the error state or the empty state is a
  // dead switch, so the header takes an explicit flag rather than always
  // rendering it.
  const header = view.slice(
    view.indexOf('function AppsActions('),
    view.indexOf('export function AppsView('),
  );
  expect(header).toContain('showColumns');
  expect(header).toContain('{showColumns ? <AppGridColumnsControl');

  // The gallery column is also the grid's measuring box. A `@lg/apps:` variant
  // with no `@container/apps` ancestor compiles and then never matches, so the
  // grid would silently stay one column forever. The gutter is the shell's
  // padding, outside the container, so the ladder stays container-based.
  // The column is the shell's WIDE one (max-w-7xl, md:px-8): a 5xl column
  // made four-across tiles 230px (e56c580271, reverted by e6c4ba0b62).
  const shell = readFileSync(
    resolve(root, 'features/workspace/capabilities/shared/capability-page-shell.tsx'),
    'utf8',
  );
  expect(view).toContain('<CapabilityPageShell\n        wide');
  expect(shell).toContain("'mx-auto w-full max-w-7xl space-y-5 px-4 py-10 pb-20 md:px-8 lg:py-14'");
  expect(view).toContain("cn('flex min-h-full flex-col', APP_GRID_CONTAINER)");
  expect(view).toContain("export const APP_GRID_CONTAINER = '@container/apps';");

  // The thumbnail is the only bordered surface; the caption is page text under
  // it, not the inside of a panel. The old card was one `bg-popover` panel with
  // the text inside it under a divider.
  expect(card).toContain('relative overflow-hidden rounded-lg border');
  expect(card).not.toContain('bg-popover');
  expect(card).not.toContain('border-b');
  expect(card).toContain('className="mt-3 flex items-center gap-2"');

  // Still exactly one control per card — a hover overflow button inside the
  // card button would be invalid HTML and a nested hit area.
  expect(card.match(/<button/g)).toHaveLength(1);
  expect(card).not.toContain('DropdownMenu');
});
