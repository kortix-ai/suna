import { describe, expect, test } from 'bun:test';

import {
  WORKSPACE_SETTINGS_LABELS,
  WORKSPACE_SETTINGS_SECTION_ALIASES,
  WORKSPACE_SETTINGS_SECTIONS,
  parseWorkspaceSettingsSection,
  workspaceSettingsPath,
} from './workspace-settings';

describe('workspace settings registry', () => {
  test('every section has one label and appears once', () => {
    expect(new Set(WORKSPACE_SETTINGS_SECTIONS).size).toBe(WORKSPACE_SETTINGS_SECTIONS.length);
    expect(Object.keys(WORKSPACE_SETTINGS_LABELS).sort()).toEqual([...WORKSPACE_SETTINGS_SECTIONS].sort());
  });

  test('every alias names a current section and never shadows one', () => {
    for (const [alias, section] of Object.entries(WORKSPACE_SETTINGS_SECTION_ALIASES)) {
      expect(WORKSPACE_SETTINGS_SECTIONS).toContain(section);
      expect(WORKSPACE_SETTINGS_SECTIONS as readonly string[]).not.toContain(alias);
    }
  });

  test('parse resolves current ids, old ids and nothing else', () => {
    expect(parseWorkspaceSettingsSection('members')).toBe('members');
    expect(parseWorkspaceSettingsSection(' Access ')).toBe('members');
    expect(parseWorkspaceSettingsSection('tokens')).toBe('api-keys');
    expect(parseWorkspaceSettingsSection('loops')).toBe('triggers');
    expect(parseWorkspaceSettingsSection('toString')).toBeNull();
    expect(parseWorkspaceSettingsSection('nope')).toBeNull();
    expect(parseWorkspaceSettingsSection('')).toBeNull();
    expect(parseWorkspaceSettingsSection(undefined)).toBeNull();
  });

  test('path is /workspaces/<id>/admin[/<section>]', () => {
    const id = '0b6e4c1a-7f2d-4a8e-9c3b-1d2e3f4a5b6c';
    expect(workspaceSettingsPath(id)).toBe(`/workspaces/${id}/admin`);
    expect(workspaceSettingsPath(id, 'api-keys')).toBe(`/workspaces/${id}/admin/api-keys`);
  });
});
