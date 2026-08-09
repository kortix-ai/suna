import { beforeEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { Modal } from '@/components/ui/modal';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';
import {
  buildSettingsPanelSettingsNav,
  SettingsPanelShell,
  type SettingsPanelShellProps,
} from './settings-panel';
import { UPGRADE_ITEM, railGroups } from './rail';
import { DEFAULT_SETTINGS_TAB, type SettingsTab } from './settings-tabs';
import type { RailItem } from './type';

/**
 * `SettingsPanelShell` is the innermost presentational layer — no hooks, no
 * `useQuery`, no Zustand store read, AND no `Modal`/`ModalContent` (see the
 * split in `settings-panel.tsx`, mirroring `MigrateToV2ButtonView` beside
 * `MigrateToV2Button`, one level deeper). `SettingsPanel` calls `useQuery` /
 * `useProjectCans` / `useSettingsPanelStore`; `SettingsPanelView` wraps the
 * shell in `Modal`, whose `ModalContent` renders through
 * `DialogPrimitive.Portal` — that gates on a `mounted` flag flipped by
 * `useLayoutEffect`, which never runs during static rendering, so a
 * `Modal`-wrapped tree always renders as nothing under
 * `renderToStaticMarkup`, independent of `open`. Neither `SettingsPanel` nor
 * `SettingsPanelView` can be exercised this way; both are covered for real
 * once the panel is mounted (Task 5b) via the Playwright harness — see the
 * task report.
 */

const flags = {
  tunnelEnabled: false,
  marketplaceEnabled: false,
  llmGatewayAvailable: false,
  voiceEnabled: false,
  reviewEnabled: false,
};

const allGroups = railGroups(flags);
const allItems: readonly RailItem[] = [...allGroups.flatMap((g) => g.items), UPGRADE_ITEM];

function baseProps(overrides: Partial<SettingsPanelShellProps> = {}): SettingsPanelShellProps {
  return {
    tab: DEFAULT_SETTINGS_TAB,
    onTabChange: () => {},
    isMobile: false,
    project: undefined,
    projectId: undefined,
    accountId: undefined,
    groups: allGroups,
    allItems,
    upgradeAllowed: true,
    upgradeAttention: false,
    reviewNeedsYou: 0,
    llmGatewayEnabled: false,
    ...overrides,
  };
}

/**
 * `SettingsPanelShell` renders a `ModalClose` (the "Back to workspace" /
 * mobile close button) directly, which needs Dialog context — real in
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
  test('renders more than 20 tabs across the rail', () => {
    const html = render();
    const tabCount = (html.match(/role="tab"/g) ?? []).length;
    expect(tabCount).toBeGreaterThan(20);
  });

  test('renders one TabsList per rail group — Radix cannot mix a group Label into one shared list', () => {
    const html = render();
    const tablistCount = (html.match(/role="tablist"/g) ?? []).length;
    // One list per STATIC group, plus one for the pinned Upgrades item.
    expect(tablistCount).toBe(allGroups.length + 1);
  });

  test('every group label renders above its own list', () => {
    const html = render();
    for (const group of allGroups) {
      expect(html).toContain(`>${group.label}<`);
    }
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
 * "only one `role=tabpanel` div exists in the markup". Task 1's own test
 * (`tabs.vertical.test.tsx`) never actually exercised this distinction: it
 * only ever rendered a single `TabsContent`, so its count was 1 either way.
 */
function tabpanelTags(html: string): string[] {
  return html.match(/<div[^>]*\srole="tabpanel"[^>]*>/g) ?? [];
}

function visibleTabpanelTags(html: string): string[] {
  return tabpanelTags(html).filter((tag) => !tag.includes(' hidden'));
}

describe('SettingsPanelShell — pane wiring', () => {
  test('every tab gets a panel, but only one is visible at a time', () => {
    const html = render();
    expect(tabpanelTags(html).length).toBe(allItems.length);
    expect(visibleTabpanelTags(html).length).toBe(1);
  });

  test('the active trigger and the visible pane are wired together', () => {
    for (const tab of ['general', 'secrets', 'upgrades'] as const) {
      const html = render({ tab });
      const panelId = visibleTabpanelTags(html)[0]?.match(/\sid="([^"]+)"/)?.[1];
      const controls = html.match(/aria-selected="true"[^>]*aria-controls="([^"]+)"/)?.[1];
      expect(panelId).toBeTruthy();
      expect(controls).toBe(panelId);
    }
  });

  test('the mounted pane renders the active tab label as its heading', () => {
    const html = render({ tab: 'secrets' });
    expect(html).toContain('>Secrets<');
  });
});

