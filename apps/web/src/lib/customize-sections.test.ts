import { describe, expect, test } from 'bun:test';

import {
  CUSTOMIZE_SECTIONS,
  DEFAULT_CUSTOMIZE_SECTION,
  legacyCustomizeRedirect,
  parseCustomizeSection,
  resolveCustomizeOverlayHref,
} from './customize-sections';


/**
 * #6054 was put behind NEXT_PUBLIC_CAPABILITY_PAGES, so three of the
 * assertions below are flag-dependent. They assert the ON position — the
 * behaviour #6054 shipped — and `capability-pages.test.ts` covers OFF plus
 * both positions of every other entry point.
 */
function withCapabilityPages<T>(on: boolean, fn: () => T): T {
  const previous = process.env.NEXT_PUBLIC_CAPABILITY_PAGES;
  process.env.NEXT_PUBLIC_CAPABILITY_PAGES = String(on);
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_CAPABILITY_PAGES;
    else process.env.NEXT_PUBLIC_CAPABILITY_PAGES = previous;
  }
}

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

  test('connectors, skills, and commands are overlay sections again', () => {
    // They graduated in #6054 and came back when it was flagged off: the
    // overlay has to be able to host them, or a deep link with the flag off
    // resolves to nothing and reopens on the last-viewed section.
    for (const section of ['connectors', 'skills', 'commands'] as const) {
      expect(CUSTOMIZE_SECTIONS).toContain(section);
      expect(parseCustomizeSection(section)).toBe(section);
    }
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
  test('routes the graduated sections to their own pages when the flag is ON', () => {
    withCapabilityPages(true, () => {
      expect(legacyCustomizeRedirect('p1', 'connectors')).toBe('/projects/p1/connectors');
      expect(legacyCustomizeRedirect('p1', 'skills')).toBe('/projects/p1/skills');
    });
  });
  test('commands stays in the overlay — its standalone page was removed', () => {
    // Commands had a #6054 standalone page that was deleted, so the deep link
    // must never bounce to /projects/<id>/commands (a dead route). It falls
    // through to the overlay in both flag positions.
    withCapabilityPages(true, () => {
      expect(legacyCustomizeRedirect('p1', 'commands')).toBeNull();
    });
    withCapabilityPages(false, () => {
      expect(legacyCustomizeRedirect('p1', 'commands')).toBeNull();
    });
  });
  test('leaves overlay sections alone', () => {
    expect(legacyCustomizeRedirect('p1', 'agents')).toBeNull();
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
    expect(resolveCustomizeOverlayHref('/projects/p1/customize/agents')).toEqual({
      opensOverlay: true,
      section: 'agents',
    });
    expect(resolveCustomizeOverlayHref('/projects/p1/customize/secrets?tab=x')).toEqual({
      opensOverlay: true,
      section: 'secrets',
    });
  });

  test('a graduated or unknown segment does NOT open the overlay — the regression tripwire', () => {
    // This is the exact bug this function exists to prevent: before the fix,
    // an unresolvable segment fell back to `openCustomize(undefined)`, which
    // silently opened the overlay on whatever section the user last viewed
    // instead of navigating anywhere.
    withCapabilityPages(true, () => {
      expect(resolveCustomizeOverlayHref('/projects/p1/customize/skills')).toEqual({
        opensOverlay: false,
      });
      // Commands is no longer a capability section (its standalone page was
      // removed), so a /customize/commands deep link opens the overlay on the
      // commands section — it must NOT navigate to a dead route.
      expect(resolveCustomizeOverlayHref('/projects/p1/customize/commands')).toEqual({
        opensOverlay: true,
        section: 'commands',
      });
    });
    expect(resolveCustomizeOverlayHref('/projects/p1/customize/nope')).toEqual({
      opensOverlay: false,
    });
    expect(resolveCustomizeOverlayHref('/projects/p1/customize/nonsense')).toEqual({
      opensOverlay: false,
    });
  });
});
