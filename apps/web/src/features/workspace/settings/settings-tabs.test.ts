import { describe, expect, test } from 'bun:test';
import {
  ACCOUNT_GRADUATED,
  DEFAULT_SETTINGS_TAB,
  SETTINGS_TABS,
  isAccountGraduatedSection,
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

  test('carries the four person-scoped tabs plus the one workspace tab', () => {
    // `tokens` rejoined the list on 2026-08-18: a person's own API keys are
    // person-scoped, not account configuration, so they came back from
    // `/accounts/[id]` while the service-account half stayed there.
    //
    // `workspace` joined on 2026-09-01 and is the ONLY project-scoped id here.
    // Renaming a workspace and changing its icon had become four surfaces deep
    // under Customize with no label naming what it did; see `SettingsTab`'s own
    // comment for why this one row is not "configuration" in the sense the
    // graduation below means. Its position is last on purpose — the rail orders
    // itself (`rail.ts`), this list does not.
    expect([...SETTINGS_TABS]).toEqual([
      'profile',
      'preferences',
      'connected',
      'tokens',
      'workspace',
    ]);
  });

  // The id has to stay `workspace`. `general` is spent on a GRADUATED redirect
  // to `/projects/<id>/config`, and a live tab under that key would shadow
  // every bookmark pointing at the config page.
  test('the workspace tab does not reclaim the graduated `general` id', () => {
    expect(SETTINGS_TABS).toContain('workspace');
    expect(SETTINGS_TABS).not.toContain('general');
  });

  // Every project-configuration id left for `/projects/[id]/config`. Asserted
  // absent rather than merely left out of the list above, so re-adding one
  // without re-adding a pane fails here instead of shipping a rail row that
  // opens onto nothing.
  test('no project-configuration id is a settings tab any more', () => {
    for (const gone of [
      'general',
      'members',
      'secrets',
      'channels',
      'repositories',
      'models',
      'marketplace',
      'review',
      'sandbox',
      'snapshots',
      'experimental',
      'feature-flags',
      'upgrades',
    ]) {
      expect(SETTINGS_TABS).not.toContain(gone as never);
      expect(parseSettingsTab(gone)).toBeNull();
    }
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
    expect(parseSettingsTab('preferences')).toBe('preferences');
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

  // Schedules and Webhooks left the overlay and merged into one Triggers
  // capability page. `parseSettingsTab` rejects both ids now, so the ONLY
  // thing keeping every `/settings/schedules` bookmark alive is the GRADUATED
  // entry. Without it the deep-link route falls back to the bare `/settings`
  // overlay and the link silently stops going where it used to.
  test('schedules and webhooks graduated to the merged Triggers page', () => {
    expect(legacySectionRedirect('p1', 'schedules')).toBe('/projects/p1/triggers');
    expect(legacySectionRedirect('p1', 'webhooks')).toBe('/projects/p1/triggers');
    expect(parseSettingsTab('schedules')).toBeNull();
    expect(parseSettingsTab('webhooks')).toBeNull();
    // They must not reopen the overlay either — a stale `/settings/schedules`
    // href has to fall through to a real navigation.
    expect(resolveSettingsOverlayHref('/projects/p1/settings/schedules')).toEqual({
      opensOverlay: false,
    });
    expect(resolveSettingsOverlayHref('/projects/p1/settings/webhooks')).toEqual({
      opensOverlay: false,
    });
  });

  /**
   * Project configuration left the overlay for the Customize bar's Settings
   * tab. Thirteen tab ids became thirteen `?section=` values on one page, and
   * every id that used to be RENAMED into the overlay (`settings`, `git`,
   * `upgrade`, the seven `llm-*` ids) now names a section on it — so the
   * rename map is gone and all of them are `GRADUATED` entries.
   *
   * The URL segment is `config`, not `settings`: `/projects/<id>/settings` is
   * the overlay's own deep-link route. Pinning the segment matters — a
   * redirect back onto `/settings/<id>` would bounce through
   * `parseSettingsTab`, get `null`, and land on the bare overlay.
   */
  test('the old settings section, and general itself, become the default section', () => {
    // No `?section=` on the default: `/projects/<id>/config` is a stable link.
    expect(legacySectionRedirect('p1', 'settings')).toBe('/projects/p1/config');
    expect(legacySectionRedirect('p1', 'general')).toBe('/projects/p1/config');
  });

  test('git and repositories both land on General — the Git repo section merged in there', () => {
    // Repositories never graduated to its own top-level tab; its content
    // merged INTO General under a "Git repo" section, so both the current id
    // and its pre-rename `git` spelling redirect to the bare `/config` link,
    // same as `settings` and `general` above.
    expect(legacySectionRedirect('p1', 'git')).toBe('/projects/p1/config');
    expect(legacySectionRedirect('p1', 'repositories')).toBe('/projects/p1/config');
  });

  test('the old singular upgrade folds into the plural upgrades section', () => {
    expect(legacySectionRedirect('p1', 'upgrade')).toBe('/projects/p1/config?section=upgrades');
    expect(legacySectionRedirect('p1', 'upgrades')).toBe('/projects/p1/config?section=upgrades');
  });

  test('experimental is renamed to feature-flags, and both ids resolve', () => {
    expect(legacySectionRedirect('p1', 'experimental')).toBe(
      '/projects/p1/config?section=feature-flags',
    );
    expect(legacySectionRedirect('p1', 'feature-flags')).toBe(
      '/projects/p1/config?section=feature-flags',
    );
  });

  // Every project-configuration id, pinned in one place. `GRADUATED` is not
  // exported (an implementation detail, not part of this module's public
  // contract), so this table is a hand-kept mirror rather than a live import —
  // rename or remove an entry there and this table must change in the same
  // commit, or it goes stale without catching it. Adding an id here that
  // `GRADUATED` does not carry fails immediately.
  test('every id that stayed on /config lands on its section', () => {
    const sections: Record<string, string> = {
      general: '',
      settings: '',
      sandbox: 'sandbox',
      // Snapshots merged INTO the sandbox section — a snapshot is the build
      // history of a sandbox template, not a separate pane any more.
      snapshots: 'sandbox',
      review: 'review',
      experimental: 'feature-flags',
      'feature-flags': 'feature-flags',
      upgrades: 'upgrades',
      upgrade: 'upgrades',
    };
    for (const [legacyId, section] of Object.entries(sections)) {
      expect(legacySectionRedirect('p1', legacyId)).toBe(
        section ? `/projects/p1/config?section=${section}` : '/projects/p1/config',
      );
      // ...and none of them may reopen the overlay from a stale href.
      expect(resolveSettingsOverlayHref(`/projects/p1/settings/${legacyId}`)).toEqual({
        opensOverlay: false,
      });
    }
  });

  test('secrets, channels, and models graduated a SECOND time — off /config, onto their own top-level tab', () => {
    const routes: Record<string, string> = {
      secrets: '/projects/p1/secrets',
      channels: '/projects/p1/connectors?scope=channels',
      models: '/projects/p1/models',
      'llm-management': '/projects/p1/models',
      'llm-overview': '/projects/p1/models',
      'llm-providers': '/projects/p1/models',
      'llm-logs': '/projects/p1/models',
      'llm-budgets': '/projects/p1/models',
      'llm-keys': '/projects/p1/models',
      'llm-api': '/projects/p1/models',
      // `members` graduated a second time too, then a THIRD — off the project
      // entirely, onto the account page's Access tab. It is account-scoped
      // now (`ACCOUNT_GRADUATED`, with a `&project=` special case), covered
      // in the "account-scoped sections redirect to /accounts/[id]" describe
      // block below, not here.
    };
    for (const [legacyId, href] of Object.entries(routes)) {
      expect(legacySectionRedirect('p1', legacyId)).toBe(href);
      expect(resolveSettingsOverlayHref(`/projects/p1/settings/${legacyId}`)).toEqual({
        opensOverlay: false,
      });
    }
  });

  test('marketplace redirects to the Customize index — the product removed it, it did not move', () => {
    expect(legacySectionRedirect('p1', 'marketplace')).toBe('/projects/p1/customize');
  });

  test('graduated capability pages still leave the overlay', () => {
    expect(legacySectionRedirect('p1', 'skills')).toBe('/projects/p1/skills');
    expect(legacySectionRedirect('p1', 'agents')).toBe('/projects/p1/agent');
    expect(legacySectionRedirect('p1', 'connectors')).toBe('/projects/p1/connectors');
    expect(legacySectionRedirect('p1', 'files')).toBe('/projects/p1/files');
  });

  test('computers graduated to Connectors — a bookmark must not 404', () => {
    // `main` (#6313) deleted `computers-view.tsx` and made the computer a
    // connector (`ComputerTunnelManager`). Both the legacy `/customize/
    // computers` and the settings-era `/settings/computers` deep links resolve
    // through this map, so neither can land on a tab that no longer exists.
    expect(legacySectionRedirect('p1', 'computers')).toBe('/projects/p1/connectors');
    expect(SETTINGS_TABS).not.toContain('computers' as never);
    expect(parseSettingsTab('computers')).toBeNull();
  });

  test('every llm sub-section lands on the top-level Models tab', () => {
    for (const s of [
      'llm-management',
      'llm-overview',
      'llm-providers',
      'llm-logs',
      'llm-budgets',
      'llm-keys',
      'llm-api',
    ]) {
      expect(legacySectionRedirect('p1', s)).toBe('/projects/p1/models');
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
    expect(legacySectionRedirect('p1', 'changes')).toBe(
      '/projects/p1/files?panel=proposed-changes',
    );
  });

  test('an id that is still a settings tab resolves to its own overlay URL', () => {
    expect(legacySectionRedirect('p1', 'preferences')).toBe('/projects/p1/settings/preferences');
  });

  test('files, connectors, skills, and agent are not settings tabs', () => {
    for (const graduated of ['files', 'changes', 'agent', 'agents', 'connectors', 'skills']) {
      expect(SETTINGS_TABS).not.toContain(graduated as never);
      expect(parseSettingsTab(graduated)).toBeNull();
    }
  });
});

/**
 * The eight account-scoped sections that left the overlay for
 * `/accounts/[id]`. Every one of them was a live `/projects/<id>/settings/<id>`
 * URL, so the ONLY thing keeping those bookmarks alive is this map — without
 * it the deep-link route falls back to the bare overlay and the link silently
 * stops going where it used to.
 */
describe('account-scoped sections redirect to /accounts/[id]', () => {
  // Legacy section id -> the `?tab=` segment `app/(app)/accounts/[id]/page.tsx`
  // reads. Hand-kept mirror of ACCOUNT_GRADUATED, so a rename there without a
  // rename here fails immediately. Two are not 1:1 — the account page calls
  // Organization `settings` and Usage `transactions`. `api-keys` and `tokens`
  // are deliberately absent: both resolve back INTO the overlay now that it
  // hosts a `tokens` tab again (see the `api-keys` case below).
  const ACCOUNT_SECTIONS: Record<string, string> = {
    organization: 'settings',
    billing: 'billing',
    usage: 'transactions',
    transactions: 'transactions',
    groups: 'groups',
    roles: 'roles',
    identity: 'identity',
    audit: 'audit',
    members: 'access-projects',
  };

  test('the mirror above is the whole map', () => {
    expect(Object.keys(ACCOUNT_GRADUATED).sort()).toEqual(Object.keys(ACCOUNT_SECTIONS).sort());
    expect(ACCOUNT_GRADUATED).toEqual(ACCOUNT_SECTIONS);
  });

  test('every id resolves to its account-page tab when an account id is supplied', () => {
    for (const [legacyId, tab] of Object.entries(ACCOUNT_SECTIONS)) {
      // `members` is the one non-generic id: it carries a `&project=`
      // special case (see `legacySectionRedirect`) so a stale
      // `/projects/<id>/members` bookmark lands pre-filtered to the project
      // it came from, not every project the account can see.
      const expected =
        legacyId === 'members'
          ? `/accounts/acc1?tab=${tab}&project=p1`
          : `/accounts/acc1?tab=${tab}`;
      expect(legacySectionRedirect('p1', legacyId, 'acc1')).toBe(expected);
    }
  });

  test('none of them is a settings tab, and none reopens the overlay', () => {
    for (const legacyId of Object.keys(ACCOUNT_SECTIONS)) {
      expect(SETTINGS_TABS).not.toContain(legacyId as never);
      expect(parseSettingsTab(legacyId)).toBeNull();
      expect(resolveSettingsOverlayHref(`/projects/p1/settings/${legacyId}`)).toEqual({
        opensOverlay: false,
      });
    }
  });

  // Without an account id there is no correct URL to build, so the function
  // returns null and the caller falls back — it must never guess. This is the
  // exact case `isAccountGraduatedSection` exists to let a caller detect and
  // WAIT on instead (see `use-account-section-redirect.ts`).
  test('with no account id, an account-scoped section resolves to null, never to a project URL', () => {
    for (const legacyId of Object.keys(ACCOUNT_SECTIONS)) {
      expect(legacySectionRedirect('p1', legacyId)).toBeNull();
      expect(isAccountGraduatedSection(legacyId)).toBe(true);
    }
  });

  /**
   * The credential split, 2026-08-18. `api-keys` and `tokens` both used to
   * resolve to `/accounts/<id>?tab=tokens`, because every credential lived on
   * that page. A person's own API keys are back in the overlay, so both ids
   * resolve there instead — `tokens` because it names a live tab again, and
   * `api-keys` because `RENAMED` carries the old name to the new one. Neither
   * needs an account id any more, which is the observable difference.
   */
  test('api-keys and tokens resolve INTO the overlay, with or without an account id', () => {
    for (const legacyId of ['api-keys', 'tokens']) {
      expect(isAccountGraduatedSection(legacyId)).toBe(false);
      expect(legacySectionRedirect('p1', legacyId)).toBe('/projects/p1/settings/tokens');
      expect(legacySectionRedirect('p1', legacyId, 'acc1')).toBe('/projects/p1/settings/tokens');
    }
  });

  test('`tokens` is a live settings tab; `api-keys` is only ever a redirect', () => {
    expect(parseSettingsTab('tokens')).toBe('tokens');
    // The rename is one-way: `api-keys` never becomes a tab id, so nothing
    // renders a pane for it and no rail row can claim it.
    expect(parseSettingsTab('api-keys')).toBeNull();
    expect(SETTINGS_TABS).not.toContain('api-keys' as never);
  });

  test('an account id does not divert a project-scoped section', () => {
    // The account branch is checked first, so a bug there would swallow every
    // other id. These must still resolve to their project URLs with an
    // account id in hand.
    expect(legacySectionRedirect('p1', 'skills', 'acc1')).toBe('/projects/p1/skills');
    expect(legacySectionRedirect('p1', 'schedules', 'acc1')).toBe('/projects/p1/triggers');
    expect(legacySectionRedirect('p1', 'nope', 'acc1')).toBeNull();
  });

  test('isAccountGraduatedSection is false for everything else', () => {
    for (const id of ['skills', 'files', 'schedules', 'nope', '', null, undefined]) {
      expect(isAccountGraduatedSection(id)).toBe(false);
    }
    // Not fooled by an inherited Object.prototype key — `Object.hasOwn`, not
    // `in`. `'constructor'` would otherwise report true and redirect to
    // `/accounts/acc1?tab=function Object() { … }`.
    expect(isAccountGraduatedSection('constructor')).toBe(false);
    expect(isAccountGraduatedSection('toString')).toBe(false);
    expect(legacySectionRedirect('p1', 'constructor', 'acc1')).toBeNull();
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
    expect(resolveSettingsOverlayHref('/projects/p1/settings/preferences')).toEqual({
      opensOverlay: true,
      tab: 'preferences',
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
