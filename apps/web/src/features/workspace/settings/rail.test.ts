import { describe, expect, test } from 'bun:test';
import {
  UPGRADE_ITEM,
  filterRailGroups,
  isRailItemActive,
  railGroups,
  railItemMatches,
  type RailFlags,
} from './rail';
import type { RailItem } from './type';

const item = (tab: RailItem['tab']): RailItem => ({ tab, label: tab });

const flags = (overrides: Partial<RailFlags> = {}): RailFlags => ({
  marketplaceEnabled: false,
  llmGatewayAvailable: false,
  voiceEnabled: false,
  reviewEnabled: false,
  appsEnabled: false,
  ...overrides,
});

const ALL_ON: RailFlags = {
  marketplaceEnabled: true,
  llmGatewayAvailable: true,
  voiceEnabled: true,
  reviewEnabled: true,
  appsEnabled: true,
};

/** Every tab on BOTH surfaces — the rail is split in two now. */
const tabsOf = (f: RailFlags): string[] =>
  [...railGroups('customize', f), ...railGroups('settings', f)].flatMap((g) =>
    g.items.map((i) => i.tab),
  );

const customizeTabs = (f: RailFlags): string[] =>
  railGroups('customize', f).flatMap((g) => g.items.map((i) => i.tab));
const settingsTabs = (f: RailFlags): string[] =>
  railGroups('settings', f).flatMap((g) => g.items.map((i) => i.tab));

