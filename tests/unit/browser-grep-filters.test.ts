import { describe, expect, it } from 'vitest';

import { resolveGrepFilters } from '../playwright.config';

describe('browser lane grep filters', () => {
  it('applies no filter when the environment names none', () => {
    expect(resolveGrepFilters({})).toEqual({});
  });

  it('excludes a quarantined tag for the blocking gate', () => {
    const { grep, grepInvert } = resolveGrepFilters({ E2E_EXCLUDE_TAGS: '@quarantine' });
    expect(grep).toBeUndefined();
    expect(grepInvert?.source).toBe('@quarantine');
    expect(grepInvert?.test('17 — OAuth provider initiation @quarantine')).toBe(true);
    expect(grepInvert?.test('09 - Admin console › admin opens the current overview')).toBe(false);
  });

  it('selects only the quarantined tag for the nightly lane', () => {
    const { grep, grepInvert } = resolveGrepFilters({ E2E_INCLUDE_TAGS: '@quarantine' });
    expect(grepInvert).toBeUndefined();
    expect(grep?.test('17 — OAuth provider initiation @quarantine')).toBe(true);
    expect(grep?.test('19 — Feature flags UI › lists every available flag')).toBe(false);
  });

  it('escapes each tag so a list entry is never read as a regex', () => {
    const { grepInvert } = resolveGrepFilters({ E2E_EXCLUDE_TAGS: '@quarantine, @slow(deployed)' });
    expect(grepInvert?.source).toBe('@quarantine|@slow\\(deployed\\)');
    expect(grepInvert?.test('journey @slow(deployed)')).toBe(true);
    expect(grepInvert?.test('journey @slowXdeployedX')).toBe(false);
  });

  it('unions the raw regex escape hatch with the tag list', () => {
    const { grepInvert } = resolveGrepFilters({
      E2E_EXCLUDE_TAGS: '@quarantine',
      E2E_GREP_INVERT: '^17 —',
    });
    expect(grepInvert?.source).toBe('@quarantine|^17 —');
    expect(grepInvert?.test('17 — OAuth provider initiation')).toBe(true);
  });

  it('ignores empty and whitespace-only entries', () => {
    expect(resolveGrepFilters({ E2E_EXCLUDE_TAGS: '  ,, ', E2E_GREP: '' })).toEqual({});
  });
});
