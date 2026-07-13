import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A committed snapshot of every name reachable from every public entry point.
 *
 * This is the guardrail behind "exported names ARE the API". A rename, a
 * removal, or an addition changes this file, and the diff lands in review where
 * a human decides: additive (fine) or breaking (needs an alias)?
 *
 * A snapshot diff is a QUESTION — "did I mean to change the public API?" — not
 * a file to re-record until the test goes green.
 *
 * Regenerate deliberately:  UPDATE_SURFACE_SNAPSHOT=1 bun test src/public-surface.test.ts
 */
const SNAPSHOT = join(import.meta.dir, 'public-surface.snapshot.json');

async function collectSurface(): Promise<Record<string, string[]>> {
  const pkg = JSON.parse(
    readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'),
  ) as { exports: Record<string, string> };

  const surface: Record<string, string[]> = {};
  for (const [subpath, file] of Object.entries(pkg.exports)) {
    // `./react` pulls React in; import it anyway — bun can load it, and its
    // export names are as public as any other.
    const mod = (await import(file.replace(/^\.\/src\//, './'))) as Record<string, unknown>;
    surface[subpath] = Object.keys(mod).sort();
  }
  return surface;
}

test('public export surface matches the committed snapshot', async () => {
  const actual = await collectSurface();

  if (process.env.UPDATE_SURFACE_SNAPSHOT === '1') {
    writeFileSync(SNAPSHOT, `${JSON.stringify(actual, null, 2)}\n`);
    console.warn('public-surface.snapshot.json regenerated — REVIEW THE DIFF.');
    return;
  }

  expect(existsSync(SNAPSHOT)).toBe(true);
  const expected = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Record<string, string[]>;
  expect(actual).toEqual(expected);
});
