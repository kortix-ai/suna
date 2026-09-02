import { describe, expect, test } from 'bun:test';
import { isRailItemActive, railGroups, railItemForTab } from './rail';
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
 * for `/projects/[id]/config`. These tests pin that they are gone from HERE —
 * `capabilities/project-settings/project-settings-sections.test.ts` pins that
 * they arrived THERE.
 */
describe('railGroups', () => {
  // Workspace FIRST. The overlay is entered from a row labelled "User
  // Settings", but that row names its default TAB, not the rail's order — so
  // leading with the workspace's own identity costs the personal tabs nothing
  // and is what makes renaming findable again.
  test('renders three groups: Workspace, Personal, Account', () => {
    expect(railGroups().map((g) => g.label)).toEqual(['Workspace', 'Personal', 'Account']);
  });

  test('holds the workspace tabs first, then the person-scoped tabs, then the plan', () => {
    // The 2026-09-02 segmentation (Jay): Security, Appearance and Sessions
    // split out of Profile and Preferences; Sandbox templates and Feature
    // flags back under Workspace; Plan as the one Account row.
    expect(tabsOf()).toEqual([
      'workspace',
      'sandbox',
      'feature-flags',
      'upgrades',
      'profile',
      'security',
      'appearance',
      'sessions',
      'preferences',
      'connected',
      'tokens',
      'plan',
    ]);
  });

  // The row says "General" while the id is `workspace`: the id is a URL segment
  // and `general` was already spent on a redirect, but "General" is what this
  // pane has always been called. Pinned so a future tidy-up cannot silently
  // rename the row to match the id and break the word people look for.
  test('the workspace rows are LABELLED as the config page labels them', () => {
    const group = railGroups().find((g) => g.label === 'Workspace');
    expect(group?.items.map((i) => i.label)).toEqual([
      'General',
      'Sandbox templates',
      'Feature flags',
      'Upgrades',
    ]);
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
