import { describe, expect, test } from 'bun:test';

import { shouldMountAcpChat } from './session-page-lifecycle';

describe('session page chat mount lifecycle', () => {
  test('retains an already-ready chat while the runtime temporarily re-switches', () => {
    expect(shouldMountAcpChat({
      switched: false,
      fresh: false,
      shellSubmitted: false,
      chatReady: true,
    })).toBe(true);
  });

  test('does not mount before the runtime switch or before a fresh-session submit', () => {
    expect(shouldMountAcpChat({
      switched: false,
      fresh: false,
      shellSubmitted: false,
      chatReady: false,
    })).toBe(false);
    expect(shouldMountAcpChat({
      switched: true,
      fresh: true,
      shellSubmitted: false,
      chatReady: false,
    })).toBe(false);
  });

  test('mounts a switched existing session and a submitted fresh session', () => {
    expect(shouldMountAcpChat({
      switched: true,
      fresh: false,
      shellSubmitted: false,
      chatReady: false,
    })).toBe(true);
    expect(shouldMountAcpChat({
      switched: true,
      fresh: true,
      shellSubmitted: true,
      chatReady: false,
    })).toBe(true);
  });
});
