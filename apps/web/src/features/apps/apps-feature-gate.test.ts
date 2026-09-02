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

  // The shared screen links to the one place a flag can be flipped: the
  // Settings overlay's Feature flags tab, through its deep-link route (the
  // config page that held it was retired on 2026-09-02). A real link, not a
  // store call.
  expect(gate).toContain('/settings/feature-flags');
  expect(gate).not.toContain('useCustomizeStore');
  expect(gate).not.toContain('useSettingsPanelStore');
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
  expect(view).toContain('max-w-7xl px-4');
});

test('the Apps header is the capability tab bar, not a settings masthead', () => {
  const view = readFileSync(resolve(root, 'features/apps/apps-view.tsx'), 'utf8');
  const tabs = readFileSync(
    resolve(root, 'features/workspace/capabilities/shared/capability-tabs.tsx'),
    'utf8',
  );

  // The exact bar contract, read off the file that owns it — if the tab row is
  // ever restyled this fails rather than letting Apps drift into a second
  // dialect of page chrome.
  const BAR = 'kx-titlebar-row relative flex shrink-0 items-center gap-1 border-b px-2';
  expect(tabs).toContain(BAR);
  expect(view).toContain(BAR);

  // `CustomizeSectionWrapper` is the settings-section shell: an 80px centred
  // masthead that scrolls away with the content. Apps is an operational grid
  // and owns a pinned bar instead.
  expect(view).not.toContain('CustomizeSectionWrapper');
  expect(view).not.toContain('showSidebarToggleButton');

  // One sidebar opener for every view — the shared `SidebarToggle`, in flow,
  // never a second copy absolutely positioned at top-2 left-2 over the macOS
  // traffic lights. The rule and the control are both pinned in
  // workspace/project-layout/sidebar-toggle.test.ts.
  expect(view).toContain('<SidebarToggle />');
  expect(view).not.toContain('sidebarOpenerLabel');
  expect(view).not.toContain('placement="floating"');
  expect(view).not.toContain('absolute top-2 left-2');

  // The bar pins only because this box has a definite height; every ancestor
  // is `min-h-*` or `flex-1 overflow-hidden`, so without it the window scrolls
  // and takes the bar with it.
  expect(view).toContain('flex h-svh flex-col overflow-hidden');
});

test('an App card shows the App, not a stock glyph standing in for it', () => {
  const view = readFileSync(resolve(root, 'features/apps/apps-view.tsx'), 'utf8');

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
  const view = readFileSync(resolve(root, 'features/apps/apps-view.tsx'), 'utf8');
  const card = view.slice(
    view.indexOf('function AppCard('),
    view.indexOf('function AppDetailModal('),
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

  const ROW =
    'group/menu-button text-muted-foreground hover:text-sidebar-foreground flex items-center gap-2 px-3 text-sm! font-medium [&_svg]:size-4!';
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
  expect(view).toContain(
    "data-testid={accessError ? 'app-preview-access-denied' : 'app-preview-loading'}",
  );
  expect(view).toContain('Preparing preview');
  expect(view).not.toContain('if (!app.active_deployment_id || !url)');
});

test('the App detail header is a title bar, not a debug readout', () => {
  const view = readFileSync(resolve(root, 'features/apps/apps-view.tsx'), 'utf8');
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
  const view = readFileSync(resolve(root, 'features/apps/apps-view.tsx'), 'utf8');
  const header = view.slice(view.indexOf('<header'), view.indexOf('</header>'));

  // Close used to be the fifth button INSIDE the group, which made "stop this
  // App" and "shut this panel" read as peers. It sits outside now, and it is
  // ghost rather than outline because it is chrome, not an action.
  const groupEndsAt = header.indexOf('</ButtonGroup>');
  const closeAt = header.indexOf('aria-label="Close"');
  expect(groupEndsAt).toBeGreaterThan(-1);
  expect(closeAt).toBeGreaterThan(groupEndsAt);
  expect(header.slice(groupEndsAt)).toContain('variant="ghost"');
});

test('Delete lives in the header menu, never buried in the version drawer', () => {
  const view = readFileSync(resolve(root, 'features/apps/apps-view.tsx'), 'utf8');
  const header = view.slice(view.indexOf('<header'), view.indexOf('</header>'));

  // A destructive action reachable only by first opening a history panel is an
  // action you find by looking for something else.
  expect(header).toContain('Delete App');
  expect(header).toContain('variant="destructive"');
  // …and it still goes through the confirm step.
  expect(view).toContain('<ConfirmDialog');
  expect(view).toContain('confirmVariant="destructive"');

  // The versions drawer keeps only the deploy command.
  const drawer = view.slice(view.indexOf('{versionsOpen ? ('));
  expect(drawer.slice(0, drawer.indexOf('DeploymentRow'))).not.toContain('Delete App');
});

test('internal infrastructure names are not shown to App owners', () => {
  const view = readFileSync(resolve(root, 'features/apps/apps-view.tsx'), 'utf8');

  // `hosting_provider` is the sandbox fleet a build landed on ("daytona",
  // "platinum") — something the reader neither chose nor can change. It was
  // printed on every version row where the age should have been.
  expect(view).not.toContain('deployment.hosting_provider');
  expect(view).toContain('relativeTime(deployment.created_at)');
});

test('the Apps grid is a gallery: bordered thumbnails, captions hanging below', () => {
  const view = readFileSync(resolve(root, 'features/apps/apps-view.tsx'), 'utf8');
  const card = view.slice(
    view.indexOf('function AppCard('),
    view.indexOf('function AppDetailModal('),
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
    view.indexOf('function AppsHeader('),
    view.indexOf('export function AppsView('),
  );
  expect(header).toContain('showColumns');
  expect(header).toContain('{showColumns ? (');

  // The gallery column is also the grid's measuring box. A `@lg/apps:` variant
  // with no `@container/apps` ancestor compiles and then never matches, so the
  // grid would silently stay one column forever.
  // `px-4 md:px-8` — the gutter is the one thing here that may key off the
  // VIEWPORT rather than the container: it is this element's own padding, and
  // this element IS `@container/apps`, so it cannot query itself. The column
  // ladder inside it stays container-based.
  expect(view).toContain('max-w-7xl flex-col px-4 md:px-8 py-6 pb-20');
  expect(view).not.toContain('max-w-5xl flex-col');
  expect(view).toContain('APP_GRID_CONTAINER,');
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
