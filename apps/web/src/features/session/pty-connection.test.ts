import { describe, expect, test } from 'bun:test';

import {
  classifyPtyClose,
  deriveTerminalPanelState,
  shouldAutoReplaceTerminal,
  shouldExpirePtyConnect,
} from './pty-connection';

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

describe('deriveTerminalPanelState', () => {
  const readyInput = {
    hasServerUrl: true,
    serverWaitExpired: false,
    hasPty: false,
    isListLoading: false,
    isListError: false,
    isCreatePending: false,
    isCreateError: false,
    isEnsuring: false,
  };

  test('starts the daemon terminal without waiting for OpenCode health', () => {
    expect(deriveTerminalPanelState(readyInput)).toBe('empty');
  });

  test('ends a missing-server wait with an actionable error', () => {
    expect(
      deriveTerminalPanelState({ ...readyInput, hasServerUrl: false, serverWaitExpired: false }),
    ).toBe('connecting');
    expect(
      deriveTerminalPanelState({ ...readyInput, hasServerUrl: false, serverWaitExpired: true }),
    ).toBe('error');
  });

  test('surfaces list and create failures instead of preserving the spinner', () => {
    expect(deriveTerminalPanelState({ ...readyInput, isListError: true })).toBe('error');
    expect(deriveTerminalPanelState({ ...readyInput, isCreateError: true })).toBe('error');
  });

  test('keeps an existing terminal visible during background query failures', () => {
    expect(deriveTerminalPanelState({ ...readyInput, hasPty: true, isListError: true })).toBe(
      'terminal',
    );
  });
});

describe('shouldExpirePtyConnect', () => {
  test('expires a websocket that never opens at the configured deadline', () => {
    expect(shouldExpirePtyConnect(1_000, 15_999, 15_000)).toBe(false);
    expect(shouldExpirePtyConnect(1_000, 16_000, 15_000)).toBe(true);
  });
});
