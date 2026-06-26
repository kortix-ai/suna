import { describe, expect, test } from 'bun:test';

import { latchChatRevealed, shouldRenderChat } from './chat-reveal';

describe('chat reveal latch', () => {
  test('does not reveal before the runtime is ready', () => {
    expect(latchChatRevealed(false, false, true)).toBe(false);
    expect(latchChatRevealed(false, true, false)).toBe(false);
  });

  test('reveals once the runtime is ready and a session is resolved', () => {
    expect(latchChatRevealed(false, true, true)).toBe(true);
  });

  test('stays revealed through a transient runtime-not-ready dip (regression: blank screen mid-session)', () => {
    expect(latchChatRevealed(true, false, true)).toBe(true);
    expect(latchChatRevealed(true, false, false)).toBe(true);
  });
});

describe('chat render gate', () => {
  test('renders only when revealed and a session id exists', () => {
    expect(shouldRenderChat(true, true)).toBe(true);
    expect(shouldRenderChat(true, false)).toBe(false);
    expect(shouldRenderChat(false, true)).toBe(false);
  });
});
