import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('projects page endpoint contract', () => {
  test('does not call the retired legacy-machine migration API', () => {
    const source = readFileSync(resolve(import.meta.dir, 'page.tsx'), 'utf8');

    expect(source).not.toContain('useLegacyMachines');
    expect(source).not.toContain('/legacy-machines');
  });

  test('does not ship the retired legacy-machine migration route or client', () => {
    const repoRoot = resolve(import.meta.dir, '../../../../../..');

    expect(existsSync(resolve(repoRoot, 'apps/web/src/app/(app)/legacy-machines/page.tsx'))).toBe(
      false,
    );
    expect(
      existsSync(resolve(repoRoot, 'apps/web/src/hooks/legacy/use-legacy-machine-migration.ts')),
    ).toBe(false);
    expect(
      existsSync(resolve(repoRoot, 'apps/web/src/components/projects/legacy-machine-card.tsx')),
    ).toBe(false);
  });
});