/**
 * Task 5b2 — proof that real tab-pane content is gated on the ACTIVE tab.
 *
 * Every one of the fifteen views wired onto a tab this task ports from
 * The legacy panel's `SectionContent` switch calls `useQuery` /
 * `useProjectCan` (react-query) synchronously in its own function body —
 * confirmed by grepping each file (see the task report's table). None of the
 * `render(...)` calls below provide a `QueryClientProvider`, so react-query
 * throws its own `No QueryClient set, use QueryClientProvider to set one`
 * error the INSTANT a real view's function actually runs.
 *
 * Task 7 adds a sixteenth: `profile` (`ProfileTab`), tested separately below
 * `REAL_VIEW_TABS` rather than folded into that array — it is account-scoped,
 * so `SettingsTabPane` mounts it whether or not `projectId` is set, unlike
 * every entry in `REAL_VIEW_TABS`, which all fall back to the placeholder
 * header without one. Task 8 adds a seventeenth the same way: `preferences`
 * (`PreferencesTab`).
 *
 * That gives a mechanical, unfakeable signal for "this component's render
 * function was invoked" — stronger than a markup-string match, since it fires
 * exactly where a network request would otherwise start. A tab that mounts
 * throws; a tab that does not mount (because it isn't the active one) cannot
 * throw, no matter how many query-backed views exist as its inactive
 * siblings in the very same rail.
 *
 * This does not depend on Radix's own `present && children` behaviour inside
 * `TabsContent` (verified separately, see this file's header) — `SettingsTabPane`
 * in `settings-panel.tsx` gates independently with its own `active` check, so
 * the proof holds even if a future Radix upgrade changes that internal.
 */
const REAL_VIEW_TABS: readonly SettingsTab[] = [
  'general',
  'members',
  'secrets',
  'channels',
  'repositories',
  'schedules',
  'webhooks',
  'computers',
  'models',
  'instructions',
  'marketplace',
  'review',
  'voice',
  'sandbox',
  'upgrades',
];

/** `computers`, `marketplace`, `review`, and `voice` are flag-gated rail
 *  items (see `rail.ts`) — with every flag off (this file's module-level
 *  `flags`/`allGroups`/`allItems`) they don't exist in the rail at all, so
 *  there is no `TabsContent` for them to mount into. Every flag on puts all
 *  fifteen real-view tabs in the rail at once, which is what this describe
 *  block's "every real-view tab exists as a sibling" claim requires to be
 *  literally true. */
const allFlagsOnGroups = railGroups({
  tunnelEnabled: true,
  marketplaceEnabled: true,
  llmGatewayAvailable: true,
  voiceEnabled: true,
  reviewEnabled: true,
});
const allFlagsOnItems: readonly RailItem[] = [
  ...allFlagsOnGroups.flatMap((g) => g.items),
  UPGRADE_ITEM,
];

