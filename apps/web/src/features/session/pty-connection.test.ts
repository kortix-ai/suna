import { describe, expect, test } from 'bun:test';

import { classifyPtyClose, shouldAutoReplaceTerminal } from './pty-connection';

describe('classifyPtyClose', () => {
  test('replaces a daemon-side PTY that no longer exists even when the proxy reports code 1000', () => {
    expect(classifyPtyClose({ code: 1000, reason: 'pty not found', hadError: false })).toBe('replace');
  });

  test('reconnects transport failures regardless of proxy close-code normalization', () => {
    expect(classifyPtyClose({ code: 1000, reason: 'upstream error', hadError: true })).toBe('reconnect');
    expect(classifyPtyClose({ code: 1011, reason: 'upstream error', hadError: true })).toBe('reconnect');
    expect(classifyPtyClose({ code: 1000, reason: 'idle timeout', hadError: false })).toBe('reconnect');
  });

  test('leaves an intentional shell exit ended', () => {
    expect(classifyPtyClose({ code: 1000, reason: 'pty exited (0)', hadError: false })).toBe('ended');
  });
});

describe('shouldAutoReplaceTerminal', () => {
  test('allows exactly one automatic replacement per terminal chain', () => {
    expect(shouldAutoReplaceTerminal(0)).toBe(true);
    expect(shouldAutoReplaceTerminal(1)).toBe(false);
    expect(shouldAutoReplaceTerminal(2)).toBe(false);
  });
});
