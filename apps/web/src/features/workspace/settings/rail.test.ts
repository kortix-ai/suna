import { describe, expect, test } from 'bun:test';
import { isRailItemActive, railGroups, railItemForTab, RETIRED_RAIL_ITEMS } from './rail';
import { SETTINGS_TABS } from './settings-tabs';
import type { RailItem } from './type';

const item = (tab: RailItem['tab']): RailItem => ({ tab, label: tab });

const tabsOf = (): string[] => railGroups().flatMap((g) => g.items.map((i) => i.tab));

/**
 * The rail is what is LEFT in the settings overlay, and that is now exactly
 * the person-scoped tabs. Twenty-one rows left it in two moves: eight
 * account-scoped ones (Organization, Billing, Usage, Groups, Roles, Identity,
 * Audit log, API keys) for `/accounts/[id]`, and thirteen project-scoped ones
 * (General, Members, Secrets, Channels, Repositories, Models, Sandbox
 * templates, Snapshots, Marketplace, Review, Voice, Feature flags, Upgrades)
 * for `/projects/[id]/customize/settings`. These tests pin that they are gone from HERE —
 * `capabilities/project-settings/project-settings-sections.test.ts` pins that
 * they arrived THERE.
 */
describe('railGroups', () => {
  // Workspace FIRST. The overlay is entered from a row labelled "User
  // Settings", but that row names its default TAB, not the rail's order — so
  // leading with the workspace's own identity costs the personal tabs nothing
  // and is what makes renaming findable again.
  test('renders one group: Personal', () => {
    // Workspace (project configuration) is the Customize bar's Settings tab
    // and Account (Credits, Plan) is the account page — Marko, 2026-09-03:
    // the overlay is the person's own settings and nothing else.
    expect(railGroups().map((g) => g.label)).toEqual(['Personal']);
  });

  test('holds the workspace tabs first, then the person-scoped tabs, then the plan', () => {
    // The 2026-09-02 segmentation (Jay): Security, Appearance and Sessions
    // split out of Profile and Preferences; Sandbox templates and Feature
    // flags back under Workspace; Plan as the one Account row.
    expect(tabsOf()).toEqual([
      'profile',
      'security',
      'appearance',
      'sessions',
      'preferences',
      'tokens',
    ]);
  });

  // The row says "General" while the id is `workspace`: the id is a URL segment
  // and `general` was already spent on a redirect, but "General" is what this
  // pane has always been called. Pinned so a future tidy-up cannot silently
  // rename the row to match the id and break the word people look for.
  test('the retired project rows keep their labels for the panes that still render them', () => {
    // `railItemForTab` still resolves them — the Settings tab's sections
    // render `SettingsTabHeader` off these rows — but no group lists them.
    expect(RETIRED_RAIL_ITEMS.map((i) => i.label)).toEqual([
      'General',
      'Sandbox templates',
      'Feature flags',
      'Upgrades',
      'Connected accounts',
      'Credits',
      'Plan',
    ]);
    for (const item of RETIRED_RAIL_ITEMS) expect(railItemForTab(item.tab)).toBe(item);
    for (const group of railGroups()) {
      for (const item of group.items) expect(RETIRED_RAIL_ITEMS).not.toContain(item);
    }
  });

  test('every rail tab is a live SettingsTab, and every live SettingsTab has a rail row', () => {
    expect([...tabsOf()].sort()).toEqual([...SETTINGS_TABS].sort());
  });

  test('takes no flags — nothing left in the rail varies by one', () => {
    expect(railGroups.length).toBe(0);
  });

  test('returns a stable reference, so memoized callers do no work', () => {
    expect(railGroups()).toBe(railGroups());
  });

  test('the project-configuration tabs are gone, not merely hidden', () => {
    const tabs = tabsOf();
    for (const gone of [
      'general',
      'members',
      'secrets',
      'channels',
      'repositories',
      'models',
      'snapshots',
      'marketplace',
      'review',
      'experimental',
    ]) {
      expect(tabs).not.toContain(gone);
    }
  });

  test('the account-scoped and standalone-page tabs are gone too', () => {
    const tabs = tabsOf();
    // `billing` stays gone as an ID even though the plan is back as a row: the
    // row is `plan`, because `billing` is an `ACCOUNT_GRADUATED` redirect.
    for (const gone of [
      'organization',
      'billing',
      'usage',
      'groups',
      'roles',
      'identity',
      'audit',
      'api-keys',
      'agent',
      'agents',
      'connectors',
      'skills',
      'computers',
      'schedules',
      'webhooks',
    ]) {
      expect(tabs).not.toContain(gone);
    }
  });

  test('a tab reachable in the rail is the one the panel can activate', () => {
    // The panel bounces to the default tab when no rail item matches, so a
    // rail tab MUST resolve through isRailItemActive to be reachable.
    const items = railGroups().flatMap((g) => g.items);
    for (const tab of SETTINGS_TABS) {
      expect(items.some((i) => isRailItemActive(i, tab))).toBe(true);
    }
  });
});

describe('isRailItemActive', () => {
  test('an item matches its own tab and nothing else', () => {
    expect(isRailItemActive(item('profile'), 'profile')).toBe(true);
    expect(isRailItemActive(item('profile'), 'preferences')).toBe(false);
    expect(isRailItemActive(item('connected'), 'connected')).toBe(true);
    expect(isRailItemActive(item('connected'), 'profile')).toBe(false);
  });
});

describe('railItemForTab', () => {
  test('resolves every live tab to its row', () => {
    for (const tab of SETTINGS_TABS) {
      expect(railItemForTab(tab)?.tab).toBe(tab);
    }
  });

  test('returns undefined for a tab that left the rail — the header renders nothing rather than a wrong title', () => {
    expect(railItemForTab('members' as never)).toBeUndefined();
    expect(railItemForTab('review' as never)).toBeUndefined();
  });
});
