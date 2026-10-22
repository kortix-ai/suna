import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// apps/web has one toast surface: @kortix/ui's toast
// (packages/ui/src/primitives/toast.tsx; packages/ui/src/primitives/toast.tsx
// re-exports it). A second
// wrapper (`src/lib/toast.ts`) re-exported sonner's stock `toast.success/error`,
// so every caller of it rendered the old, unbranded toast. Only the surface
// itself and apps/web's root layout (which mounts `<Toaster />`) may import
// sonner. Other hosts mount the `<Toaster />` that @kortix/ui/toast exports.

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const WEB = 'apps/web/src';
const SCOPES = [WEB, 'packages/ui/src', 'apps/white-label/lumen/src', 'apps/white-label/reskin/src'];
const SONNER_ALLOWED = new Set([
  'packages/ui/src/primitives/toast.tsx',
  'apps/web/src/app/[locale]/layout.tsx',
]);
const BANNED_IMPORT = /from\s+['"](sonner|@\/lib\/toast)['"]/;

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...SCOPES], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => /\.(ts|tsx|mts)$/.test(file) && existsSync(join(REPO_ROOT, file)));
}

describe('toast single source in apps/web and @kortix/ui', () => {
  it('has no src/lib/toast wrapper', () => {
    for (const ext of ['ts', 'tsx']) {
      expect(existsSync(join(REPO_ROOT, `${WEB}/lib/toast.${ext}`))).toBe(false);
    }
  });

  it('imports sonner only from the @kortix/ui toast and the apps/web root layout', () => {
    const offenders = trackedFiles().filter(
      (file) =>
        !SONNER_ALLOWED.has(file) &&
        !/\.test\.tsx?$/.test(file) &&
        BANNED_IMPORT.test(readFileSync(join(REPO_ROOT, file), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