describe('SettingsPanelShell — real tab content gating', () => {
  test('a still-placeholder active tab renders cleanly, even though every real-view tab exists as an inactive sibling', () => {
    expect(() =>
      render({
        // `experimental` is still a genuinely unbuilt placeholder — `profile`,
        // `preferences`, `connected`, (Task 11) `billing`, and (Task 12)
        // `usage` moved into `REAL_VIEW_TABS`-equivalent coverage below once
        // each was wired to its real view. This example previously used
        // `usage`; Task 12 wired that tab to `UsageTab`, so this moved to
        // `experimental` — confirmed by grep: `grep -n "'experimental'"
        // settings-panel.test.tsx` before this change showed no reference at
        // all, so moving this example here doesn't drop coverage of anything
        // that was already being exercised.
        tab: 'experimental',
        projectId: 'p1',
        llmGatewayEnabled: true,
        groups: allFlagsOnGroups,
        allItems: allFlagsOnItems,
      }),
    ).not.toThrow();
  });

  test('activating profile mounts its real view — it calls react-query with no provider present, so it throws', () => {
    expect(() =>
      render({
        tab: 'profile',
        projectId: 'p1',
        llmGatewayEnabled: true,
        groups: allFlagsOnGroups,
        allItems: allFlagsOnItems,
      }),
    ).toThrow();
  });

  test('profile mounts its real view even with no project id — it is account-scoped, not project-scoped, unlike every REAL_VIEW_TABS entry below', () => {
    expect(() => render({ tab: 'profile', projectId: undefined })).toThrow();
  });

  test('activating preferences mounts its real view — it calls a client-only store outside a browser, so it throws', () => {
    expect(() =>
      render({
        tab: 'preferences',
        projectId: 'p1',
        llmGatewayEnabled: true,
        groups: allFlagsOnGroups,
        allItems: allFlagsOnItems,
      }),
    ).toThrow();
  });

  test('preferences mounts its real view even with no project id — it is account-scoped, not project-scoped, unlike every REAL_VIEW_TABS entry below', () => {
    expect(() => render({ tab: 'preferences', projectId: undefined })).toThrow();
  });

  test('activating connected mounts its real view — it probes account.write with no auth context present, so it throws', () => {
    expect(() =>
      render({
        tab: 'connected',
        projectId: 'p1',
        accountId: 'a1',
        llmGatewayEnabled: true,
        groups: allFlagsOnGroups,
        allItems: allFlagsOnItems,
      }),
    ).toThrow();
  });

  test('connected mounts its real view even with no project id — it is account-scoped like profile/preferences, unlike every REAL_VIEW_TABS entry below', () => {
    expect(() => render({ tab: 'connected', projectId: undefined, accountId: undefined })).toThrow();
  });

  test('activating billing mounts its real view — it probes billing.write with no auth context present, so it throws', () => {
    expect(() =>
      render({
        tab: 'billing',
        projectId: 'p1',
        accountId: 'a1',
        llmGatewayEnabled: true,
        groups: allFlagsOnGroups,
        allItems: allFlagsOnItems,
      }),
    ).toThrow();
  });

  test('billing mounts its real view even with no project id — it is account-scoped like profile/preferences/connected, unlike every REAL_VIEW_TABS entry below', () => {
    expect(() => render({ tab: 'billing', projectId: undefined, accountId: undefined })).toThrow();
  });

  test('activating usage mounts its real view — it probes account.write with no auth context present, so it throws', () => {
    expect(() =>
      render({
        tab: 'usage',
        projectId: 'p1',
        accountId: 'a1',
        llmGatewayEnabled: true,
        groups: allFlagsOnGroups,
        allItems: allFlagsOnItems,
      }),
    ).toThrow();
  });

  test('usage mounts its real view even with no project id — it is account-scoped like profile/preferences/connected/billing, unlike every REAL_VIEW_TABS entry below', () => {
    expect(() => render({ tab: 'usage', projectId: undefined, accountId: undefined })).toThrow();
  });

  for (const tab of REAL_VIEW_TABS) {
    test(`activating ${tab} mounts its real view — it calls react-query with no provider present, so it throws`, () => {
      expect(() =>
        render({
          tab,
          projectId: 'p1',
          llmGatewayEnabled: true,
          groups: allFlagsOnGroups,
          allItems: allFlagsOnItems,
        }),
      ).toThrow();
    });
  }

  test('models renders nothing while the llm gateway is disabled for the project, mirroring the legacy `llm-*` guard', () => {
    // `SectionContent` in the legacy panel returns null outright for an
    // `llm-*` section when `!llmGatewayEnabled` — it does not fall back to a
    // placeholder header. Since the view is never invoked here, this must
    // not throw, and the active pane must render no heading at all.
    const html = render({ tab: 'models', projectId: 'p1', llmGatewayEnabled: false });
    expect(html).not.toContain('>Models</h2>');
  });

  test('models mounts its real view once the llm gateway is enabled for the project', () => {
    expect(() => render({ tab: 'models', projectId: 'p1', llmGatewayEnabled: true })).toThrow();
  });

  test('with no project id, every mapped tab falls back to its placeholder header instead of attempting a fetch', () => {
    for (const tab of REAL_VIEW_TABS) {
      expect(() => render({ tab, projectId: undefined })).not.toThrow();
    }
  });
});

