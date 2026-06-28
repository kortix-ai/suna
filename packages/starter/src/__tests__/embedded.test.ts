import { describe, expect, test } from 'bun:test';

import embeddedStarter from '../embedded.generated.json' with { type: 'json' };
import { buildEmbeddedSnapshot } from '../../scripts/generate-embedded';

/**
 * Guards against a stale committed snapshot. The compiled `kortix` binary
 * serves starter files from `embedded.generated.json`, so if a template file
 * changes without regenerating the snapshot, the binary would ship the old
 * content. Regenerate with `bun run scripts/generate-embedded.ts`.
 */
describe('embedded starter snapshot', () => {
  test('is in sync with the on-disk template tree', () => {
    const fresh = buildEmbeddedSnapshot();
    expect(embeddedStarter).toEqual(fresh as typeof embeddedStarter);
  });

  test('includes the general knowledge worker skill pack', () => {
    const gkw = (embeddedStarter as Record<string, { files: { path: string }[] }>)[
      'general-knowledge-worker'
    ];
    const skillFiles = gkw.files.filter((f) =>
      f.path.startsWith('.kortix/opencode/skills/'),
    );
    expect(skillFiles.length).toBeGreaterThan(0);
  });

  test('does not ship gated agent tunnel skill by default', () => {
    for (const starter of Object.values(
      embeddedStarter as Record<string, { files: { path: string }[] }>,
    )) {
      expect(starter.files.some((f) => f.path.includes('/agent-tunnel/'))).toBe(false);
    }
  });
});
