import { beforeEach, describe, expect, test } from 'bun:test';

import { ALL_PROJECT_SETTINGS_SECTIONS } from '../../customize/project-settings/project-settings-sections';
import { buildStandaloneCapabilityNav } from '../../customize/shared/standalone-settings-nav';
import { useSettingsPanelStore } from '../../internal/stores/settings-panel-store';

import { buildProjectAdminNav } from './project-admin-nav';
import {
  ACCOUNT_TAB_FOR_SECTION,
  DEFAULT_PROJECT_ADMIN_SECTION,
  parseProjectAdminSection,
  PROJECT_ADMIN_RESOURCES,
  projectAdminHref,
  projectAdminNavTarget,
  SECTION_FOR_ACCOUNT_TAB,
  sectionLabelKey,
  WORKSPACE_SETTINGS_GROUPS,
  type ProjectAdminSectionKey,
} from '../../customize/project-settings/project-admin-sections';
import { VALID_TABS } from '../../internal/account-hub/sections';
import en from '../../i18n/en';
import {
  WORKSPACE_SETTINGS_GROUP_LABELS,
  WORKSPACE_SETTINGS_GROUPS as REGISTRY_GROUPS,
  WORKSPACE_SETTINGS_LABELS,
  WORKSPACE_SETTINGS_SECTIONS,
} from '@kortix/shared/workspace-settings';

const PID = 'project-test-1';

describe('Project admin /admin/<section> scheme', () => {
  test('every resource and every settings section is a deep link that parses back', () => {
    const keys = [
      ...PROJECT_ADMIN_RESOURCES.map((r) => r.key),
      ...ALL_PROJECT_SETTINGS_SECTIONS.map((s) => s.key).filter((key) => key !== 'review'),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      const href = projectAdminHref(PID, key as ProjectAdminSectionKey);
      const section = new URL(href, 'https://x.invalid').pathname.split('/').at(-1);
      expect(parseProjectAdminSection(section)).toBe(key as ProjectAdminSectionKey);
    }
  });

  test('the default section is General, the first row of the Workspace group', () => {
    expect(DEFAULT_PROJECT_ADMIN_SECTION).toBe('general');
    expect(WORKSPACE_SETTINGS_GROUPS[0]!.sections[0]).toBe('general');
    expect(projectAdminHref(PID)).toBe(`/workspaces/${PID}/admin/general`);
    expect(projectAdminHref(PID, 'git')).toBe(`/workspaces/${PID}/admin/git`);
    expect(projectAdminHref(PID, 'repo')).toBe(`/workspaces/${PID}/admin/repo`);
    expect(projectAdminHref(PID, 'connectors', { scope: 'channels' })).toBe(
      `/workspaces/${PID}/admin/connectors?scope=channels`,
    );
  });

  test('unknown, empty and non-listed values parse to null', () => {
    expect(parseProjectAdminSection(null)).toBeNull();
    expect(parseProjectAdminSection('')).toBeNull();
    expect(parseProjectAdminSection('not-a-section')).toBeNull();
    // Review is its own surface, never a section of this page.
    expect(parseProjectAdminSection('review')).toBeNull();
  });

  test('legacy overlay ids land on the section that owns them', () => {
    expect(projectAdminNavTarget('llm-providers')).toBe('models');
    expect(projectAdminNavTarget('channels')).toBe('connectors');
    expect(projectAdminNavTarget('reminders')).toBe('triggers');
    // `/admin/loops` was the Loops page: loops are triggers, on one page.
    expect(parseProjectAdminSection('loops')).toBe('triggers');
    expect(projectAdminNavTarget('experimental')).toBe('feature-flags');
    expect(projectAdminNavTarget('snapshots')).toBe('sandbox');
    expect(projectAdminNavTarget('flags')).toBe('feature-flags');
    expect(projectAdminNavTarget('danger')).toBe('danger-zone');
    expect(projectAdminNavTarget('settings')).toBe('general');
    expect(projectAdminNavTarget('members')).toBeNull();
    expect(projectAdminNavTarget('profile')).toBeNull();
  });
});

