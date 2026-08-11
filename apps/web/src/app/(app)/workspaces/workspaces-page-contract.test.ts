import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

describe('workspaces page endpoint contract', () => {
  test('does not ship the retired legacy-machine migration route or client', () => {
    const repoRoot = resolve(import.meta.dir, '../../../../../..');

    expect(existsSync(resolve(repoRoot, 'apps/web/src/app/(app)/legacy-machines/page.tsx'))).toBe(
      false,
    );
    expect(
      existsSync(resolve(repoRoot, 'apps/web/src/hooks/legacy/use-legacy-machine-migration.ts')),
    ).toBe(false);
    expect(
      existsSync(resolve(repoRoot, 'apps/web/src/components/workspaces/legacy-machine-card.tsx')),
    ).toBe(false);
  });
});
