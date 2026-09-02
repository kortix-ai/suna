import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { Modal } from '@/components/ui/modal';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';
import { railGroups } from './rail';
import {
  ACCOUNT_SCOPED_SETTINGS_TABS,
  buildSettingsPanelSettingsNav,
  isSettingsTabAllowed,
  probeAdmits,
  SettingsPanelShell,
  type SettingsPanelShellProps,
  type SettingsTabAllowedParams,
} from './settings-panel';
import { DEFAULT_SETTINGS_TAB, SETTINGS_TABS } from './settings-tabs';
import type { RailItem } from './type';

/**
 * `SettingsPanelShell` is the innermost presentational layer — no hooks, no
 * `useQuery`, no Zustand store read, AND no `Modal`/`ModalContent` (see the
 * split in `settings-panel.tsx`). `SettingsPanel` calls `useQuery` /
 * `useSettingsPanelStore`; `SettingsPanelView` wraps the shell in `Modal`,
 * whose `ModalContent` renders through `DialogPrimitive.Portal` — that gates
 * on a `mounted` flag flipped by `useLayoutEffect`, which never runs during
 * static rendering, so a `Modal`-wrapped tree always renders as nothing under
 * `renderToStaticMarkup`, independent of `open`. Neither `SettingsPanel` nor
 * `SettingsPanelView` can be exercised this way; both are covered for real
 * once the panel is mounted, via the Playwright harness.
 *
 * **The overlay is three tabs now.** Twenty-one rows left it: eight
 * account-scoped ones for `/accounts/[id]`, and thirteen project-scoped ones
 * for the Customize bar's Settings tab, `/projects/[id]/config`. What remains
 * is Profile, Preferences and Connected accounts — the tabs that belong to the
 * signed-in PERSON. Every assertion below is derived from `railGroups()` or
 * `SETTINGS_TABS` rather than hard-coded counts, so the next arrival or
 * departure needs no edit here.
 */

const allGroups = railGroups();
const allItems: readonly RailItem[] = allGroups.flatMap((g) => g.items);

/**
 * A tab id no rail row carries, so `SettingsTabPane`'s `active` check is false
 * for every pane and none of them mounts.
 *
 * It is the default for the chrome tests below, and it has to be: all three
 * surviving tabs mount a real, query-backed view, and this file provides no
 * `QueryClientProvider`. That is not a workaround — it is the same signal the
 * gating suite uses. A chrome test that renders with `NO_TAB` and does NOT
 * throw is proof that no pane mounted; a gating test that names a real tab and
 * DOES throw is proof that exactly that one did.
 */
const NO_TAB = 'no-active-tab' as never;

function baseProps(overrides: Partial<SettingsPanelShellProps> = {}): SettingsPanelShellProps {
  return {
    tab: NO_TAB,
    onTabChange: () => {},
    isMobile: false,
    // Undefined by default, matching the overlay opened outside a project. The
    // `workspace` pane is the only one that reads it, and the gating suite
    // below supplies one where it needs the pane to mount.
    projectId: undefined,
    accountId: undefined,
    groups: allGroups,
    allItems,
    ...overrides,
  };
}

/**
 * `SettingsPanelShell` renders a `ModalClose` (the rail's close button)
 * directly, which needs Dialog context — real in
 * production since `SettingsPanelView` always nests the shell inside
 * `Modal`. `Modal` itself (`DialogPrimitive.Root`) renders its children
 * directly with no portal involved — only `Portal`/`ModalContent` gate on the
 * `useLayoutEffect`-driven `mounted` flag — so wrapping in a bare, contentless
 * `Modal` here supplies that context without hitting the portal problem.
 */
function render(overrides: Partial<SettingsPanelShellProps> = {}): string {
  return renderToStaticMarkup(
    <Modal open onOpenChange={() => {}}>
      <SettingsPanelShell {...baseProps(overrides)} />
    </Modal>,
  );
}