describe('Workspace settings rail — the shared registry', () => {
  test('the rail is the registry: Workspace, Library, People, Billing, Advanced, Danger zone, Support', () => {
    expect(WORKSPACE_SETTINGS_GROUPS).toBe(REGISTRY_GROUPS);
    expect(WORKSPACE_SETTINGS_GROUPS.map((group) => [group.id, [...group.sections]])).toEqual([
      ['workspace', ['general', 'security', 'branding', 'api-keys', 'capture']],
      ['library', ['models', 'connectors', 'secrets', 'skills', 'drives', 'apps', 'triggers', 'sandbox', 'git', 'repo']],
      ['people', ['members', 'groups', 'roles', 'identity', 'audit']],
      ['billing', ['plan', 'usage']],
      ['advanced', ['feature-flags']],
      ['danger', ['danger-zone']],
      ['support', ['help']],
    ]);
  });

  test('every rail row is a deep link that parses back, and no row is listed twice', () => {
    const rows = WORKSPACE_SETTINGS_GROUPS.flatMap((group) => group.sections);
    expect(new Set(rows).size).toBe(rows.length);
    for (const key of rows) expect(parseProjectAdminSection(key)).toBe(key);
  });

  test('old section ids land on the section that owns them now', () => {
    expect(parseProjectAdminSection('access')).toBe('members');
    expect(parseProjectAdminSection('access-projects')).toBe('members');
    expect(parseProjectAdminSection('settings')).toBe('security');
    expect(parseProjectAdminSection('tokens')).toBe('api-keys');
    expect(parseProjectAdminSection('billing')).toBe('plan');
    expect(parseProjectAdminSection('credits')).toBe('plan');
    expect(parseProjectAdminSection('transactions')).toBe('usage');
    expect(parseProjectAdminSection('connected')).toBe('git');
  });

  test('every old account hub tab lands on a workspace section that shows that pane', () => {
    for (const tab of VALID_TABS) {
      const section = SECTION_FOR_ACCOUNT_TAB[tab];
      // Access merged into Members: its per-workspace grants render under the roster.
      const back = tab === 'access-projects' ? 'members' : tab;
      expect({ tab, section, back: ACCOUNT_TAB_FOR_SECTION[section] }).toEqual({ tab, section, back });
    }
    expect(SECTION_FOR_ACCOUNT_TAB.settings).toBe('security');
    expect(SECTION_FOR_ACCOUNT_TAB['access-projects']).toBe('members');
    expect(SECTION_FOR_ACCOUNT_TAB.billing).toBe('plan');
  });

  test('the en catalog holds the registry labels, word for word', () => {
    const sections = (en as { workspaces: { settings: { sections: Record<string, string>; groups: Record<string, string> } } })
      .workspaces.settings;
    for (const section of WORKSPACE_SETTINGS_SECTIONS) {
      expect({ section, label: sections.sections[sectionLabelKey(section)] }).toEqual({
        section,
        label: WORKSPACE_SETTINGS_LABELS[section],
      });
    }
    for (const group of REGISTRY_GROUPS) {
      expect({ group: group.id, label: sections.groups[group.id] }).toEqual({
        group: group.id,
        label: WORKSPACE_SETTINGS_GROUP_LABELS[group.id],
      });
    }
  });
});

describe('buildProjectAdminNav', () => {
  beforeEach(() => {
    useSettingsPanelStore.setState({ open: false, membersTab: 'people' });
  });

  function navFor(section: ProjectAdminSectionKey) {
    const pushed: string[] = [];
    const navigateTo = (href: string) => pushed.push(href);
    const nav = buildProjectAdminNav({ projectId: PID, section, membersTab: 'people', navigateTo });
    return { nav, pushed, navigateTo };
  }

  test('a pane id that names a section of this page stays on this page', () => {
    const { nav, pushed } = navFor('general');
    nav.navigate('channels');
    nav.navigate('llm-providers');
    nav.navigate('experimental');
    expect(pushed).toEqual([
      `/workspaces/${PID}/admin/connectors?scope=channels`,
      `/workspaces/${PID}/admin/models`,
      `/workspaces/${PID}/admin/feature-flags`,
    ]);
  });

  test('the section already open pushes nothing, and a membersTab intent is still written', () => {
    const { nav, pushed } = navFor('models');
    nav.navigate('llm-providers', { membersTab: 'invite' });
    expect(pushed).toEqual([]);
    expect(useSettingsPanelStore.getState().membersTab).toBe('invite');
  });

  test('an id that is not a section here resolves the way a standalone page resolves it', () => {
    const { nav, pushed } = navFor('general');
    nav.navigate('members');
    const expected: string[] = [];
    buildStandaloneCapabilityNav({
      projectId: PID,
      activeTab: 'general',
      membersTab: 'people',
      navigateTo: (href) => expected.push(href),
    }).navigate('members');
    expect(expected.length).toBe(1);
    expect(pushed).toEqual(expected);
  });
});
