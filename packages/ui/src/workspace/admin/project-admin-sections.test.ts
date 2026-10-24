import { describe, expect, test } from 'bun:test';

import { ALL_PROJECT_SETTINGS_SECTIONS } from '../../customize/project-settings/project-settings-sections';

import {
  DEFAULT_PROJECT_ADMIN_SECTION,
  parseProjectAdminSection,
  PROJECT_ADMIN_RESOURCES,
  projectAdminHref,
  projectAdminNavTarget,
} from './project-admin-sections';

const PID = 'project-test-1';

describe('Project admin ?section= scheme', () => {
  test('every resource and every settings section is a deep link that parses back', () => {
    const keys = [...PROJECT_ADMIN_RESOURCES.map((r) => r.key), ...ALL_PROJECT_SETTINGS_SECTIONS.map((s) => s.key)];
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      const href = projectAdminHref(PID, key);
      const section = new URL(href, 'https://x.invalid').searchParams.get('section');
      expect(parseProjectAdminSection(section ?? DEFAULT_PROJECT_ADMIN_SECTION)).toBe(key);
    }
  });

  test('the default section is the first resource and carries no query', () => {
    expect(DEFAULT_PROJECT_ADMIN_SECTION).toBe(PROJECT_ADMIN_RESOURCES[0]!.key);
    expect(projectAdminHref(PID)).toBe(`/projects/${PID}/admin`);
    expect(projectAdminHref(PID, 'git')).toBe(`/projects/${PID}/admin?section=git`);
    expect(projectAdminHref(PID, 'connectors', { scope: 'channels' })).toBe(
      `/projects/${PID}/admin?scope=channels`,
    );
  });

  test('unknown or empty values parse to null', () => {
    expect(parseProjectAdminSection(null)).toBeNull();
    expect(parseProjectAdminSection('')).toBeNull();
    expect(parseProjectAdminSection('not-a-section')).toBeNull();
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
