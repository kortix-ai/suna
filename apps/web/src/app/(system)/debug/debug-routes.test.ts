/**
 * The /debug index must list every harness, and only real ones.
 *
 * A harness is a folder next to this file that contains a `page.tsx`. When this
 * test fails, add the missing entry to `debug-routes.ts`, or remove the entry
 * whose folder is gone. Only direct child folders are scanned; no harness is
 * nested deeper today.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { DEBUG_ROUTE_GROUPS, DEBUG_ROUTES } from './debug-routes';

function harnessSlugs(): string[] {
  return readdirSync(import.meta.dir, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(import.meta.dir, entry.name, 'page.tsx')),
    )
    .map((entry) => entry.name)
    .sort();
}

describe('/debug index', () => {
  test('lists every harness folder, and nothing else', () => {
    const listed = DEBUG_ROUTES.map((route) => route.slug).sort();
    expect(listed).toEqual(harnessSlugs());
  });

  test('lists each harness once', () => {
    const slugs = DEBUG_ROUTES.map((route) => route.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test('renders no empty group', () => {
    for (const group of DEBUG_ROUTE_GROUPS) {
      expect(DEBUG_ROUTES.some((route) => route.group === group)).toBe(true);
    }
  });
});
