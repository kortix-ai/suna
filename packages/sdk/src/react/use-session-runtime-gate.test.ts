import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./use-session.ts', import.meta.url), 'utf8');

describe('useSession runtime ownership gate', () => {
  test('does not connect OpenCode transports before /start switches the sandbox', () => {
    expect(source).toContain('useRuntimeEventStream({ enabled: switched })');
    expect(source).toContain('networkEnabled: switched');
  });

  test('a live session stays live through a failed or transport-only /start poll', () => {
    // hold-live-start.test.ts pins the rule; this pins that the ONE query every
    // consumer reads (stream, sync, send, page banner) is folded through it.
    expect(source).toMatch(/queryFn: async \(\) => \{[\s\S]*?return holdLiveStart\(\s*previous,/);
  });
});
