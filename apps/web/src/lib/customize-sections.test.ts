import { describe, expect, test } from 'bun:test';

import {
  CUSTOMIZE_SECTIONS,
  DEFAULT_CUSTOMIZE_SECTION,
  parseCustomizeSection,
} from './customize-sections';

describe('customize sections', () => {
  test('files is not a customize section — it lives on the standalone files page', () => {
    expect(parseCustomizeSection('files')).toBeNull();
    expect(CUSTOMIZE_SECTIONS).not.toContain('files');
    expect(DEFAULT_CUSTOMIZE_SECTION).not.toBe('files');
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
