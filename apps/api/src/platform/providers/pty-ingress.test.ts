import { describe, expect, test } from 'bun:test';

import { isPtyWebSocketPath } from './pty-ingress';

describe('isPtyWebSocketPath', () => {
  test('matches the daemon PTY websocket path', () => {
    expect(isPtyWebSocketPath('/kortix/pty/kpty_test/connect')).toBe(true);
  });

  test('does not match unrelated daemon or preview paths, or the retired OpenCode PTY path', () => {
    expect(isPtyWebSocketPath('/kortix/health')).toBe(false);
    expect(isPtyWebSocketPath('/preview/pty/example')).toBe(false);
    expect(isPtyWebSocketPath('/pty/pty_test/connect')).toBe(false);
    expect(isPtyWebSocketPath()).toBe(false);
  });
});
