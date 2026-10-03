import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// apps/web has one toast surface: apps/web/src/components/ui/toast.tsx. A second
// wrapper (`src/lib/toast.ts`) re-exported sonner's stock `toast.success/error`,
// so every caller of it rendered the old, unbranded toast. Only the surface
// itself and the root layout (which mounts `<Toaster />`) may import sonner.

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const SCOPE = 'apps/web/src';
const SONNER_ALLOWED = new Set([
  'apps/web/src/components/ui/toast.tsx',
  'apps/web/src/app/[locale]/layout.tsx',
]);
const BANNED_IMPORT = /from\s+['"](sonner|@\/lib\/toast)['"]/;

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', SCOPE], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => /\.(ts|tsx|mts)$/.test(file) && existsSync(join(REPO_ROOT, file)));
}

describe('toast single source in apps/web', () => {
  it('has no src/lib/toast wrapper', () => {
    for (const ext of ['ts', 'tsx']) {
      expect(existsSync(join(REPO_ROOT, `${SCOPE}/lib/toast.${ext}`))).toBe(false);
    }
  });

  it('imports sonner only from components/ui/toast.tsx and the root layout', () => {
    const offenders = trackedFiles().filter(
      (file) =>
        !SONNER_ALLOWED.has(file) &&
        !/\.test\.tsx?$/.test(file) &&
        BANNED_IMPORT.test(readFileSync(join(REPO_ROOT, file), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
