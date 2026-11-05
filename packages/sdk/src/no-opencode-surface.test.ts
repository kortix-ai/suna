import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every session runs pi; OpenCode is gone from the box (2026-10-30). No public
 * entry point, value or type carries an OpenCode name. The two snapshots are
 * the surface: `public-surface.test.ts` and `public-type-surface.test.ts` hold
 * them equal to the code.
 */
const OPENCODE = /open[-_]?code/i;
const read = (file: string) => JSON.parse(readFileSync(join(import.meta.dir, file), 'utf8')) as Record<string, string[]>;

function opencodeNames(surface: Record<string, string[]>): string[] {
  return Object.entries(surface).flatMap(([entry, names]) => [
    ...(OPENCODE.test(entry) ? [entry] : []),
    ...names.filter((name) => OPENCODE.test(name)).map((name) => `${entry} ${name}`),
  ]);
}

test('no public value or entry point is named after OpenCode', () => {
  expect(opencodeNames(read('public-surface.snapshot.json'))).toEqual([]);
});

test('no public type is named after OpenCode', () => {
  expect(opencodeNames(read('public-type-surface.snapshot.json'))).toEqual([]);
});

test('package.json exports no OpenCode subpath', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as {
    exports: Record<string, unknown>;
    publishConfig: { exports: Record<string, unknown> };
  };
  expect([...Object.keys(pkg.exports), ...Object.keys(pkg.publishConfig.exports)].filter((key) => OPENCODE.test(key))).toEqual([]);
});
