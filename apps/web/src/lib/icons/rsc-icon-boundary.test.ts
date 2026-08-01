import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `@/features/icon/icon` is a 'use client' module that exports one namespace
 * object, `Icon`. Across the RSC boundary the bundler replaces that export with
 * a client reference — `registerClientReference(stub, id, 'Icon')` — which
 * carries only $$typeof/$$id/$$async. Reading `Icon.Github` off it therefore
 * yields `undefined`, and React renders `<undefined />`:
 *
 *   "Element type is invalid: expected a string ... but got: undefined"
 *
 * That is a hard 500 on every route in the segment, not a degraded icon. It
 * took down all of /docs (see the "Edit on GitHub" button and the docs sidebar
 * links). Server components import icons from '@/lib/icons/ssr' instead.
 *
 * This scan only inspects App Router special files (page/layout/template/
 * default/error/not-found) that do NOT opt into the client with 'use client'.
 * Those are unambiguously server components, so there is no false positive:
 * a shared component with no directive may legitimately be client-only.
 */

const APP_DIR = join(import.meta.dir, '..', '..', 'app');
const RSC_ENTRY = /^(page|layout|template|default|error|not-found)\.tsx$/;
const CLIENT_ICON_IMPORT = /from\s+['"]@\/features\/icon\/icon['"]/;

function collectRscEntries(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectRscEntries(path, found);
    } else if (RSC_ENTRY.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

describe('server components never dot into the client Icon namespace', () => {
  test('no App Router server entry imports @/features/icon/icon', () => {
    const entries = collectRscEntries(APP_DIR);
    expect(entries.length).toBeGreaterThan(0);

    const offenders = entries.filter((path) => {
      const source = readFileSync(path, 'utf8');
      if (/^\s*['"]use client['"]/.test(source)) return false;
      return CLIENT_ICON_IMPORT.test(source);
    });

    expect(offenders.map((path) => path.slice(APP_DIR.length + 1))).toEqual([]);
  });
});
