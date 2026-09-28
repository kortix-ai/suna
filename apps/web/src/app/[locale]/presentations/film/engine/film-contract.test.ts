import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BAR, BEAT, BPM, FPS } from './time';

/**
 * Picture and sound are built by two programs: the film in TypeScript, the
 * score in `scripts/film/soundtrack.py`. Nothing links them but these numbers,
 * so a tempo change on one side would put every cut off the music without a
 * single error. And like the hero media, the film names files in `public/` by
 * string — a renamed recording renders as an empty window, silently.
 *
 * Read as source text, not imported: the film modules are client components.
 */

const WEB = join(import.meta.dir, '../../../../../..');
const FILMS = join(import.meta.dir, '../films');
const score = readFileSync(join(WEB, 'scripts/film/soundtrack.py'), 'utf8');
const pyConst = (name: string) => Number(score.match(new RegExp(`^${name} = (\\d+)`, 'm'))?.[1]);

const filmSources = readdirSync(FILMS, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => readFileSync(join(FILMS, f), 'utf8'))
  .join('\n');

describe('film grid', () => {
  test('one bar is 2 s at 60 fps and 120 BPM', () => {
    expect([FPS, BPM, BEAT, BAR]).toEqual([60, 120, 30, 120]);
  });

  test('the score runs on the same grid', () => {
    expect(pyConst('BPM')).toBe(BPM);
    expect(pyConst('FPS')).toBe(FPS);
  });

  test('the launch film and its score are the same length', () => {
    expect(filmSources).toContain(`frames: bars(${pyConst('BARS')})`);
  });
});

describe('film assets', () => {
  test('every referenced public file exists', () => {
    const paths = [...filmSources.matchAll(/['"](\/(?:media|film)\/[^'"$]+)['"]/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((p) => !existsSync(join(WEB, 'public', p)))).toEqual([]);
  });

  test('every cue names a sound effect on disk', () => {
    const names = new Set([...filmSources.matchAll(/sfx: '(\w+)'/g)].map((m) => m[1]));
    expect(names.size).toBeGreaterThan(0);
    const missing = [...names].filter((n) => !existsSync(join(WEB, 'scripts/film/sfx', `${n}.mp3`)));
    expect(missing).toEqual([]);
  });
});

describe('film route', () => {
  // A production build 500s every /presentations/<x> page with
  // DYNAMIC_SERVER_USAGE when the tree is not generated per locale: the
  // middleware rewrites unprefixed URLs onto /en/… (dev.kortix.com, 2026-09-29).
  test('the presentations tree is generated per locale', () => {
    const layout = readFileSync(join(import.meta.dir, '../../layout.tsx'), 'utf8');
    expect(layout).toContain('export const generateStaticParams = localeStaticParams');
  });
});
