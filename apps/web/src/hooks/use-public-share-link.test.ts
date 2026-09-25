import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// A public link needs no sign-in. "Copy link" must ask before it creates one,
// on every surface that offers it. There is no DOM in this package's tests, so
// the contract is pinned on the source: the hook mints only from the
// confirmation, and every caller renders that confirmation.

const SRC = join(import.meta.dir, '..');
const HOOK_SOURCE = readFileSync(join(import.meta.dir, 'use-public-share-link.ts'), 'utf8');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('Copy link asks before it creates a public share', () => {
  test('copyLink opens the confirmation and mints nothing', () => {
    expect(HOOK_SOURCE).toContain('copyLink: () => setConfirmOpen(true)');
    expect(HOOK_SOURCE).not.toContain('copyLink: () => mutation.mutate()');
  });

  test('the share is minted only from the confirmation', () => {
    const mints = HOOK_SOURCE.match(/mutation\.mutate\(\)/g) ?? [];
    expect(mints).toHaveLength(1);
    expect(HOOK_SOURCE).toContain('onConfirm: () => mutation.mutate()');
  });

  test('every caller of usePublicShareLink renders the confirmation', () => {
    const callers = sourceFiles(SRC).filter((file) => {
      const text = readFileSync(file, 'utf8');
      return text.includes('usePublicShareLink(') && !file.endsWith('use-public-share-link.ts');
    });

    expect(callers.length).toBeGreaterThanOrEqual(3);
    for (const file of callers) {
      const text = readFileSync(file, 'utf8');
      expect(text, relative(SRC, file)).toContain('<PublicShareLinkConfirm');
    }
  });
});
