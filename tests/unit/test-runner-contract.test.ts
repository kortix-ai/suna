import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const rootPackage = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const testsPackage = JSON.parse(readFileSync(resolve(root, 'tests/package.json'), 'utf8'));

describe('local test runner contract', () => {
  it('uses the one workspace lockfile', () => {
    expect(existsSync(resolve(root, 'pnpm-lock.yaml'))).toBe(true);
    expect(existsSync(resolve(root, 'tests/bun.lock'))).toBe(false);
    expect(existsSync(resolve(root, 'tests/package-lock.json'))).toBe(false);
  });

  it('exposes one local-first command from the repository root', () => {
    expect(rootPackage.scripts.test).toBe('bun tests/bin/local.ts');
    expect(rootPackage.scripts['test:flows']).toBeUndefined();
    expect(rootPackage.scripts['test:browser']).toBeUndefined();
    expect(testsPackage.scripts.test).toContain('vitest run');
  });
});
