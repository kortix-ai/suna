import { describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The hero's video sources are string literals pointing at files in `public/`.
 * Nothing links the two, so an encode that gets renamed or dropped fails
 * silently in dev — the poster keeps painting and the video simply never
 * plays. That is exactly how a dead `-1920.webm` reference survived a tier
 * being deleted, and how a light-only asset set survived a dark theme landing.
 *
 * These read the paths straight out of `hero-surfaces.tsx` rather than
 * importing it, because the module is a client component pulling in Phosphor,
 * next/image and the design system — none of which a file-existence check
 * needs. The source text is the contract.
 */

const HERO = join(import.meta.dir, 'hero-surfaces.tsx');
const PUBLIC = join(import.meta.dir, '../../../public');

const source = readFileSync(HERO, 'utf8');

/** Every `/media/...` literal the hero declares, in source order. */
function mediaPaths(): string[] {
  return [...source.matchAll(/'(\/media\/[^']+)'/g)].map((m) => m[1]);
}

describe('hero media', () => {
  test('every referenced file exists in public/', () => {
    const missing = mediaPaths().filter((p) => {
      try {
        return !statSync(join(PUBLIC, p)).isFile();
      } catch {
        return true;
      }
    });
    expect(missing, `referenced but not on disk:\n${missing.join('\n')}`).toEqual([]);
  });

  test('no referenced file is empty', () => {
    const empty = mediaPaths().filter((p) => {
      try {
        return statSync(join(PUBLIC, p)).size === 0;
      } catch {
        return false;
      }
    });
    expect(empty).toEqual([]);
  });

  /**
   * The whole point of the dark captures: a light-only set renders a bright
   * rectangle on a dark page. If someone adds a light encode they have to add
   * its dark twin, and this is what says so.
   */
  test('every light encode has a dark twin, and vice versa', () => {
    const paths = mediaPaths();
    const light = paths.filter((p) => !p.includes('-dark-'));
    const dark = new Set(paths.filter((p) => p.includes('-dark-')));

    const orphanedLight = light.filter((p) => {
      // kortix-showcase-1920.mp4 -> kortix-showcase-dark-1920.mp4
      const twin = p.replace(/\/(kortix-(?:showcase|cli))-/, '/$1-dark-');
      return twin !== p && !dark.has(twin);
    });
    expect(orphanedLight, `light encodes with no dark twin:\n${orphanedLight.join('\n')}`).toEqual(
      [],
    );

    const orphanedDark = [...dark].filter((p) => !light.includes(p.replace('-dark-', '-')));
    expect(orphanedDark, `dark encodes with no light twin:\n${orphanedDark.join('\n')}`).toEqual([]);
  });

  /**
   * A `<video>` resolves its `<source>` list once, at load. Keying the element
   * on the resolved theme is what makes a mid-session toggle swap the file;
   * a `prefers-color-scheme` media query on `<source>` would be right on first
   * paint and wrong for the rest of the session.
   */
  test('the video elements are keyed on theme, not on a colour-scheme media query', () => {
    expect(source).toContain('key={theme}');
    expect(source).not.toMatch(/media="\(prefers-color-scheme/);
  });
});