describe('SettingsPanelShell — desktop rail', () => {
  test('renders one trigger per rail row', () => {
    const html = render();
    expect((html.match(/role="tab"/g) ?? []).length).toBe(allItems.length);
  });

  test('renders one TabsList per rail group — Radix cannot mix a group Label into one shared list', () => {
    const html = render();
    // One list per group, and no pinned extra: the Upgrades footer went to
    // `/projects/[id]/config` with the rest of project configuration.
    expect((html.match(/role="tablist"/g) ?? []).length).toBe(allGroups.length);
  });

  /**
   * The rail is a flat list of three rows now, so it renders no group heading.
   *
   * A heading over the ONLY group labels nothing — every row is under it, and
   * the dialog is already called Settings. The rule is "more than one group",
   * not "never", so the heading returns with a second group rather than being
   * deleted outright; both halves are pinned below because only the first is
   * observable against today's rail.
   */
  describe('group headings', () => {
    // Explicitly ONE group, not `allGroups` — the production rail carries two
    // now (`Workspace` + `You`), and the behaviour under test is the shell's
    // `groups.length > 1` rule, not today's rail contents. Taking the first
    // group keeps this pinned on the rule even as the rail changes.
    test('one group renders no heading', () => {
      const oneGroup = [allGroups[0]];
      const html = render({ groups: oneGroup });
      expect(html).not.toContain(`>${oneGroup[0].label}<`);
    });

    // This is the live case now: the overlay opened inside a project shows
    // `Workspace` and `You`, so both headings have to paint.
    test('a second group brings every heading back', () => {
      const html = render({ groups: allGroups });
      expect(allGroups.length).toBeGreaterThan(1);
      for (const group of allGroups) {
        expect(html).toContain(`>${group.label}<`);
      }
    });
  });

  /**
   * The rail's "Search settings" field is gone with the full-screen shell.
   *
   * It filtered three rows that are all visible at once, in a 13rem rail — the
   * field was written when the rail was 28 rows across four groups. The search
   * that remains is the command palette's, derived from these same groups
   * (`settings-palette-items.ts`) and reachable without opening the dialog.
   * `filterRailGroups` / `railItemMatches` were deleted with it, so this is
   * pinned here rather than left to the absent test file.
   */
  test('the rail carries no search field', () => {
    const html = render();
    expect(html).not.toContain('data-slot="input-group-search"');
    expect(html).not.toContain('aria-label="Search settings"');
    expect(html).not.toContain('No settings match');
  });

  /**
   * The rail's exit is the `Back to app` row the account settings sidebar
   * leads with (`accounts/hub/account-settings-sidebar.tsx`), so the overlay
   * and `/accounts/**` read as one surface. It is a `ModalClose`: the app is
   * what the dialog was covering.
   */
  test('the desktop rail leads with a Back to app row that closes the dialog', () => {
    const html = render();
    expect(html).toContain('Back to app');
    expect(html).not.toContain('Back to workspace');
  });

  test('the desktop content column carries a Settings breadcrumb bar', () => {
    expect(render()).toContain('aria-label="breadcrumb"');
    expect(render({ isMobile: true })).not.toContain('aria-label="breadcrumb"');
  });
});

/**
 * The dialog frame: full screen.
 *
 * `SettingsPanelView` renders through `ModalContent` -> `DialogPrimitive.Portal`,
 * which never mounts under `renderToStaticMarkup` (see this file's header), so
 * the frame's classes are unreachable from the DOM here and are asserted
 * against the source — the same technique `settings-panel-a11y.test.ts` uses
 * for `activationMode`.
 *
 * It is the account settings shell as an edge-to-edge overlay (Jay,
 * 2026-09-02): `side="fullscreen"` plus the important-marked overrides the
 * Apps modal uses, because `ModalContent` appends `rounded-xl` AFTER
 * `className` and `ModalVariants` centres and caps the dialog at `lg:` — a
 * plain `rounded-none` or `max-w-none` loses to both.
 */
