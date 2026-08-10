import { beforeEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { Modal } from '@/components/ui/modal';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';
import {
  ACCOUNT_SCOPED_SETTINGS_TABS,
  ACCOUNT_TAB_PERMISSION,
  buildSettingsPanelSettingsNav,
  isSettingsTabAllowed,
  SettingsPanelShell,
  type SettingsPanelShellProps,
  type SettingsTabAllowedParams,
} from './settings-panel';
import { UPGRADE_ITEM, railGroups } from './rail';
import { DEFAULT_SETTINGS_TAB, SETTINGS_TABS, type SettingsTab } from './settings-tabs';
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
 * (`PreferencesTab`). Task 18 adds `experimental` (`ExperimentalTab`) to
 * `REAL_VIEW_TABS` itself — it's project-scoped like every other entry in
 * that array, unlike `profile`/`preferences`.
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
  // Task 20: `snapshots` is the split-off build-log half of the legacy
  // `sandbox` case's `SandboxView` — see `tabs/sandbox-tab.tsx`'s header
  // comment. It was the LAST tab still on the placeholder header (see the
  // now-removed "still-placeholder active tab" test above this array's
  // former comment); every `SettingsTab` is a real view as of this task.
  'snapshots',
  'experimental',
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

/**
 * `snapshots` was the last tab this describe block used as its "still a
 * placeholder" example, after `usage` (Task 12) and `experimental` (Task 18)
 * were each wired in turn — see this array's own comment above. Task 20
 * wires `snapshots` to `SnapshotsTab`, so as of this task EVERY
 * `SettingsTab` is a real view: there is no placeholder tab left to exercise
 * a "still-placeholder active tab renders cleanly" test against. That test
 * is removed rather than repointed at a fabricated placeholder tab.
 */
describe('SettingsPanelShell — real tab content gating', () => {
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

  test('activating groups mounts its real view — it calls react-query with no provider present, so it throws', () => {
    expect(() =>
      render({
        tab: 'groups',
        projectId: 'p1',
        accountId: 'a1',
        llmGatewayEnabled: true,
        groups: allFlagsOnGroups,
        allItems: allFlagsOnItems,
      }),
    ).toThrow();
  });

  test('groups mounts its real view even with no project id — it is account-scoped like billing/usage, unlike every REAL_VIEW_TABS entry below', () => {
    expect(() => render({ tab: 'groups', projectId: undefined, accountId: undefined })).toThrow();
  });

  test('activating roles mounts its real view — it calls react-query with no provider present, so it throws', () => {
    expect(() =>
      render({
        tab: 'roles',
        projectId: 'p1',
        accountId: 'a1',
        llmGatewayEnabled: true,
        groups: allFlagsOnGroups,
        allItems: allFlagsOnItems,
      }),
    ).toThrow();
  });

  test('roles mounts its real view even with no project id — it is account-scoped like billing/usage/groups, unlike every REAL_VIEW_TABS entry below', () => {
    expect(() => render({ tab: 'roles', projectId: undefined, accountId: undefined })).toThrow();
  });

  test('activating organization mounts its real view — it probes account.write with no auth context present, so it throws', () => {
    expect(() =>
      render({
        tab: 'organization',
        projectId: 'p1',
        accountId: 'a1',
        llmGatewayEnabled: true,
        groups: allFlagsOnGroups,
        allItems: allFlagsOnItems,
      }),
    ).toThrow();
  });

  test('organization mounts its real view even with no project id — it is account-scoped like billing/usage/groups/roles, unlike every REAL_VIEW_TABS entry below', () => {
    expect(() =>
      render({ tab: 'organization', projectId: undefined, accountId: undefined }),
    ).toThrow();
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

/**
 * Task 13b — `isSettingsTabAllowed` is the pure decision function
 * `SettingsPanel`'s `isTabAllowed` callback delegates to (see
 * `settings-panel.tsx`). It's tested directly here, with no hooks and no
 * `QueryClientProvider`, because the hook-driven container itself can't
 * render under `renderToStaticMarkup` (see this file's header comment) — the
 * same reason `buildSettingsPanelSettingsNav` above is tested as a pure
 * function rather than through a mounted `SettingsPanel`.
 *
 * Per gated tab this pins the three states the task brief calls for:
 * permitted shows the row (`true`), denied hides it (`false`), and
 * unresolved (loading OR errored — both collapse to the same
 * `accountPermsResolved: false` input, see `settings-panel.tsx`'s header
 * comment on `isSettingsTabAllowed`) shows it (`true`, fail open).
 */
describe('isSettingsTabAllowed — account-scoped gating (Task 13b)', () => {
  const gatedAccountTabs = Object.keys(ACCOUNT_TAB_PERMISSION) as (keyof typeof ACCOUNT_TAB_PERMISSION)[];

  function paramsFor(overrides: Partial<SettingsTabAllowedParams> = {}): SettingsTabAllowedParams {
    return {
      // The project-scoped mount is the default here: every case below this
      // helper predates the standalone `/settings` route and asserts the
      // in-project rail. The project-less mount has its own describe block.
      hasProject: true,
      projectCapsResolved: true,
      projectCan: () => true,
      accountPermsResolved: true,
      accountCan: () => true,
      billingEnabled: true,
      ...overrides,
    };
  }

  test('billing, usage, roles, identity, audit, api-keys, and organization are the only gated account tabs', () => {
    expect(gatedAccountTabs.sort()).toEqual([
      'api-keys',
      'audit',
      'billing',
      'identity',
      'organization',
      'roles',
      'usage',
    ]);
  });

  test('permitted: every account-gated tab shows once its permission resolves allowed', () => {
    for (const tab of gatedAccountTabs) {
      expect(isSettingsTabAllowed(tab, paramsFor({ accountCan: () => true }))).toBe(true);
    }
  });

  test('denied: every account-gated tab is absent once its permission resolves denied', () => {
    for (const tab of gatedAccountTabs) {
      expect(isSettingsTabAllowed(tab, paramsFor({ accountCan: () => false }))).toBe(false);
    }
  });

  test('unresolved (loading): every account-gated tab stays visible — fail open', () => {
    for (const tab of gatedAccountTabs) {
      expect(
        isSettingsTabAllowed(
          tab,
          paramsFor({ accountPermsResolved: false, accountCan: () => false }),
        ),
      ).toBe(true);
    }
  });

  test('unresolved (errored probe): every account-gated tab stays visible — fail open, not fail closed', () => {
    // An errored probe and a loading probe are indistinguishable to this
    // function BY DESIGN: the caller (`SettingsPanel`) folds `isLoading` and
    // `isError` into the single `accountPermsResolved: false` input before
    // calling here — see `settings-panel.tsx`'s decision writeup on
    // `isSettingsTabAllowed`. A row must not disappear just because the
    // probe failed to answer.
    for (const tab of gatedAccountTabs) {
      expect(
        isSettingsTabAllowed(
          tab,
          paramsFor({ accountPermsResolved: false, accountCan: () => false }),
        ),
      ).toBe(true);
    }
  });

  test('groups carries no permission gate — always allowed, independent of the account probe', () => {
    expect(isSettingsTabAllowed('groups', paramsFor({ accountCan: () => false }))).toBe(true);
    expect(
      isSettingsTabAllowed('groups', paramsFor({ accountPermsResolved: false, accountCan: () => false })),
    ).toBe(true);
  });

  test('api-keys is gated on account.write (Task 16) — no longer an always-allowed placeholder', () => {
    expect(isSettingsTabAllowed('api-keys', paramsFor({ accountCan: () => false }))).toBe(false);
    expect(isSettingsTabAllowed('api-keys', paramsFor({ accountCan: () => true }))).toBe(true);
  });

  test('audit is gated on audit.read (Task 15) — no longer an always-allowed placeholder', () => {
    expect(isSettingsTabAllowed('audit', paramsFor({ accountCan: () => false }))).toBe(false);
    expect(isSettingsTabAllowed('audit', paramsFor({ accountCan: () => true }))).toBe(true);
  });

  test('a project-gated tab is unaffected by the account probe', () => {
    expect(
      isSettingsTabAllowed(
        'secrets',
        paramsFor({ projectCan: () => false, accountCan: () => true }),
      ),
    ).toBe(false);
    expect(
      isSettingsTabAllowed(
        'secrets',
        paramsFor({ projectCapsResolved: false, projectCan: () => false }),
      ),
    ).toBe(true);
  });

  test('an account-gated tab is unaffected by the project probe', () => {
    expect(
      isSettingsTabAllowed(
        'billing',
        paramsFor({ projectCapsResolved: false, projectCan: () => false, accountCan: () => true }),
      ),
    ).toBe(true);
  });

  /**
   * Fix round 1 — the reference model this task mirrors
   * (`app/(app)/accounts/[id]/page.tsx:359`) is `billing: canWriteAccount
   * === true && billingActive`, not `canWriteAccount === true` alone. These
   * pin the deployment-flag half of that AND, which folding
   * `billingEnabled` into `isSettingsTabAllowed` now reproduces.
   */
  test('billing: hidden when the billing deployment flag is off, regardless of permission', () => {
    expect(
      isSettingsTabAllowed('billing', paramsFor({ billingEnabled: false, accountCan: () => true })),
    ).toBe(false);
  });

  test('billing: hidden by the flag even while the account probe is still unresolved — not subject to fail-open', () => {
    // Unlike a permission probe, `billingEnabled` is a synchronous env read
    // with no loading/error state — there is nothing to "fail open" about,
    // so it overrides even the optimistic-while-loading path.
    expect(
      isSettingsTabAllowed(
        'billing',
        paramsFor({ billingEnabled: false, accountPermsResolved: false, accountCan: () => false }),
      ),
    ).toBe(false);
  });

  test('billing: visible when both the flag is on and the permission resolves allowed', () => {
    expect(
      isSettingsTabAllowed('billing', paramsFor({ billingEnabled: true, accountCan: () => true })),
    ).toBe(true);
  });

  /**
   * `usage` deliberately does NOT get the flag — the reference model's
   * `transactions` line (`page.tsx:360`) is `canWriteAccount === true` with
   * no `billingActive` term (confirmed against `tabs/usage-tab.tsx`'s own
   * header comment: "Deliberately NOT combined with `isBillingEnabled()`").
   * Session costs stay reachable with billing off; only the credit-ledger
   * sub-section self-gates on the flag internally, inside
   * `CreditTransactions` — a content-level concern, not a rail concern.
   */
  test('usage: NOT gated by the billing deployment flag — stays visible with billing off, permission allowing', () => {
    expect(
      isSettingsTabAllowed('usage', paramsFor({ billingEnabled: false, accountCan: () => true })),
    ).toBe(true);
  });

  test('roles: NOT gated by the billing deployment flag either', () => {
    expect(
      isSettingsTabAllowed('roles', paramsFor({ billingEnabled: false, accountCan: () => true })),
    ).toBe(true);
  });
});

/**
 * Task 13b — proof at the presentational layer: when `SettingsPanel` (the
 * hook-driven container, not rendered here) computes `groups`/`allItems`
 * with a denied account-gated tab filtered out — exactly what
 * `isSettingsTabAllowed` returning `false` for it drives — the shell draws
 * no row for it at all, and an entitlement-gated-but-permission-open tab
 * (`groups`) stays present alongside it.
 */
describe('SettingsPanelShell — account-gated rows are absent when denied (Task 13b)', () => {
  test('billing, usage, and roles disappear from the rail when their permission is denied; groups stays', () => {
    const deniedTabs = new Set(Object.keys(ACCOUNT_TAB_PERMISSION));
    const filteredGroups = allGroups
      .map((g) => ({ ...g, items: g.items.filter((item) => !deniedTabs.has(item.tab)) }))
      .filter((g) => g.items.length > 0);
    const filteredItems = [...filteredGroups.flatMap((g) => g.items), UPGRADE_ITEM];
    // `tab` stays on the default (`general`, a placeholder pane) rather than
    // `groups` — mounting the real `GroupsTab` needs `AuthProvider`/
    // `QueryClientProvider`, neither of which exists under
    // `renderToStaticMarkup` (see this file's header comment). This test only
    // asserts rail-ROW presence, which doesn't depend on which pane is active.
    const html = render({ groups: filteredGroups, allItems: filteredItems });

    expect(html).not.toContain('>Billing<');
    expect(html).not.toContain('>Usage<');
    expect(html).not.toContain('>Roles<');
    expect(html).toContain('>Groups<');
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

/**
 * JAY-547 — the project-less mount.
 *
 * `SettingsPanel` now has two mounts: `ProjectShell` (with a `projectId`) and
 * `app/(app)/settings*` (without one). `SettingsTabPane` handles eleven tabs
 * ABOVE its `if (projectId) { switch ... }` guard and every other tab inside
 * it, so on the project-less mount every tab inside that guard renders a bare
 * placeholder header. `ACCOUNT_SCOPED_SETTINGS_TABS` + the `hasProject` param
 * are what keep those rows out of the rail instead of showing ~17 rows that
 * open onto a title and nothing else.
 *
 * The first case below is the one that matters long-term: it is derived from
 * `SETTINGS_TABS`, so a tab added to the panel later is covered without
 * anyone remembering to extend this file.
 */
describe('isSettingsTabAllowed — project scope (JAY-547)', () => {
  function paramsFor(overrides: Partial<SettingsTabAllowedParams> = {}): SettingsTabAllowedParams {
    return {
      hasProject: false,
      projectCapsResolved: true,
      projectCan: () => true,
      accountPermsResolved: true,
      accountCan: () => true,
      billingEnabled: true,
      ...overrides,
    };
  }

  test('with no project, exactly the account-scoped tabs are allowed', () => {
    const allowed = SETTINGS_TABS.filter((tab) => isSettingsTabAllowed(tab, paramsFor()));
    expect([...allowed].sort()).toEqual([...ACCOUNT_SCOPED_SETTINGS_TABS].sort());
  });

  test('every project-scoped tab is hidden with no project, however permissive the probes', () => {
    const projectScoped = SETTINGS_TABS.filter(
      (tab) => !ACCOUNT_SCOPED_SETTINGS_TABS.includes(tab),
    );
    // Non-empty, or the assertion below would pass vacuously.
    expect(projectScoped.length).toBeGreaterThan(0);
    for (const tab of projectScoped) {
      expect(
        isSettingsTabAllowed(
          tab,
          paramsFor({ projectCapsResolved: false, projectCan: () => true, accountCan: () => true }),
        ),
      ).toBe(false);
    }
  });

  test('the scope gate does not fail open while a probe is unresolved', () => {
    // Every OTHER gate in this function fails open on an unresolved probe.
    // This one must not: "no project is mounted" is known synchronously and is
    // never pending, so `general` stays hidden even in the optimistic window.
    expect(
      isSettingsTabAllowed(
        'general',
        paramsFor({ accountPermsResolved: false, projectCapsResolved: false }),
      ),
    ).toBe(false);
  });

  test('the pinned Upgrades tab is project-scoped, so it drops off the rail too', () => {
    expect(isSettingsTabAllowed('upgrades', paramsFor())).toBe(false);
    expect(isSettingsTabAllowed('upgrades', paramsFor({ hasProject: true }))).toBe(true);
  });

  test('with a project, the scope gate changes nothing — every tab is judged on its own gates', () => {
    for (const tab of SETTINGS_TABS) {
      expect(isSettingsTabAllowed(tab, paramsFor({ hasProject: true }))).toBe(true);
    }
  });

  test('account-scoped tabs still answer to their own permission gate with no project', () => {
    // The scope gate ADMITS these tabs; it must not also grant them.
    expect(isSettingsTabAllowed('billing', paramsFor({ accountCan: () => false }))).toBe(false);
    expect(isSettingsTabAllowed('billing', paramsFor({ billingEnabled: false }))).toBe(false);
    expect(isSettingsTabAllowed('billing', paramsFor())).toBe(true);
  });
});