describe('SettingsPanelShell — badges', () => {
  test('the Review trigger carries the needs-you count when nonzero', () => {
    const withReview = railGroups({ ...flags, reviewEnabled: true });
    const items = [...withReview.flatMap((g) => g.items), UPGRADE_ITEM];
    const html = render({ groups: withReview, allItems: items, reviewNeedsYou: 3 });
    expect(html).toContain('>3<');
  });

  test('the Review trigger carries no badge when the count is zero', () => {
    const withReview = railGroups({ ...flags, reviewEnabled: true });
    const items = [...withReview.flatMap((g) => g.items), UPGRADE_ITEM];
    const html = render({ groups: withReview, allItems: items, reviewNeedsYou: 0 });
    expect(html).not.toContain('tabular-nums');
  });

  test('the Upgrades trigger carries the attention dot when set', () => {
    expect(render({ upgradeAttention: true })).toContain('bg-kortix-orange');
  });

  test('the Upgrades trigger carries no attention dot otherwise', () => {
    expect(render({ upgradeAttention: false })).not.toContain('bg-kortix-orange');
  });

  test('the Upgrades trigger is absent from the rail when not allowed', () => {
    const html = render({ upgradeAllowed: false, allItems: allGroups.flatMap((g) => g.items) });
    expect(html).not.toContain('>Upgrades<');
  });
});

describe('SettingsPanelShell — project-optional', () => {
  test('renders with no project', () => {
    const html = render({ project: undefined });
    expect((html.match(/role="tablist"/g) ?? []).length).toBeGreaterThan(0);
  });

  test('omits the related-projects switcher with no project', () => {
    expect(render({ project: undefined })).not.toContain('related-projects-switcher');
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
 * build the `SettingsNav` value it hands down through `SettingsNavProvider`
 * — the new panel's counterpart to the legacy panel's
 * `buildCustomizeSettingsNav`. `navigate` writes through the real store
 * (same idiom as `stores/settings-panel-store.test.ts`), so these reset it
 * between tests rather than mocking it.
 */
describe('buildSettingsPanelSettingsNav', () => {
  beforeEach(() => {
    useSettingsPanelStore.setState({ open: false, tab: DEFAULT_SETTINGS_TAB, membersTab: 'people' });
  });

  test('maps open/tab/membersTab straight across, and llmProvidersTab is always undefined', () => {
    const nav = buildSettingsPanelSettingsNav({ open: true, tab: 'members', membersTab: 'invite' });
    expect(nav.isOpen).toBe(true);
    expect(nav.activeTab).toBe('members');
    expect(nav.membersTab).toBe('invite');
    expect(nav.llmProvidersTab).toBeUndefined();
  });

  test('reports isOpen: false verbatim — it does not coerce a closed panel to true', () => {
    const nav = buildSettingsPanelSettingsNav({ open: false, tab: 'secrets', membersTab: 'people' });
    expect(nav.isOpen).toBe(false);
  });

  test('navigate() switches the tab on the live store without touching open', () => {
    useSettingsPanelStore.setState({ open: true });
    const nav = buildSettingsPanelSettingsNav(useSettingsPanelStore.getState());
    nav.navigate('billing');
    expect(useSettingsPanelStore.getState().tab).toBe('billing');
    expect(useSettingsPanelStore.getState().open).toBe(true);
  });

  test('an explicit membersTab opt sets membersTab on the live store', () => {
    const nav = buildSettingsPanelSettingsNav(useSettingsPanelStore.getState());
    nav.navigate('members', { membersTab: 'invite' });
    expect(useSettingsPanelStore.getState().tab).toBe('members');
    expect(useSettingsPanelStore.getState().membersTab).toBe('invite');
  });

  test('omitting opts leaves membersTab untouched', () => {
    useSettingsPanelStore.setState({ membersTab: 'invite' });
    const nav = buildSettingsPanelSettingsNav(useSettingsPanelStore.getState());
    nav.navigate('general');
    expect(useSettingsPanelStore.getState().membersTab).toBe('invite');
  });
});
