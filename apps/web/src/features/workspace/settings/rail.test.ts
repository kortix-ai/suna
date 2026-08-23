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
  test('renders one group: You', () => {
    expect(railGroups().map((g) => g.label)).toEqual(['You']);
  });

  test('holds exactly the person-scoped tabs, in order', () => {
    // `tokens` (labelled "API keys") rejoined on 2026-08-18 — a person's own
    // keys are person-scoped; only the service-account half is account
    // configuration and it stayed on `/accounts/[id]`.
    expect(tabsOf()).toEqual(['profile', 'preferences', 'connected', 'tokens']);
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
      'sandbox',
      'snapshots',
      'marketplace',
      'review',
      'experimental',
      'feature-flags',
      'upgrades',
    ]) {
      expect(tabs).not.toContain(gone);
    }
  });

  test('the account-scoped and standalone-page tabs are gone too', () => {
    const tabs = tabsOf();
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
    expect(railItemForTab('upgrades' as never)).toBeUndefined();
  });
});
