import { describe, expect, test } from 'bun:test';

import {
  CUSTOMIZE_SECTIONS,
  DEFAULT_CUSTOMIZE_SECTION,
  legacyCustomizeRedirect,
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

  test('connectors, skills, and commands graduated out of the overlay', () => {
    expect(CUSTOMIZE_SECTIONS).not.toContain('connectors');
    expect(CUSTOMIZE_SECTIONS).not.toContain('skills');
    expect(CUSTOMIZE_SECTIONS).not.toContain('commands');
    expect(parseCustomizeSection('connectors')).toBeNull();
    expect(parseCustomizeSection('skills')).toBeNull();
    expect(parseCustomizeSection('commands')).toBeNull();
  });

  test('parses every canonical section and rejects unknowns', () => {
    for (const section of CUSTOMIZE_SECTIONS) {
      expect(parseCustomizeSection(section)).toBe(section);
    }
    expect(parseCustomizeSection('nonsense')).toBeNull();
    expect(parseCustomizeSection(null)).toBeNull();
    expect(parseCustomizeSection(undefined)).toBeNull();
  });
});

describe('legacyCustomizeRedirect', () => {
  test('keeps the existing files and changes redirects', () => {
    expect(legacyCustomizeRedirect('p1', 'files')).toBe('/projects/p1/files');
    expect(legacyCustomizeRedirect('p1', 'changes')).toBe(
      '/projects/p1/files?panel=proposed-changes',
    );
  });
  test('routes the graduated sections to their own pages', () => {
    expect(legacyCustomizeRedirect('p1', 'connectors')).toBe('/projects/p1/connectors');
    expect(legacyCustomizeRedirect('p1', 'skills')).toBe('/projects/p1/skills');
    expect(legacyCustomizeRedirect('p1', 'commands')).toBe('/projects/p1/commands');
  });
  test('leaves overlay sections alone', () => {
    expect(legacyCustomizeRedirect('p1', 'agents')).toBeNull();
    expect(legacyCustomizeRedirect('p1', null)).toBeNull();
  });
});
