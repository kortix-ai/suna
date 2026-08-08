import { describe, expect, test } from 'bun:test';

import {
  CUSTOMIZE_SECTIONS,
  DEFAULT_CUSTOMIZE_SECTION,
  legacyCustomizeRedirect,
  parseCustomizeSection,
  resolveCustomizeOverlayHref,
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

  test('connectors and skills graduated out of the overlay', () => {
    expect(CUSTOMIZE_SECTIONS).not.toContain('connectors');
    expect(CUSTOMIZE_SECTIONS).not.toContain('skills');
    expect(parseCustomizeSection('connectors')).toBeNull();
    expect(parseCustomizeSection('skills')).toBeNull();
  });

  test('commands remains in the overlay because its standalone page was removed', () => {
    expect(CUSTOMIZE_SECTIONS).toContain('commands');
    expect(parseCustomizeSection('commands')).toBe('commands');
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
  });

  test('commands stays in the overlay — its standalone page was removed', () => {
    // Commands had a #6054 standalone page that #6169 deleted, so the deep
    // link must never bounce to /projects/<id>/commands (a dead route). It
    // resolves inside the overlay instead — see the resolve test below.
    expect(legacyCustomizeRedirect('p1', 'commands')).toBeNull();
  });

  test('agents redirects to its standalone page, under either spelling', () => {
    // Agents graduated to /projects/<id>/agent. The overlay section was named
    // 'agents', so both spellings have to land — every bookmark in the wild
    // points at the plural one.
    expect(legacyCustomizeRedirect('p1', 'agents')).toBe('/projects/p1/agent');
    expect(legacyCustomizeRedirect('p1', 'agent')).toBe('/projects/p1/agent');
  });

  test('leaves overlay sections alone', () => {
    expect(legacyCustomizeRedirect('p1', 'secrets')).toBeNull();
    expect(legacyCustomizeRedirect('p1', null)).toBeNull();
  });
});

describe('resolveCustomizeOverlayHref', () => {
  test('a non-customize href never opens the overlay', () => {
    expect(resolveCustomizeOverlayHref('/projects/p1/skills')).toEqual({ opensOverlay: false });
    expect(resolveCustomizeOverlayHref('/projects/p1/sessions')).toEqual({ opensOverlay: false });
  });

  test('a bare /customize href opens the overlay on the default (undefined) section', () => {
    expect(resolveCustomizeOverlayHref('/projects/p1/customize')).toEqual({
      opensOverlay: true,
      section: undefined,
    });
  });

  test('a named segment that resolves to a real section opens the overlay on it', () => {
    expect(resolveCustomizeOverlayHref('/projects/p1/customize/members')).toEqual({
      opensOverlay: true,
      section: 'members',
    });
    expect(resolveCustomizeOverlayHref('/projects/p1/customize/secrets?tab=x')).toEqual({
      opensOverlay: true,
      section: 'secrets',
    });
    // Commands came back INTO the overlay when #6169 deleted its standalone
    // page, so unlike skills/connectors/agents its deep link resolves here.
    expect(resolveCustomizeOverlayHref('/projects/p1/customize/commands')).toEqual({
      opensOverlay: true,
      section: 'commands',
    });
  });

  test('a graduated or unknown segment does NOT open the overlay — the regression tripwire', () => {
    // This is the exact bug this function exists to prevent: before the fix,
    // an unresolvable segment fell back to `openCustomize(undefined)`, which
    // silently opened the overlay on whatever section the user last viewed
    // instead of navigating anywhere.
    expect(resolveCustomizeOverlayHref('/projects/p1/customize/skills')).toEqual({
      opensOverlay: false,
    });
    // Agents graduated too — `/customize/agents` must fall through to a
    // navigation (legacyCustomizeRedirect sends it to /projects/<id>/agent),
    // not reopen the overlay on the user's last section.
    expect(resolveCustomizeOverlayHref('/projects/p1/customize/agents')).toEqual({
      opensOverlay: false,
    });
    expect(resolveCustomizeOverlayHref('/projects/p1/customize/connectors')).toEqual({
      opensOverlay: false,
    });
    expect(resolveCustomizeOverlayHref('/projects/p1/customize/nonsense')).toEqual({
      opensOverlay: false,
    });
  });
});