describe('SettingsPanelView — the dialog frame', () => {
  const SOURCE = readFileSync(join(import.meta.dir, 'settings-panel.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  test('takes the fullscreen side', () => {
    expect(SOURCE).toContain('side="fullscreen"');
  });

  test('fills the viewport with important-marked overrides, not plain classes the modal chrome outranks', () => {
    for (const cls of ['inset-0!', 'h-dvh!', 'max-w-none!', 'rounded-none!', 'border-0!']) {
      expect(SOURCE).toContain(cls);
    }
  });

  test('never goes back to a capped, centred dialog', () => {
    for (const capped of ['lg:max-w-4xl', 'lg:max-w-6xl', 'lg:h-[min(']) {
      expect(SOURCE).not.toContain(capped);
    }
  });

  test("the desktop rail is the account shell's sidebar column, from the shell's one constant", () => {
    expect(SOURCE).toContain('SETTINGS_SIDEBAR_WIDTH_PX');
    expect(SOURCE).not.toContain('grid-cols-[250px_1fr]');
  });
});

/**
 * Radix's `TabsContent` keeps a `<div role="tabpanel">` in the tree for
 * EVERY value, not just the active one — internally it always calls
 * `Presence` with a function-as-children (`{present} => ...`), and Presence
 * treats a function child as an automatic `forceMount`. Inactive panes are
 * marked `hidden` (and their own children are stripped, so they're empty),
 * active one is not. This is exactly what `@testing-library`'s
 * `getAllByRole('tabpanel')` reports too — it excludes `hidden` elements by
 * default — so "one pane is mounted" means "one pane lacks `hidden`", not
 * "only one `role=tabpanel` div exists in the markup".
 */
function tabpanelTags(html: string): string[] {
  return html.match(/<div[^>]*\srole="tabpanel"[^>]*>/g) ?? [];
}

function visibleTabpanelTags(html: string): string[] {
  return tabpanelTags(html).filter((tag) => !tag.includes(' hidden'));
}

describe('SettingsPanelShell — pane wiring', () => {
  test('every tab gets a panel', () => {
    expect(tabpanelTags(render()).length).toBe(allItems.length);
  });

  test('with no tab selected, no panel is visible — which is why the chrome tests can render at all', () => {
    expect(visibleTabpanelTags(render()).length).toBe(0);
  });

  test('each rail trigger names the panel it controls', () => {
    const html = render();
    const panelIds = new Set(
      tabpanelTags(html)
        .map((tag) => tag.match(/\sid="([^"]+)"/)?.[1])
        .filter(Boolean),
    );
    const controlled = [...html.matchAll(/role="tab"[^>]*aria-controls="([^"]+)"/g)].map(
      (m) => m[1],
    );
    // Desktop rail only — the mobile scroller is a separate render.
    expect(controlled.length).toBe(allItems.length);
    for (const id of controlled) expect(panelIds.has(id)).toBe(true);
  });
});

/**
 * Proof that real tab-pane content is gated on the ACTIVE tab.
 *
 * Each surviving view calls `useQuery` / a client-only store / an auth probe
 * synchronously in its own function body. None of the `render(...)` calls
 * below provide a `QueryClientProvider` or a browser, so the call throws the
 * INSTANT a real view's function actually runs.
 *
 * That gives a mechanical, unfakeable signal for "this component's render
 * function was invoked" — stronger than a markup-string match, since it fires
 * exactly where a network request would otherwise start. A tab that mounts
 * throws; a tab that does not mount (because it isn't the active one) cannot
 * throw, no matter how many query-backed views exist as its inactive siblings
 * in the very same rail.
 *
 * This does not depend on Radix's own `present && children` behaviour inside
 * `TabsContent` — `SettingsTabPane` in `settings-panel.tsx` gates
 * independently with its own `active` check, so the proof holds even if a
 * future Radix upgrade changes that internal.
 *
 * The thirteen project-scoped cases that used to sit here moved with their
 * tabs to `/projects/[id]/config`; the eight account-scoped ones moved to
 * `/accounts/[id]`. Neither set is asserted here any more, because neither
 * mounts here any more.
 */
