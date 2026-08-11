// A mock.module factory for `config` must carry EVERY named export the real
// module has. Returning only `{ config }` is what broke the whole reaping
// directory: mock.module is process-global in bun, so one partial factory
// removes `SANDBOX_VERSION` from every sibling suite in the same process.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mockConfigModule } from './mock-config';

/** Every `export const NAME` / `export function NAME` in src/config.ts. */
function realConfigExportNames(): string[] {
  const src = readFileSync(join(import.meta.dir, '../../../config.ts'), 'utf8');
  return [...src.matchAll(/^export\s+(?:const|function|async function)\s+(\w+)/gm)].map(
    (m) => m[1],
  );
}

describe('mockConfigModule', () => {
  test('carries every named export the real config module has', () => {
    const mocked = mockConfigModule();
    for (const name of realConfigExportNames()) {
      expect(mocked).toHaveProperty(name);
    }
  });

  test('applies overrides onto the config object without dropping siblings', () => {
    const mocked = mockConfigModule({ KORTIX_SANDBOX_AUTOSTOP_MINUTES: 15 });
    expect((mocked.config as Record<string, unknown>).KORTIX_SANDBOX_AUTOSTOP_MINUTES).toBe(15);
    expect(mocked).toHaveProperty('SANDBOX_VERSION');
  });
});
