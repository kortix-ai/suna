import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./use-session.ts', import.meta.url), 'utf8');

describe('useSession runtime ownership gate', () => {
  test('the session STREAM mounts on session identity; OpenCode transports stay gated on the switch', () => {
    // The live stream is control-plane (`GET .../sessions/:sid/stream`), so it
    // must NOT wait for /start to switch the sandbox — a stopped or waking box
    // still delivers queue/turn/mirror truth, and the runtime channel attaches
    // by itself when the daemon does.
    expect(source).toContain(
      'useSessionRuntimeStream(projectId, sessionId, { enabled: startEnabled })',
    );
    // The `/p/`-proxied opencode reads (the transcript page loader) remain
    // gated on the switch: a handle must never resolve another session's box.
    expect(source).toContain('networkEnabled: switched');
    // And the deleted opencode-shaped event stream must not come back.
    expect(source).not.toContain('useOpenCodeEventStream');
  });
});
