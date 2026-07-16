import { describe, expect, test } from 'bun:test';

import { classifyPtyWebSocketPath } from './pty-ingress';

describe('classifyPtyWebSocketPath', () => {
  test('distinguishes OpenCode and Kortix-native PTY websocket paths', () => {
    expect(classifyPtyWebSocketPath('/pty/pty_test/connect')).toBe('opencode');
    expect(classifyPtyWebSocketPath('/kortix/pty/kpty_test/connect')).toBe('kortix');
  });

  test('does not classify unrelated daemon or preview paths as PTY', () => {
    expect(classifyPtyWebSocketPath('/kortix/health')).toBeNull();
    expect(classifyPtyWebSocketPath('/preview/pty/example')).toBeNull();
    expect(classifyPtyWebSocketPath()).toBeNull();
  });
});
