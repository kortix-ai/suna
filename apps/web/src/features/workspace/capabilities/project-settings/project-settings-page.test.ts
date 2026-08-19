import { beforeEach, describe, expect, test } from 'bun:test';

import { useSettingsPanelStore } from '@/stores/settings-panel-store';

import {
  buildProjectSettingsNav,
  projectCapabilityNavHref,
  projectCapabilityNavTarget,
  projectSettingsNavTarget,
} from './project-settings-page';

/**
 * `/projects/[id]/config` is the SECOND host of `SettingsNav` — the context
 * `features/workspace/shared/settings-nav-context.tsx` was deliberately kept
 * panel-agnostic for. The panes it still mounts (General, the Sandbox/Snapshots
 * pair) speak the settings overlay's vocabulary, so the adapter's whole job is
 * translating that vocabulary into one of THREE destinations: a section on
 * this page, a sibling top-level Customize tab (Models/Channels/Secrets/Members
 * graduated a second time — see `projectCapabilityNavTarget`), or an overlay
 * open for the tabs that stayed behind (`profile`/`preferences`/`connected`).
 *
 * `navigate` writes through the real store, same idiom as
 * `stores/settings-panel-store.test.ts`, so these reset it between tests
 * rather than mocking it.
 */
function navFor(
  section: Parameters<typeof buildProjectSettingsNav>[0]['section'] = 'general',
  accountId?: string,
) {
  const pushed: string[] = [];
  const nav = buildProjectSettingsNav({
    projectId: 'p1',
    section,
    membersTab: useSettingsPanelStore.getState().membersTab,
    accountId,
    navigateTo: (href) => pushed.push(href),
  });
  return { nav, pushed };
}

beforeEach(() => {
  useSettingsPanelStore.setState({ open: false, membersTab: 'people' });
});

describe('projectSettingsNavTarget', () => {
  test('a section key names itself', () => {
    expect(projectSettingsNavTarget('sandbox')).toBe('sandbox');
    expect(projectSettingsNavTarget('general')).toBe('general');
  });

  test('the renamed ids resolve under their old names', () => {
    expect(projectSettingsNavTarget('settings')).toBe('general');
    expect(projectSettingsNavTarget('experimental')).toBe('feature-flags');
  });

  test('git — the old nav vocabulary id for Repositories — lands on General now', () => {
    // `repositories` itself was never a `navigate()` vocabulary id, only a
    // `?section=` bookmark value; that redirect lives in `settings-tabs.ts`,
    // not here.
    expect(projectSettingsNavTarget('git')).toBe('general');
  });

  test('ids that graduated a second time, off this page, are not a section here', () => {
    expect(projectSettingsNavTarget('llm-management')).toBeNull();
    expect(projectSettingsNavTarget('channels')).toBeNull();
    expect(projectSettingsNavTarget('secrets')).toBeNull();
    expect(projectSettingsNavTarget('members')).toBeNull();
  });

  test('marketplace is not a section here — the product removed it, it did not move', () => {
    expect(projectSettingsNavTarget('marketplace')).toBeNull();
  });

  test('a tab that stayed in the overlay is not a section here', () => {
    expect(projectSettingsNavTarget('profile')).toBeNull();
    expect(projectSettingsNavTarget('preferences')).toBeNull();
    expect(projectSettingsNavTarget('nope')).toBeNull();
  });
});

describe('projectCapabilityNavTarget', () => {
  test('every legacy llm sub-section is the Models tab', () => {
    // The tab picks its own sub-tab; there is no route for one.
    for (const id of ['llm-management', 'llm-overview', 'llm-providers', 'llm-logs']) {
      expect(projectCapabilityNavTarget(id)).toBe('models');
    }
  });

  test('secrets and members name themselves', () => {
    expect(projectCapabilityNavTarget('secrets')).toBe('secrets');
    expect(projectCapabilityNavTarget('members')).toBe('members');
  });

  test('channels names the page it folded into, not itself', () => {
    // There is no Channels tab to name any more. The target is the PAGE;
    // `projectCapabilityNavHref` is what adds the scope that picks Channels
    // out of it, because `capabilityTabHref` builds paths without a query.
    expect(projectCapabilityNavTarget('channels')).toBe('connectors');
    expect(projectCapabilityNavHref('p1', 'channels', 'connectors')).toBe(
      '/projects/p1/connectors?scope=channels',
    );
    expect(projectCapabilityNavHref('p1', 'secrets', 'secrets')).toBe('/projects/p1/secrets');
  });

  test('anything this page owns, or the overlay owns, is not a capability target', () => {
    expect(projectCapabilityNavTarget('general')).toBeNull();
    expect(projectCapabilityNavTarget('profile')).toBeNull();
    expect(projectCapabilityNavTarget('marketplace')).toBeNull();
  });
});