describe('SettingsPanelShell — real tab content gating', () => {
  test('no pane mounts while no tab is active — the negative control for the two cases below', () => {
    expect(() => render()).not.toThrow();
  });

  /**
   * Appearance and Sessions read Zustand stores and `next-themes`, neither of
   * which throws without a provider, so the throw signal cannot prove they
   * mounted. For those two the proof is the pane heading: present when the
   * tab is active, absent otherwise (`RailTriggerBody` renders the label too,
   * so the heading is matched as the `h2` `SettingsTabHeader` emits).
   */
  const STORE_ONLY_TABS = ['appearance', 'sessions'] as const;
  const QUERY_BACKED_TABS = SETTINGS_TABS.filter(
    (tab) => !(STORE_ONLY_TABS as readonly string[]).includes(tab),
  );

  test('every query-backed tab mounts a real view when it is the active one', () => {
    for (const tab of QUERY_BACKED_TABS) {
      expect(() => render({ tab, projectId: 'p1', accountId: 'a1' })).toThrow();
    }
  });

  test('each one mounts with no account id either — every pane resolves its own scope', () => {
    for (const tab of QUERY_BACKED_TABS) {
      expect(() => render({ tab, projectId: 'p1', accountId: undefined })).toThrow();
    }
  });

  test('the store-backed tabs mount their pane heading only while active', () => {
    for (const tab of STORE_ONLY_TABS) {
      const label = allItems.find((item) => item.tab === tab)?.label ?? '';
      expect(label).not.toBe('');
      const heading = new RegExp(`<h2[^>]*>${label}</h2>`);
      expect(render({ tab, projectId: 'p1' })).toMatch(heading);
      expect(render()).not.toMatch(heading);
    }
  });

  /**
   * The `workspace` pane's belt-and-braces guard, exercised.
   *
   * `GeneralTab` cannot run without a project id, and the rail already filters
   * its row out whenever there is none (`ACCOUNT_SCOPED_SETTINGS_TABS`). This
   * pins the second line of defence: given the row anyway, the pane renders its
   * own label instead of mounting `GeneralTab` against an empty id.
   *
   * It is the exact inverse of the two loops above — same tab, same absence of
   * a `QueryClientProvider`, opposite outcome — so it cannot pass vacuously.
   */
  test('the workspace panes do NOT mount without a project id', () => {
    for (const tab of ['workspace', 'sandbox', 'feature-flags', 'upgrades'] as const) {
      expect(() => render({ tab, projectId: undefined })).not.toThrow();
      expect(() => render({ tab, projectId: 'p1' })).toThrow();
    }
  });

  /**
   * `projectId` is back in the shell contract, for ONE pane.
   *
   * It was removed on 2026-08-17 with the last pane that read it (the Connected
   * tab's project-scoped ChatGPT row) and this test asserted its absence. The
   * `workspace` pane restored the need on 2026-09-01: `GeneralTab` reads and
   * writes the project, so the id has to reach it.
   *
   * Asserted as a declared, optional-valued prop rather than merely "the type
   * compiles": a shell that silently dropped the prop while keeping it in the
   * type would still typecheck, and the workspace pane would then render its
   * fallback label forever with nothing failing.
   */
  test('`projectId` is part of the shell contract, and may be undefined', () => {
    const props: SettingsPanelShellProps = baseProps();
    expect('projectId' in props).toBe(true);
    expect(props.projectId).toBeUndefined();
    expect(baseProps({ projectId: 'p1' }).projectId).toBe('p1');
  });
});

/**
 * The shell no longer takes a project at all.
 *
 * It took one to render `RelatedProjectsSwitcher` in the rail, back when the
 * overlay held thirteen project-configuration tabs. Every pane left in it is
 * user-scoped, so switching project from here changes nothing visible inside
 * the frame; the project sidebar's own switcher
 * (`project-sidebar/workspace-switcher.tsx`) is where that job lives.
 * `SettingsPanelView` still takes the project — for the dialog's accessible
 * title — which is why this is asserted on the shell's props, not the view's.
 */
