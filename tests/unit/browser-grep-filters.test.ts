import { describe, expect, it } from 'vitest';

import { resolveGrepFilters, resolveVideoMode } from '../playwright.config';

describe('browser lane grep filters', () => {
  it('excludes quarantine by DEFAULT, so no blocking gate needs its own command line', () => {
    // A gate that names nothing still must not be blocked by a journey the
    // team has quarantined. tests.yml (the PR gate) sets no E2E_* vars at all,
    // and every quarantined journey ran there and failed the build.
    const { grep, grepInvert } = resolveGrepFilters({});
    expect(grep).toBeUndefined();
    expect(grepInvert?.source).toBe('@quarantine');
    expect(grepInvert?.test('08 — Accounts, invites, and project access @quarantine')).toBe(true);
    expect(grepInvert?.test('09 - Admin console › admin opens the current overview')).toBe(false);
  });

  it('never injects the default over an explicit include — the nightly lane still runs them', () => {
    const { grep, grepInvert } = resolveGrepFilters({ E2E_INCLUDE_TAGS: '@quarantine' });
    expect(grepInvert).toBeUndefined();
    expect(grep?.test('08 — Accounts, invites, and project access @quarantine')).toBe(true);
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

  it('a deployed target leaves out @local-only journeys, so the strict lane never sees them skip', () => {
    // KE2E_TARGET is set only for deployed lanes. A journey that writes into
    // a local bare repository or straight into the database cannot run there;
    // a runtime test.skip would fail the strict release lane after the run.
    const { grepInvert } = resolveGrepFilters({ KE2E_TARGET: 'staging', E2E_EXCLUDE_TAGS: '@quarantine' });
    expect(grepInvert?.test('42 — Files lists the whole repository @local-only')).toBe(true);
    expect(grepInvert?.test('17 — OAuth provider initiation @quarantine')).toBe(true);
    expect(grepInvert?.test('09 - Admin console › admin opens the current overview')).toBe(false);
  });

  it('the local stack still runs @local-only journeys', () => {
    const { grepInvert } = resolveGrepFilters({});
    expect(grepInvert?.test('42 — Files lists the whole repository @local-only')).toBe(false);
  });

  it('ignores empty and whitespace-only entries, keeping only the quarantine default', () => {
    const { grep, grepInvert } = resolveGrepFilters({ E2E_EXCLUDE_TAGS: '  ,, ', E2E_GREP: '' });
    expect(grep).toBeUndefined();
    expect(grepInvert?.source).toBe('@quarantine');
  });
});

describe('browser journey replays', () => {
  it('records every journey in CI and only failures locally', () => {
    expect(resolveVideoMode({ CI: 'true' })).toBe('on');
    expect(resolveVideoMode({})).toBe('retain-on-failure');
  });
});
