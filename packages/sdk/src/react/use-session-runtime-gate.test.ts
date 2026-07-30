import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./use-session.ts', import.meta.url), 'utf8');

describe('useSession runtime ownership gate', () => {
  test('does not connect OpenCode transports before /start switches the sandbox', () => {
    expect(source).toContain(
      'enabled: switched && runtimePolicy.streamOpenCodeEvents',
    );
    expect(source).toContain('networkEnabled: switched');
  });
});
