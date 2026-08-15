import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_CUSTOMIZE_TAB,
  DEFAULT_SETTINGS_TAB,
  SETTINGS_TABS,
  TAB_SURFACE,
  legacySectionRedirect,
  parseSettingsTab,
  resolveSettingsOverlayHref,
  settingsTabHref,
  surfaceForTab,
} from './settings-tabs';

describe('SETTINGS_TABS', () => {
  test('holds every tab exactly once', () => {
    expect(new Set(SETTINGS_TABS).size).toBe(SETTINGS_TABS.length);
  });

  test('each surface default is a real tab, on that surface', () => {
    expect(SETTINGS_TABS).toContain(DEFAULT_SETTINGS_TAB);
    expect(SETTINGS_TABS).toContain(DEFAULT_CUSTOMIZE_TAB);
    expect(surfaceForTab(DEFAULT_SETTINGS_TAB)).toBe('settings');
    expect(surfaceForTab(DEFAULT_CUSTOMIZE_TAB)).toBe('customize');
  });

  test('carries the tabs the spec names', () => {
    for (const tab of [
      'profile', 'preferences', 'connected',
      'general', 'members', 'secrets', 'channels', 'repositories',
      'schedules', 'webhooks',
      'models', 'marketplace', 'review', 'voice', 'sandbox', 'snapshots',
      'organization', 'billing', 'usage', 'groups', 'roles', 'identity', 'audit',
      'api-keys', 'experimental', 'upgrades',
      'agents', 'skills', 'connectors', 'apps',
    ]) {
      expect(SETTINGS_TABS).toContain(tab as never);
    }
  });

  test('every tab is assigned to exactly one surface', () => {
    for (const tab of SETTINGS_TABS) {
      expect(['customize', 'settings']).toContain(TAB_SURFACE[tab]);
    }
    expect(Object.keys(TAB_SURFACE).sort()).toEqual([...SETTINGS_TABS].sort());
  });

  test('settingsTabHref puts a tab on the surface that owns it', () => {
    expect(settingsTabHref('p1', 'secrets')).toBe('/projects/p1/customize/secrets');
    expect(settingsTabHref('p1', 'members')).toBe('/projects/p1/settings/members');
  });

  // The Instructions tab was removed outright: it only ever rendered
  // `CommandsView`, and the project-level instructions surface the design doc
  // described never existed (no `instructions` field on
  // `ProjectConfigSummary`). It is asserted absent rather than simply left out
  // of the list above, so re-adding the id without re-adding a real view
  // fails here instead of shipping a rail row onto the default tab.
  test('instructions is not a tab', () => {
    expect(SETTINGS_TABS).not.toContain('instructions' as never);
    expect(parseSettingsTab('instructions')).toBeNull();
  });
});

describe('parseSettingsTab', () => {
  test('accepts a known tab', () => {
    expect(parseSettingsTab('members')).toBe('members');
  });

  test('rejects an unknown segment', () => {
    expect(parseSettingsTab('nope')).toBeNull();
    expect(parseSettingsTab(null)).toBeNull();
    expect(parseSettingsTab('')).toBeNull();
  });
});

