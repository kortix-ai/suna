import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SETTINGS_TAB,
  SETTINGS_TABS,
  legacySectionRedirect,
  parseSettingsTab,
  resolveSettingsOverlayHref,
} from './settings-tabs';

describe('SETTINGS_TABS', () => {
  test('holds every tab exactly once', () => {
    expect(new Set(SETTINGS_TABS).size).toBe(SETTINGS_TABS.length);
  });

  test('the default tab is a real tab', () => {
    expect(SETTINGS_TABS).toContain(DEFAULT_SETTINGS_TAB);
  });

  test('carries the tabs the spec names', () => {
    for (const tab of [
      'profile', 'preferences', 'connected',
      'general', 'members', 'secrets', 'channels', 'repositories',
      'schedules', 'webhooks', 'computers',
      'models', 'instructions', 'marketplace', 'review', 'voice', 'sandbox', 'snapshots',
      'organization', 'billing', 'usage', 'groups', 'roles', 'identity', 'audit',
      'api-keys', 'experimental', 'upgrades',
    ]) {
      expect(SETTINGS_TABS).toContain(tab as never);
    }
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
  test('commands folds into instructions', () => {
    expect(legacySectionRedirect('p1', 'commands')).toBe('/projects/p1/settings/instructions');
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
      commands: 'instructions',
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
    };
    for (const [legacyId, newTab] of Object.entries(renames)) {
      expect(legacySectionRedirect('p1', legacyId)).toBe(`/projects/p1/settings/${newTab}`);
    }
  });

  test('graduated capability pages still leave the overlay', () => {
    expect(legacySectionRedirect('p1', 'skills')).toBe('/projects/p1/skills');
    expect(legacySectionRedirect('p1', 'agents')).toBe('/projects/p1/agent');
    expect(legacySectionRedirect('p1', 'connectors')).toBe('/projects/p1/connectors');
    expect(legacySectionRedirect('p1', 'files')).toBe('/projects/p1/files');
  });

  test('every llm sub-section lands on models', () => {
    for (const s of ['llm-management', 'llm-overview', 'llm-providers', 'llm-logs', 'llm-budgets', 'llm-keys', 'llm-api']) {
      expect(legacySectionRedirect('p1', s)).toBe('/projects/p1/settings/models');
    }
  });

  test('an unknown section produces no redirect', () => {
    expect(legacySectionRedirect('p1', 'nope')).toBeNull();
  });

  // Coverage carried forward from the retired legacy Customize-sections test —
  // cases the spec test above doesn't exercise but the old suite caught.
  test('the graduated agent/agents spellings both redirect', () => {
    expect(legacySectionRedirect('p1', 'agent')).toBe('/projects/p1/agent');
  });

  test('changes redirects to the files proposed-changes panel', () => {
    expect(legacySectionRedirect('p1', 'changes')).toBe('/projects/p1/files?panel=proposed-changes');
  });

  test('an id that never changed resolves to its own settings tab', () => {
    expect(legacySectionRedirect('p1', 'secrets')).toBe('/projects/p1/settings/secrets');
  });

  test('files, connectors, skills, and agent are not settings tabs', () => {
    for (const graduated of ['files', 'changes', 'agent', 'agents', 'connectors', 'skills']) {
      expect(SETTINGS_TABS).not.toContain(graduated as never);
      expect(parseSettingsTab(graduated)).toBeNull();
    }
  });
});

describe('resolveSettingsOverlayHref', () => {
  test('a bare settings href opens the default tab', () => {
    expect(resolveSettingsOverlayHref('/projects/p1/settings')).toEqual({
      opensOverlay: true,
      tab: undefined,
    });
  });

  test('a named tab opens that tab', () => {
    expect(resolveSettingsOverlayHref('/projects/p1/settings/members')).toEqual({
      opensOverlay: true,
      tab: 'members',
    });
  });

  test('an unresolvable segment does not open the overlay', () => {
    expect(resolveSettingsOverlayHref('/projects/p1/settings/skills')).toEqual({
      opensOverlay: false,
    });
  });

  test('a non-settings href does not open the overlay', () => {
    expect(resolveSettingsOverlayHref('/projects/p1/files')).toEqual({ opensOverlay: false });
  });
});
