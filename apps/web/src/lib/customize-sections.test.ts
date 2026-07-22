import { describe, expect, test } from 'bun:test';

import {
  CUSTOMIZE_SECTIONS,
  DEFAULT_CUSTOMIZE_SECTION,
  legacyCustomizeFilesRedirect,
  parseCustomizeSection,
} from './customize-sections';

describe('customize sections', () => {
  test('files is not a customize section — it lives on the standalone files page', () => {
    expect(parseCustomizeSection('files')).toBeNull();
    expect(CUSTOMIZE_SECTIONS).not.toContain('files');
    expect(DEFAULT_CUSTOMIZE_SECTION).not.toBe('files');
  });

  test('git replaces the legacy changes and dev sections', () => {
    expect(CUSTOMIZE_SECTIONS).toContain('git');
    expect(CUSTOMIZE_SECTIONS).not.toContain('changes');
    expect(CUSTOMIZE_SECTIONS).not.toContain('dev');
  });

  test('redirects legacy files and changes links into the standalone files surface', () => {
    expect(legacyCustomizeFilesRedirect('project-1', 'files')).toBe('/projects/project-1/files');
    expect(legacyCustomizeFilesRedirect('project-1', 'changes')).toBe(
      '/projects/project-1/files?panel=proposed-changes',
    );
    expect(legacyCustomizeFilesRedirect('project-1', 'git')).toBeNull();
  });

  test('parses every canonical section and rejects unknowns', () => {
    for (const section of CUSTOMIZE_SECTIONS) {
      expect(parseCustomizeSection(section)).toBe(section);
    }
    expect(parseCustomizeSection('nonsense')).toBeNull();
    expect(parseCustomizeSection(null)).toBeNull();
    expect(parseCustomizeSection(undefined)).toBeNull();
  });

  test('channels is not a customize section — it was folded into Connectors', () => {
    expect(CUSTOMIZE_SECTIONS).not.toContain('channels');
    // Legacy deep links (`/customize/channels`, `?section=channels`) still
    // resolve — to the merged Connectors surface, not a blank/reset panel.
    expect(parseCustomizeSection('channels')).toBe('connectors');
  });
});
