import { describe, expect, it } from 'vitest';

import { resolveGrepFilters, resolveVideoMode } from '../playwright.config';

describe('browser lane grep filters', () => {
  it('runs every journey when no filter is named: there is no quarantine tag', () => {
    const { grep, grepInvert } = resolveGrepFilters({});
    expect(grep).toBeUndefined();
    expect(grepInvert).toBeUndefined();
  });

  it('excludes a named tag', () => {
    const { grep, grepInvert } = resolveGrepFilters({ E2E_EXCLUDE_TAGS: '@slow' });
    expect(grep).toBeUndefined();
    expect(grepInvert?.source).toBe('@slow');
    expect(grepInvert?.test('17 — OAuth provider initiation @slow')).toBe(true);
    expect(grepInvert?.test('09 - Admin console › admin opens the current overview')).toBe(false);
  });

  it('selects only a named tag', () => {
    const { grep, grepInvert } = resolveGrepFilters({ E2E_INCLUDE_TAGS: '@slow' });
    expect(grepInvert).toBeUndefined();
    expect(grep?.test('17 — OAuth provider initiation @slow')).toBe(true);
    expect(grep?.test('19 — Feature flags UI › lists every available flag')).toBe(false);
  });

  it('escapes each tag so a list entry is never read as a regex', () => {
    const { grepInvert } = resolveGrepFilters({ E2E_EXCLUDE_TAGS: '@slow, @slow(deployed)' });
    expect(grepInvert?.source).toBe('@slow|@slow\\(deployed\\)');
    expect(grepInvert?.test('journey @slow(deployed)')).toBe(true);
    expect(grepInvert?.test('journey @slo')).toBe(false);
  });

  it('unions the raw regex escape hatch with the tag list', () => {
    const { grepInvert } = resolveGrepFilters({
      E2E_EXCLUDE_TAGS: '@slow',
      E2E_GREP_INVERT: '^17 —',
    });
    expect(grepInvert?.source).toBe('@slow|^17 —');
    expect(grepInvert?.test('17 — OAuth provider initiation')).toBe(true);
  });

  it('a deployed target leaves out @local-only journeys, so the strict lane never sees them skip', () => {
    // KE2E_TARGET is set only for deployed lanes. A journey that writes into
    // a local bare repository or straight into the database cannot run there;
    // a runtime test.skip would fail the strict release lane after the run.
    const { grepInvert } = resolveGrepFilters({ KE2E_TARGET: 'staging' });
    expect(grepInvert?.test('42 — Files lists the whole repository @local-only')).toBe(true);
    expect(grepInvert?.test('09 - Admin console › admin opens the current overview')).toBe(false);
  });

  it('the local stack still runs @local-only journeys', () => {
    const { grepInvert } = resolveGrepFilters({});
    expect(grepInvert?.test('42 — Files lists the whole repository @local-only') ?? false).toBe(false);
  });

  it('ignores empty and whitespace-only entries', () => {
    const { grep, grepInvert } = resolveGrepFilters({ E2E_EXCLUDE_TAGS: '  ,, ', E2E_GREP: '' });
    expect(grep).toBeUndefined();
    expect(grepInvert).toBeUndefined();
  });
});

describe('browser journey replays', () => {
  it('records every journey in CI and only failures locally', () => {
    expect(resolveVideoMode({ CI: 'true' })).toBe('on');
    expect(resolveVideoMode({})).toBe('retain-on-failure');
  });
});
