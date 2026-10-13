import { expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The hero's screenshots are string literals pointing at files in `public/`.
 * Nothing links the two, so a renamed or dropped capture fails silently: the
 * frame paints empty. Read the paths out of `hero.tsx` and require each file,
 * and require both themes so a light-only capture cannot land.
 */
const HERO = join(import.meta.dir, 'hero.tsx');
const PUBLIC = join(import.meta.dir, '../../../public');

test('every hero screenshot exists in public/, in both themes', () => {
  const paths = [...readFileSync(HERO, 'utf8').matchAll(/src="(\/media\/[^"]+)"/g)].map((m) => m[1]);
  expect(paths.some((p) => p.includes('-light.'))).toBe(true);
  expect(paths.some((p) => p.includes('-dark.'))).toBe(true);
  for (const p of paths) expect(statSync(join(PUBLIC, p)).size).toBeGreaterThan(10_000);
});