describe('railGroups', () => {
  test('Customize renders its groups in order', () => {
    expect(railGroups('customize', ALL_ON).map((g) => g.label)).toEqual([
      'Agent',
      'Reach',
      'Automate',
      'Runtime',
      'Get more',
    ]);
  });

  test('Settings renders its groups in order', () => {
    expect(railGroups('settings', flags()).map((g) => g.label)).toEqual([
      'You',
      'Workspace',
      'Organization',
      'Developer',
    ]);
  });

  test('the two surfaces share no tab', () => {
    const c = new Set(customizeTabs(ALL_ON));
    expect(settingsTabs(ALL_ON).filter((t) => c.has(t))).toEqual([]);
  });

  test('what the agent is and can do is in Customize, administration is in Settings', () => {
    const c = customizeTabs(ALL_ON);
    for (const tab of ['agents', 'skills', 'models', 'connectors', 'apps', 'channels', 'schedules', 'webhooks', 'secrets', 'sandbox', 'snapshots', 'marketplace']) {
      expect(c).toContain(tab);
    }
    const s = settingsTabs(ALL_ON);
    for (const tab of ['profile', 'preferences', 'general', 'members', 'repositories', 'billing', 'roles', 'audit', 'api-keys', 'experimental']) {
      expect(s).toContain(tab);
    }
  });

  test('with every flag off it holds the static tabs only', () => {
    const tabs = tabsOf(flags());
    expect(tabs).toContain('profile');
    expect(tabs).toContain('channels');
    expect(tabs).toContain('billing');
    expect(tabs).not.toContain('voice');
    expect(tabs).not.toContain('review');
    expect(tabs).not.toContain('marketplace');
    expect(tabs).not.toContain('apps');
  });

  test('each flag adds exactly its own tab', () => {
    expect(tabsOf(flags({ voiceEnabled: true }))).toContain('voice');
    expect(tabsOf(flags({ reviewEnabled: true }))).toContain('review');
    expect(tabsOf(flags({ marketplaceEnabled: true }))).toContain('marketplace');
    expect(tabsOf(flags({ appsEnabled: true }))).toContain('apps');
  });

  test('two flags in one group both land — the old early-return regression', () => {
    // Reach carries two gated rows (Apps, Voice). The rail used to return a
    // group on the first flag that matched, silently dropping the second.
    const reach = railGroups('customize', ALL_ON).find((g) => g.label === 'Reach');
    expect(reach?.items.map((i) => i.tab)).toEqual(['connectors', 'apps', 'channels', 'voice']);
  });

  test('a gated row keeps its place in the group, it does not fall to the end', () => {
    const reach = railGroups('customize', flags({ appsEnabled: true })).find(
      (g) => g.label === 'Reach',
    );
    expect(reach?.items.map((i) => i.tab)).toEqual(['connectors', 'apps', 'channels']);
  });

  test('an empty group is never returned — Get more exists only with Marketplace', () => {
    expect(railGroups('customize', flags()).map((g) => g.label)).not.toContain('Get more');
    expect(railGroups('customize', flags({ marketplaceEnabled: true })).map((g) => g.label)).toContain(
      'Get more',
    );
    for (const group of [...railGroups('customize', flags()), ...railGroups('settings', flags())]) {
      expect(group.items.length).toBeGreaterThan(0);
    }
  });

  test('every flag on yields 29 content tabs across both surfaces', () => {
    // 25 before Customize took the four capability panes (Agents, Skills,
    // Connectors, Apps) back off their standalone routes.
    expect(tabsOf(ALL_ON)).toHaveLength(29);
  });

  test('no tab appears in two groups', () => {
    const tabs = tabsOf(ALL_ON);
    expect(new Set(tabs).size).toBe(tabs.length);
  });

  test('upgrades is not in the scrolling groups — it is pinned', () => {
    expect(tabsOf(flags())).not.toContain('upgrades');
  });

  // Ported from the legacy Customize overlay's rail test + IA checkpoints test, which
  // covered this same rail before the settings-panel cutover deleted the
  // legacy Customize overlay and its own rail module.
  test('uses Secrets as the user-facing tab name', () => {
    const secrets = railGroups('customize', flags())
      .flatMap((group) => group.items)
      .find((railItem) => railItem.tab === 'secrets');
    expect(secrets?.label).toBe('Secrets');
  });

  test('repositories (renamed from git) and sandbox templates are reachable, with no dead changes/dev tab', () => {
    const tabs = tabsOf(flags());
    expect(tabs).toContain('repositories');
    expect(tabs).toContain('sandbox');
    const sandbox = railGroups('customize', flags())
      .flatMap((g) => g.items)
      .find((i) => i.tab === 'sandbox');
    expect(sandbox?.label).toBe('Sandbox templates');
    expect(tabs).not.toContain('changes');
    expect(tabs).not.toContain('dev');
  });

  test('the capability panes are in Customize, under their own spellings', () => {
    const tabs = customizeTabs(ALL_ON);
    // Plural `agents` is the tab id. `agent` was the old ROUTE segment and is
    // not a tab — `legacySectionRedirect` folds it onto `agents`.
    expect(tabs).toContain('agents');
    expect(tabs).not.toContain('agent');
    expect(tabs).toContain('connectors');
    expect(tabs).toContain('skills');
    // Computers is a connector since #6313 — never its own row.
    expect(tabs).not.toContain('computers');
  });

  test('the sections that stayed from Customize are untouched', () => {
    const tabs = tabsOf(flags());
    expect(tabs).toContain('secrets');
    expect(tabs).toContain('channels');
    expect(tabs).toContain('members');
  });

  test('instructions has no rail row — the tab was removed, not hidden', () => {
    // Every flag ON, so this cannot pass merely because a gate is closed.
    expect(tabsOf(ALL_ON)).not.toContain('instructions');
    expect(tabsOf(ALL_ON)).not.toContain('commands');
  });

  test('models is reachable in the rail regardless of the llm gateway flag — unlike the legacy llm-management row, it is not flag-gated', () => {
    expect(tabsOf(flags())).toContain('models');
    expect(tabsOf(flags({ llmGatewayAvailable: true }))).toContain('models');
  });

  test('organization (JAY-546) is first in the Organization group, before billing', () => {
    const org = railGroups('settings', flags()).find((g) => g.label === 'Organization');
    expect(org?.items.map((i) => i.tab)[0]).toBe('organization');
    expect(org?.items.map((i) => i.tab)).toContain('billing');
  });

  test('organization uses "General" as its user-facing label', () => {
    const organization = railGroups('settings', flags())
      .flatMap((g) => g.items)
      .find((i) => i.tab === 'organization');
    expect(organization?.label).toBe('General');
  });

  test('a tab reachable in the rail is the one the panel can activate', () => {
    // The panel bounces to the default tab when no rail item matches, so a
    // gated tab MUST resolve through isRailItemActive to be reachable.
    const items = railGroups('customize', flags({ reviewEnabled: true })).flatMap((g) => g.items);
    expect(items.some((i) => isRailItemActive(i, 'review'))).toBe(true);
  });
});

