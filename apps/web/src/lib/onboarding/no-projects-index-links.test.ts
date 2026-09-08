import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The removed `/projects` index took two query-string forms with it:
 * `?new=1` opened the create modal, `?clone=<id>` seeded it from a
 * skills-marketplace item. Create now lives at `/new`; `?clone=` has no
 * successor at all — the skills marketplace it seeded from was removed from
 * the product, so nothing has an item id to clone from any more.
 *
 * Scoped to the query-string forms deliberately, not to the bare `/projects`
 * string: `/projects` itself is still a real prefix for `/projects/:id`, so a
 * whole-string sweep cannot tell a destination (wrong, must repoint) from a
 * prefix/allowlist check (`startsWith('/projects')`, `pathname.indexOf(...)`)
 * that legitimately still matches every open project. `?new=1` and `?clone=`
 * have no such double meaning — nothing needs them to survive.
 */
const SRC = join(import.meta.dir, '..', '..');

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* sourceFiles(full);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) yield full;
  }
}

describe('no links to the removed projects index', () => {
  test('nothing routes to /projects?new=1 — create lives at /new', () => {
    const offenders = [...sourceFiles(SRC)].filter((file) =>
      readFileSync(file, 'utf8').includes('/projects?new=1'),
    );
    expect(offenders).toEqual([]);
  });

  test('nothing routes to /projects?clone= — cloning lives at /new?clone=', () => {
    const offenders = [...sourceFiles(SRC)].filter((file) =>
      readFileSync(file, 'utf8').includes('/projects?clone='),
    );
    expect(offenders).toEqual([]);
  });
});
