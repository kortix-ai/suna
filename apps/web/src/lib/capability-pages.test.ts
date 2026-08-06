/**
 * The #6054 kill-switch, in both positions.
 *
 * Marko asked for the regressed capability pages to be removed or flagged off
 * "until not optimal". A half-applied flag is worse than none: if the nav stops
 * linking to a page but the route still serves it, a bookmark or a stale
 * history entry still lands on the surface that was supposed to be hidden, and
 * whoever flipped the switch believes it worked.
 *
 * So these pin both directions at every entry point:
 *   OFF — nothing points at the pages, deep links open the overlay, and the
 *         three sections are overlay sections again.
 *   ON  — #6054 exactly as merged.
 *
 * Plain loops rather than `test.each`: the repo's `@types/bun` does not type
 * `test.each`, and the three files using it are a known `tsc` wart. No need for
 * a fourth.
 */
import { afterEach, describe, expect, test } from 'bun:test';

const KEY = 'NEXT_PUBLIC_CAPABILITY_PAGES';
const SECTIONS = ['connectors', 'skills', 'commands'] as const;
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

function setFlag(on: boolean | undefined) {
  if (on === undefined) delete process.env[KEY];
  else process.env[KEY] = String(on);
}

/** The modules read the flag per call, so one import serves both positions. */
async function mods() {
  return { ...(await import('./capability-pages')), ...(await import('./customize-sections')) };
}

describe('capabilityPagesEnabled', () => {
  test('defaults to OFF when unset', async () => {
    setFlag(undefined);
    expect((await mods()).capabilityPagesEnabled()).toBe(false);
  });

  test('an unset env must never expose the pages', async () => {
    // The whole point of the switch: a default of ON would mean a fresh deploy
    // silently ships the regressed surface.
    setFlag(undefined);
    const { capabilitySectionHref } = await mods();
    expect(capabilitySectionHref('p1', 'skills')).toBe('/projects/p1/customize/skills');
  });

  test('turns on explicitly', async () => {
    setFlag(true);
    expect((await mods()).capabilityPagesEnabled()).toBe(true);
  });
});

describe('where a capability section lives', () => {
  test('OFF points every section at the Customize overlay', async () => {
    setFlag(false);
    const { capabilitySectionHref } = await mods();
    for (const section of SECTIONS) {
      expect(capabilitySectionHref('p1', section)).toBe(`/projects/p1/customize/${section}`);
    }
  });

  test('ON points every section at its standalone page', async () => {
    setFlag(true);
    const { capabilitySectionHref } = await mods();
    for (const section of SECTIONS) {
      expect(capabilitySectionHref('p1', section)).toBe(`/projects/p1/${section}`);
    }
  });
});

describe('deep links into /customize/<section>', () => {
  test('OFF does NOT redirect them away from the overlay', async () => {
    setFlag(false);
    const { legacyCustomizeRedirect } = await mods();
    for (const section of SECTIONS) {
      expect(legacyCustomizeRedirect('p1', section)).toBeNull();
    }
  });

  test('ON redirects them to the standalone pages', async () => {
    setFlag(true);
    const { legacyCustomizeRedirect } = await mods();
    for (const section of SECTIONS) {
      expect(legacyCustomizeRedirect('p1', section)).toBe(`/projects/p1/${section}`);
    }
  });

  test('Files and Changes always redirect, in both positions', async () => {
    // They left the overlay in an earlier, unrelated change. This flag governs
    // #6054 only — sweeping them in would revert someone else's work.
    for (const on of [true, false]) {
      setFlag(on);
      const { legacyCustomizeRedirect } = await mods();
      expect(legacyCustomizeRedirect('p1', 'files')).toBe('/projects/p1/files');
      expect(legacyCustomizeRedirect('p1', 'changes')).toBe(
        '/projects/p1/files?panel=proposed-changes',
      );
    }
  });
});

describe('the overlay can host the sections again', () => {
  test('each one parses as a real overlay section', async () => {
    setFlag(false);
    const { parseCustomizeSection, CUSTOMIZE_SECTIONS } = await mods();
    for (const section of SECTIONS) {
      // Without this the deep-link page falls through to `openCustomize(undefined)`
      // and silently reopens on whatever section you last viewed.
      expect(parseCustomizeSection(section)).toBe(section);
      expect(CUSTOMIZE_SECTIONS).toContain(section);
    }
  });

  test('every overlay section has an access gate', async () => {
    // `CUSTOMIZE_SECTION_ACCESS` is a total Record over CustomizeSection, so
    // re-adding a section without a gate entry is a type error — and would
    // render that section ungated if the type were ever loosened.
    const { CUSTOMIZE_SECTIONS } = await mods();
    const { CUSTOMIZE_SECTION_ACCESS } = await import('./project-actions');
    for (const section of CUSTOMIZE_SECTIONS) {
      expect(CUSTOMIZE_SECTION_ACCESS[section]?.read).toBeTruthy();
    }
  });
});

describe('command-palette href resolution', () => {
  test('OFF opens the overlay', async () => {
    setFlag(false);
    const { resolveCustomizeOverlayHref } = await mods();
    for (const section of SECTIONS) {
      expect(resolveCustomizeOverlayHref(`/projects/p1/customize/${section}`)).toEqual({
        opensOverlay: true,
        section,
      });
    }
  });

  test('ON navigates instead, so the route can forward', async () => {
    setFlag(true);
    const { resolveCustomizeOverlayHref } = await mods();
    for (const section of SECTIONS) {
      expect(resolveCustomizeOverlayHref(`/projects/p1/customize/${section}`)).toEqual({
        opensOverlay: false,
      });
    }
  });

  test('a normal overlay section is unaffected by the flag', async () => {
    for (const on of [true, false]) {
      setFlag(on);
      const { resolveCustomizeOverlayHref } = await mods();
      expect(resolveCustomizeOverlayHref('/projects/p1/customize/agents')).toEqual({
        opensOverlay: true,
        section: 'agents',
      });
    }
  });
});