describe('isRailItemActive', () => {
  test('an item matches its own tab', () => {
    expect(isRailItemActive(item('members'), 'members')).toBe(true);
    expect(isRailItemActive(item('members'), 'secrets')).toBe(false);
  });

  test('plain items are independent rail items with no shared activation', () => {
    expect(isRailItemActive(item('channels'), 'secrets')).toBe(false);
    expect(isRailItemActive(item('channels'), 'repositories')).toBe(false);
    expect(isRailItemActive(item('secrets'), 'channels')).toBe(false);
    expect(isRailItemActive(item('secrets'), 'repositories')).toBe(false);
    expect(isRailItemActive(item('repositories'), 'channels')).toBe(false);
    expect(isRailItemActive(item('repositories'), 'secrets')).toBe(false);
  });

  test('models stands in for every llm sub-tab', () => {
    expect(isRailItemActive(item('models'), 'models')).toBe(true);
    expect(isRailItemActive(item('models'), 'llm-logs')).toBe(true);
    expect(isRailItemActive(item('models'), 'llm-budgets')).toBe(true);
    expect(isRailItemActive(item('models'), 'llm-management')).toBe(true);
    expect(isRailItemActive(item('models'), 'llm-providers')).toBe(true);
    expect(isRailItemActive(item('models'), 'members')).toBe(false);
  });

  test('the models item is not active for a non-llm tab', () => {
    expect(isRailItemActive(item('models'), 'channels')).toBe(false);
    expect(isRailItemActive(item('models'), 'repositories')).toBe(false);
  });
});

describe('filterRailGroups', () => {
  const all = () => railGroups('settings', flags());
  const shape = (gs: readonly { label: string; items: readonly RailItem[] }[]) =>
    gs.map((g) => [g.label, g.items.map((i) => i.tab)] as const);

  test('a blank query returns the same groups, by identity', () => {
    const groups = all();
    expect(filterRailGroups(groups, '')).toBe(groups);
    expect(filterRailGroups(groups, '   ')).toBe(groups);
  });

  // The headline requirement: a match keeps its GROUP, heading and all — a
  // result is never a bare row floating where five groups used to be.
  test('a matching row keeps its group heading, and every other group goes', () => {
    expect(shape(filterRailGroups(all(), 'profile'))).toEqual([['You', ['profile']]]);
  });

  test('matching is case-insensitive and ignores surrounding space', () => {
    expect(shape(filterRailGroups(all(), '  PROFILE '))).toEqual([['You', ['profile']]]);
  });

  test('a group name is itself a query, and keeps all of its rows', () => {
    const [group, ...rest] = filterRailGroups(all(), 'organization');
    expect(rest).toEqual([]);
    expect(group.label).toBe('Organization');
    // Not re-filtered against the query — only one of these rows contains the
    // word "organization" in its own label or description.
    expect(group.items.map((i) => i.tab)).toEqual(
      all()
        .find((g) => g.label === 'Organization')!
        .items.map((i) => i.tab),
    );
  });

  test('a row is findable by its description, not only its label', () => {
    // `api-keys`: "Let the Kortix CLI, a script, or a CI job use this workspace."
    expect(shape(filterRailGroups(all(), 'cli'))).toEqual([['Developer', ['api-keys']]]);
  });

  test('groups keep their original order when several match', () => {
    // Three, not two: `experimental`'s description ("Features you can switch on
    // before they are generally available.") contains "general" as a substring.
    // That is the filter working as designed — the test above pins that a row
    // is findable by its description — and it is the cost of substring matching
    // over prose. The invariant this test exists for is the ORDER: Workspace
    // before Organization before Developer, matching `STATIC_GROUPS`.
    expect(filterRailGroups(all(), 'general').map((g) => g.label)).toEqual([
      'Workspace',
      'Organization',
      'Developer',
    ]);
  });

  test('a query nothing matches returns no groups at all', () => {
    expect(filterRailGroups(all(), 'zzzznotathing')).toEqual([]);
  });

  test('it never invents a row that railGroups did not produce', () => {
    const visible = filterRailGroups(all(), 'e').flatMap((g) => g.items.map((i) => i.tab));
    const every = settingsTabs(flags());
    expect(visible.every((t) => every.includes(t))).toBe(true);
  });
});

describe('railItemMatches', () => {
  test('a blank query matches everything, so the pinned rows stay put', () => {
    expect(railItemMatches(UPGRADE_ITEM, '')).toBe(true);
    expect(railItemMatches(UPGRADE_ITEM, '  ')).toBe(true);
  });

  test('it filters the pinned Upgrades row like any other', () => {
    expect(railItemMatches(UPGRADE_ITEM, 'upgrade')).toBe(true);
    expect(railItemMatches(UPGRADE_ITEM, 'profile')).toBe(false);
  });

  test('an item with no description matches on its label alone', () => {
    expect(railItemMatches(item('profile'), 'prof')).toBe(true);
    expect(railItemMatches(item('profile'), 'billing')).toBe(false);
  });
});
