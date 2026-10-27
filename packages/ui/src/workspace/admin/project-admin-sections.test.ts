import { beforeEach, describe, expect, test } from 'bun:test';

import { ALL_PROJECT_SETTINGS_SECTIONS } from '../../customize/project-settings/project-settings-sections';
import { buildStandaloneCapabilityNav } from '../../customize/shared/standalone-settings-nav';
import { useSettingsPanelStore } from '../../internal/stores/settings-panel-store';

import { buildProjectAdminNav } from './project-admin-nav';
import {
  DEFAULT_PROJECT_ADMIN_SECTION,
  parseProjectAdminSection,
  PROJECT_ADMIN_RESOURCES,
  projectAdminHref,
  projectAdminNavTarget,
  type ProjectAdminSectionKey,
} from './project-admin-sections';

const PID = 'project-test-1';

describe('Project admin /admin/<section> scheme', () => {
  test('every resource and every settings section is a deep link that parses back', () => {
    const keys = [...PROJECT_ADMIN_RESOURCES.map((r) => r.key), ...ALL_PROJECT_SETTINGS_SECTIONS.map((s) => s.key)];
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      const href = projectAdminHref(PID, key as ProjectAdminSectionKey);
      const section = new URL(href, 'https://x.invalid').pathname.split('/').at(-1);
      expect(parseProjectAdminSection(section)).toBe(key as ProjectAdminSectionKey);
    }
  });

  test('the default section is the first resource', () => {
    expect(DEFAULT_PROJECT_ADMIN_SECTION).toBe(PROJECT_ADMIN_RESOURCES[0]!.key);
    expect(projectAdminHref(PID)).toBe(`/projects/${PID}/admin/connectors`);
    expect(projectAdminHref(PID, 'git')).toBe(`/projects/${PID}/admin/git`);
    expect(projectAdminHref(PID, 'repo')).toBe(`/projects/${PID}/admin/repo`);
    expect(projectAdminHref(PID, 'connectors', { scope: 'channels' })).toBe(
      `/projects/${PID}/admin/connectors?scope=channels`,
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
    expect(projectAdminNavTarget('reminders')).toBe('loops');
    expect(projectAdminNavTarget('experimental')).toBe('feature-flags');
    expect(projectAdminNavTarget('snapshots')).toBe('sandbox');
    expect(projectAdminNavTarget('settings')).toBe('general');
    expect(projectAdminNavTarget('members')).toBeNull();
    expect(projectAdminNavTarget('profile')).toBeNull();
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
      `/projects/${PID}/admin/connectors?scope=channels`,
      `/projects/${PID}/admin/models`,
      `/projects/${PID}/admin/feature-flags`,
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