describe('buildProjectSettingsNav', () => {
  test('reports the active section, and always reports itself open', () => {
    const { nav } = navFor('sandbox');
    expect(nav.activeTab).toBe('sandbox');
    // The page is a route, not an overlay — the panes that read `isOpen` only
    // ever mount while it is on screen.
    expect(nav.isOpen).toBe(true);
    expect(nav.llmProvidersTab).toBeUndefined();
  });

  test('navigate() to another section pushes its URL', () => {
    const { nav, pushed } = navFor('sandbox');
    nav.navigate('feature-flags');
    expect(pushed).toEqual(['/projects/p1/config?section=feature-flags']);
  });

  test('navigate("llm-providers") leaves this page entirely — Models is its own top-level tab now', () => {
    const { nav, pushed } = navFor('sandbox');
    nav.navigate('llm-providers');
    expect(pushed).toEqual(['/projects/p1/models']);
  });

  test('navigate("secrets") and navigate("channels") also leave this page', () => {
    const { nav, pushed } = navFor('sandbox');
    nav.navigate('secrets');
    nav.navigate('channels');
    expect(pushed).toEqual([
      '/projects/p1/secrets',
      // Channels keeps its scope across the hop. Pushing the bare Connectors
      // route would land a person who asked for Slack on the catalogue.
      '/projects/p1/connectors?scope=channels',
    ]);
  });

  test('navigate("members") also leaves this page — Members is its own top-level tab now', () => {
    // Members no longer has a section on this page at all, so unlike
    // Models/Channels/Secrets there is no "already active" case to skip:
    // navigating there from here always pushes, regardless of which section
    // is currently shown.
    const { nav, pushed } = navFor('sandbox');
    nav.navigate('members', { membersTab: 'people' });
    expect(pushed).toEqual(['/projects/p1/members']);
    expect(useSettingsPanelStore.getState().membersTab).toBe('people');
  });

  test('an explicit membersTab opt writes the intent to the live store', () => {
    const { nav } = navFor('sandbox');
    nav.navigate('members', { membersTab: 'invite' });
    expect(useSettingsPanelStore.getState().membersTab).toBe('invite');
  });

  test('omitting opts leaves the intent untouched', () => {
    useSettingsPanelStore.setState({ membersTab: 'invite' });
    const { nav } = navFor('sandbox');
    nav.navigate('models');
    expect(useSettingsPanelStore.getState().membersTab).toBe('invite');
  });

  test('navigate() to a tab that stayed in the overlay opens the overlay, not a route', () => {
    // `profile`/`preferences`/`connected` never had a section on this page —
    // what this pins is the rule — an id this page does not own is handed
    // to the overlay rather than pushed as a `?section=` that does not exist.
    const { nav, pushed } = navFor('sandbox');
    nav.navigate('preferences');
    expect(pushed).toEqual([]);
    expect(useSettingsPanelStore.getState().open).toBe(true);
    expect(useSettingsPanelStore.getState().tab).toBe('preferences');
  });

  test('navigate() to an id nobody owns does nothing at all', () => {
    const { nav, pushed } = navFor('sandbox');
    nav.navigate('marketplace');
    expect(pushed).toEqual([]);
    expect(useSettingsPanelStore.getState().open).toBe(false);
  });

  test('navigate() to an ACCOUNT_GRADUATED id (groups, roles) routes to the account page', () => {
    // Regression: Members' Access tab links "Create one in Groups" / "Create
    // one in Roles" through this same navigate() vocabulary. Before this
    // branch existed, `groups`/`roles` matched none of the three checks and
    // the click did nothing — reported live as "when I click the groups
    // link, it doesn't work either."
    const { nav, pushed } = navFor('sandbox', 'acct-1');
    nav.navigate('groups');
    expect(pushed).toEqual(['/accounts/acct-1?tab=groups']);
  });

  test('an ACCOUNT_GRADUATED id with no accountId yet does nothing, not a broken URL', () => {
    const { nav, pushed } = navFor('sandbox');
    nav.navigate('roles');
    expect(pushed).toEqual([]);
    expect(useSettingsPanelStore.getState().open).toBe(false);
  });
});