describe('legacySectionRedirect', () => {
  // `commands` used to fold into the Instructions tab. That tab is gone and
  // has no successor, so the id must resolve to `null` — which sends
  // `customize/[section]/page.tsx` to its bare `/settings` fallback. Pinning
  // `null` (not a URL) is the point: a stale mapping to `instructions` would
  // deep-link a bookmark at a segment `parseSettingsTab` now rejects.
  test('commands no longer resolves — the Instructions tab it named is gone', () => {
    expect(legacySectionRedirect('p1', 'commands')).toBeNull();
    expect(legacySectionRedirect('p1', 'instructions')).toBeNull();
  });

  test('the old settings section becomes general', () => {
    expect(legacySectionRedirect('p1', 'settings')).toBe('/projects/p1/settings/general');
  });

  test('git becomes repositories', () => {
    expect(legacySectionRedirect('p1', 'git')).toBe('/projects/p1/settings/repositories');
  });

  test('the old singular upgrade folds into the new plural upgrades tab', () => {
    expect(legacySectionRedirect('p1', 'upgrade')).toBe('/projects/p1/settings/upgrades');
  });

  test('tokens folds into api-keys', () => {
    // /accounts/[id]?tab=tokens is a bookmarked account-settings URL — see
    // SettingsTabId in lib/menu-registry.ts. It must keep resolving.
    expect(legacySectionRedirect('p1', 'tokens')).toBe('/projects/p1/settings/api-keys');
  });

  test('transactions folds into usage', () => {
    // /accounts/[id]?tab=transactions is the same kind of bookmarked link.
    expect(legacySectionRedirect('p1', 'transactions')).toBe('/projects/p1/settings/usage');
  });

  // Every entry in settings-tabs.ts's RENAMED_TABS map, pinned in one place.
  // RENAMED_TABS itself is not exported (it's an implementation detail, not
  // part of this module's public contract), so this table is a hand-kept
  // mirror rather than a live import — if you rename or remove an entry in
  // RENAMED_TABS, update this table in the same change, or this test goes
  // stale without catching it. Adding a KNOWN id here that RENAMED_TABS
  // doesn't have will fail immediately, which is what caught tokens/
  // transactions being untested in the first place.
  test('every renamed legacy id in RENAMED_TABS is pinned', () => {
    const renames: Record<string, string> = {
      settings: 'general',
      git: 'repositories',
      tokens: 'api-keys',
      transactions: 'usage',
      upgrade: 'upgrades',
      'llm-management': 'models',
      'llm-overview': 'models',
      'llm-providers': 'models',
      'llm-logs': 'models',
      'llm-budgets': 'models',
      'llm-keys': 'models',
      'llm-api': 'models',
      agent: 'agents',
      computers: 'connectors',
    };
    for (const [legacyId, newTab] of Object.entries(renames)) {
      expect(legacySectionRedirect('p1', legacyId)).toBe(
        settingsTabHref('p1', newTab as never),
      );
    }
  });

  test('the capability pages resolve to their Customize panes', () => {
    expect(legacySectionRedirect('p1', 'skills')).toBe('/projects/p1/customize/skills');
    expect(legacySectionRedirect('p1', 'agents')).toBe('/projects/p1/customize/agents');
    expect(legacySectionRedirect('p1', 'connectors')).toBe('/projects/p1/customize/connectors');
    expect(legacySectionRedirect('p1', 'apps')).toBe('/projects/p1/customize/apps');
  });

  test('files and changes are routes, not panes, so they leave the panel', () => {
    expect(legacySectionRedirect('p1', 'files')).toBe('/projects/p1/files');
    expect(legacySectionRedirect('p1', 'changes')).toBe(
      '/projects/p1/files?panel=proposed-changes',
    );
  });

  test('computers is a connector — a bookmark must not 404', () => {
    // `main` (#6313) deleted `computers-view.tsx` and made the computer a
    // connector (`ComputerTunnelManager`). Both the legacy `/customize/
    // computers` and the settings-era `/settings/computers` deep links resolve
    // through this map, so neither can land on a tab that no longer exists.
    expect(legacySectionRedirect('p1', 'computers')).toBe('/projects/p1/customize/connectors');
    expect(SETTINGS_TABS).not.toContain('computers' as never);
    expect(parseSettingsTab('computers')).toBeNull();
  });

  test('every llm sub-section lands on models', () => {
    for (const s of ['llm-management', 'llm-overview', 'llm-providers', 'llm-logs', 'llm-budgets', 'llm-keys', 'llm-api']) {
      expect(legacySectionRedirect('p1', s)).toBe('/projects/p1/customize/models');
    }
  });

  test('an unknown section produces no redirect', () => {
    expect(legacySectionRedirect('p1', 'nope')).toBeNull();
  });

  // Coverage carried forward from the retired legacy Customize-sections test —
  // cases the spec test above doesn't exercise but the old suite caught.
  test('the agent/agents spellings both land on the Agents pane', () => {
    // `agent` was the route segment, `agents` the overlay section id. Both are
    // in the wild.
    expect(legacySectionRedirect('p1', 'agent')).toBe('/projects/p1/customize/agents');
    expect(legacySectionRedirect('p1', 'agents')).toBe('/projects/p1/customize/agents');
  });

  test('a live id resolves to its own surface, not the one in the caller url', () => {
    expect(legacySectionRedirect('p1', 'secrets')).toBe('/projects/p1/customize/secrets');
    expect(legacySectionRedirect('p1', 'members')).toBe('/projects/p1/settings/members');
  });

  test('files and changes are not tabs', () => {
    for (const route of ['files', 'changes']) {
      expect(SETTINGS_TABS).not.toContain(route as never);
      expect(parseSettingsTab(route)).toBeNull();
    }
  });
});

describe('resolveSettingsOverlayHref', () => {
  test('a bare href opens that surface on its default tab', () => {
    expect(resolveSettingsOverlayHref('/projects/p1/settings')).toEqual({
      opensOverlay: true,
      surface: 'settings',
      tab: undefined,
    });
    expect(resolveSettingsOverlayHref('/projects/p1/customize')).toEqual({
      opensOverlay: true,
      surface: 'customize',
      tab: undefined,
    });
  });

  test('a named tab opens that tab', () => {
    expect(resolveSettingsOverlayHref('/projects/p1/settings/members')).toEqual({
      opensOverlay: true,
      surface: 'settings',
      tab: 'members',
    });
  });

  test('a tab opens on the surface that owns it, not the one in the href', () => {
    // A stale `/settings/secrets` href must still land on Secrets, which is a
    // Customize pane now.
    expect(resolveSettingsOverlayHref('/projects/p1/settings/secrets')).toEqual({
      opensOverlay: true,
      surface: 'customize',
      tab: 'secrets',
    });
    expect(resolveSettingsOverlayHref('/projects/p1/customize/members')).toEqual({
      opensOverlay: true,
      surface: 'settings',
      tab: 'members',
    });
  });

  test('an unresolvable segment does not open a panel', () => {
    expect(resolveSettingsOverlayHref('/projects/p1/settings/files')).toEqual({
      opensOverlay: false,
    });
  });

  test('a non-settings href does not open the overlay', () => {
    expect(resolveSettingsOverlayHref('/projects/p1/files')).toEqual({ opensOverlay: false });
  });
});