describe('SettingsPanelShell — project-free', () => {
  test('renders the rail with no project in scope', () => {
    const html = render();
    expect((html.match(/role="tablist"/g) ?? []).length).toBeGreaterThan(0);
  });

  test('the rail holds no related-projects switcher', () => {
    expect(render()).not.toContain('related-projects-switcher');
  });

  test('`project` is not part of the shell contract', () => {
    const props: SettingsPanelShellProps = baseProps();
    expect('project' in props).toBe(false);
  });
});

describe('SettingsPanelShell — mobile', () => {
  test('renders a flat horizontal tablist instead of one list per group', () => {
    const html = render({ isMobile: true });
    expect((html.match(/role="tablist"/g) ?? []).length).toBe(1);
    expect((html.match(/role="tab"/g) ?? []).length).toBe(allItems.length);
  });

  test('renders the close button', () => {
    expect(render({ isMobile: true })).toContain('aria-label="Close"');
  });
});

/**
 * `buildSettingsPanelSettingsNav` is the pure adapter `SettingsPanel` uses to
 * build the `SettingsNav` value it hands down through `SettingsNavProvider`.
 * `navigate` writes through the real store (same idiom as
 * `stores/settings-panel-store.test.ts`), so these reset it between tests
 * rather than mocking it.
 *
 * The overlay is one of TWO hosts of that context now. The other is
 * `/projects/[id]/config`, whose adapter (`buildProjectSettingsNav`) is
 * covered in `capabilities/project-settings/project-settings-page.test.ts`.
 */
describe('buildSettingsPanelSettingsNav', () => {
  beforeEach(() => {
    useSettingsPanelStore.setState({
      open: false,
      tab: DEFAULT_SETTINGS_TAB,
      membersTab: 'people',
    });
  });

  test('maps open/tab/membersTab straight across, and llmProvidersTab is always undefined', () => {
    const nav = buildSettingsPanelSettingsNav({
      open: true,
      tab: 'preferences',
      membersTab: 'invite',
    });
    expect(nav.isOpen).toBe(true);
    expect(nav.activeTab).toBe('preferences');
    expect(nav.membersTab).toBe('invite');
    expect(nav.llmProvidersTab).toBeUndefined();
  });

  test('reports isOpen: false verbatim — it does not coerce a closed panel to true', () => {
    const nav = buildSettingsPanelSettingsNav({
      open: false,
      tab: 'connected',
      membersTab: 'people',
    });
    expect(nav.isOpen).toBe(false);
  });

  test('navigate() switches the tab on the live store without touching open', () => {
    useSettingsPanelStore.setState({ open: true });
    const nav = buildSettingsPanelSettingsNav(useSettingsPanelStore.getState());
    nav.navigate('connected');
    expect(useSettingsPanelStore.getState().tab).toBe('connected');
    expect(useSettingsPanelStore.getState().open).toBe(true);
  });

  test('an explicit membersTab opt sets membersTab on the live store', () => {
    const nav = buildSettingsPanelSettingsNav(useSettingsPanelStore.getState());
    nav.navigate('preferences', { membersTab: 'invite' });
    expect(useSettingsPanelStore.getState().tab).toBe('preferences');
    expect(useSettingsPanelStore.getState().membersTab).toBe('invite');
  });

  test('omitting opts leaves membersTab untouched', () => {
    useSettingsPanelStore.setState({ membersTab: 'invite' });
    const nav = buildSettingsPanelSettingsNav(useSettingsPanelStore.getState());
    nav.navigate('connected');
    expect(useSettingsPanelStore.getState().membersTab).toBe('invite');
  });
});

/**
 * The scope gate.
 *
 * `SettingsPanel` has two mounts: `ProjectShell` (with a `projectId`) and
 * `app/(app)/settings*` (without one). `isSettingsTabAllowed` decides which
 * rows the rail may show on each, and — for the two Workspace rows that
 * mount config-page panes — whether the caller's project capabilities admit
 * the row, over the identical `CUSTOMIZE_SECTION_GATE_ACTIONS` leaves
 * `/projects/[id]/config` reads.
 */
