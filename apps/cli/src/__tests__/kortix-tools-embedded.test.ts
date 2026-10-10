import { describe, expect, test } from 'bun:test';
import embedded from '../kortix-tools.generated.json' with { type: 'json' };
import { buildKortixToolsSnapshot } from '../../scripts/generate-kortix-tools.ts';
import { KORTIX_TOOL_NAMES } from '@kortix/manifest-schema';

/**
 * `kortix tools eject <name>` writes the embedded copy of a Kortix tool. It
 * must be the same bytes the sandbox daemon runs, or an ejected tool silently
 * differs from the one the project had. Regenerate with
 * `bun run apps/cli/scripts/generate-kortix-tools.ts`.
 */
describe('embedded Kortix tool sources', () => {
  test('equal the daemon source byte for byte', () => {
    expect(embedded as Record<string, string>).toEqual(buildKortixToolsSnapshot());
  });

  test('hold one module per Kortix tool name', () => {
    expect(Object.keys(embedded).sort()).toEqual([...KORTIX_TOOL_NAMES].sort());
  });
});
