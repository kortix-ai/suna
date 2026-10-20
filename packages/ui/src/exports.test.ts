import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// @ts-expect-error -- plain .mjs script, no declaration file
import { buildExports, DEEP } from '../scripts/gen-exports.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('package.json exports', () => {
  test('match the file tree (run: pnpm --filter @kortix/ui gen-exports)', () => {
    expect(pkg.exports).toEqual(buildExports());
  });

  test('every target exists in a fresh checkout', () => {
    const missing = Object.values<string>(pkg.exports).filter(
      (target) => !existsSync(fileURLToPath(new URL(`../${target}`, import.meta.url))),
    );
    expect(missing).toEqual([]);
  });

  // Every other module is reachable only through its entry. The deep keys are
  // the measured remainder a workspace consumer imports (scripts/deep-exports.json);
  // tests/unit/ui-deep-exports.test.ts keeps that list equal to the imports.
  test('deep keys are sorted, unique module paths that no entry or primitive owns', () => {
    expect(DEEP).toEqual([...new Set<string>(DEEP)].sort());
    for (const key of DEEP as string[]) {
      expect(key).toMatch(/^\.\/(?!primitives\/|test-utils\/|types\/|styles\/)[\w-]+\/[\w./\[\]-]+$/);
      expect(pkg.exports[key]).toMatch(/^\.\/src\/.+\.tsx?$/);
    }
  });

});