describe('isSettingsTabAllowed — project scope (JAY-547)', () => {
  function paramsFor(overrides: Partial<SettingsTabAllowedParams> = {}): SettingsTabAllowedParams {
    return { hasProject: false, ...overrides };
  }

  test('with no project, exactly the account-scoped tabs are allowed', () => {
    const allowed = SETTINGS_TABS.filter((tab) => isSettingsTabAllowed(tab, paramsFor()));
    expect([...allowed].sort()).toEqual([...ACCOUNT_SCOPED_SETTINGS_TABS].sort());
  });

  // The three project-scoped tabs, and the gate is what hides them — and
  // with them the whole `Workspace` rail group — on `/settings` and under
  // `/accounts/**`, where there is no project to name. Asserted as an exact
  // list so a fourth project-scoped tab cannot be added without a decision.
  test('exactly four tabs are project-scoped, and the gate hides them with no project', () => {
    const projectScoped = SETTINGS_TABS.filter(
      (tab) => !ACCOUNT_SCOPED_SETTINGS_TABS.includes(tab),
    );
    expect(projectScoped).toEqual(['workspace', 'sandbox', 'feature-flags', 'upgrades']);
    for (const tab of projectScoped) {
      expect(isSettingsTabAllowed(tab, paramsFor())).toBe(false);
    }
    expect(isSettingsTabAllowed('workspace', paramsFor({ hasProject: true }))).toBe(true);
  });

  /**
   * Sandbox templates and Feature flags gate on the same IAM read leaf the
   * config page gates them on (`isCustomizeSectionVisible`). No capability
   * answer yet — the probe in flight, or a caller that passed none — hides
   * the row rather than showing a pane the API would refuse.
   */
  test('the IAM-gated workspace tabs follow the project capability answer', () => {
    const allow = () => true;
    const deny = () => false;
    for (const tab of ['sandbox', 'feature-flags', 'upgrades'] as const) {
      expect(isSettingsTabAllowed(tab, paramsFor({ hasProject: true }))).toBe(false);
      expect(isSettingsTabAllowed(tab, paramsFor({ hasProject: true, canProject: deny }))).toBe(
        false,
      );
      expect(isSettingsTabAllowed(tab, paramsFor({ hasProject: true, canProject: allow }))).toBe(
        true,
      );
      // A capability grant never overrides the scope rule.
      expect(isSettingsTabAllowed(tab, paramsFor({ hasProject: false, canProject: allow }))).toBe(
        false,
      );
    }
  });

  /**
   * The probe answer the container feeds the gate. Fail-open while loading
   * is load-bearing: an in-flight probe reads `allowed: false`, and the
   * panel bounces an active tab that is not in the rail — so `=== true`
   * sent every `/settings/sandbox` deep link to Profile in CI.
   */
  test('an in-flight probe admits the row; only a received denial hides it', () => {
    expect(probeAdmits(undefined)).toBe(true);
    expect(probeAdmits({ allowed: false, isLoading: true })).toBe(true);
    expect(probeAdmits({ allowed: true, isLoading: false })).toBe(true);
    expect(probeAdmits({ allowed: false, isLoading: false })).toBe(false);
  });

  test('with a project and every capability, the scope gate admits every tab', () => {
    for (const tab of SETTINGS_TABS) {
      expect(
        isSettingsTabAllowed(tab, paramsFor({ hasProject: true, canProject: () => true })),
      ).toBe(true);
    }
  });

  test('a hypothetical project-scoped tab is hidden with no project', () => {
    // The rule the gate exists for, exercised against an id that is not in
    // `ACCOUNT_SCOPED_SETTINGS_TABS`. Without this the suite would pass
    // vacuously while every real tab happens to be user-scoped.
    expect(isSettingsTabAllowed('some-project-tab' as never, paramsFor())).toBe(false);
    expect(isSettingsTabAllowed('some-project-tab' as never, paramsFor({ hasProject: true }))).toBe(
      true,
    );
  });
});
