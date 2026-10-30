import { describe, expect, test } from 'bun:test';

import {
  PTY_MAX_ATTACH_FAILURES,
  PTY_WAKE_DEADLINE_MS,
  PTY_WAKE_RETRY_MS,
  classifyPtyAttachProbe,
  classifyPtyClose,
  deriveTerminalPanelState,
  nextPtyAttachStep,
  shouldAutoReplaceTerminal,
  shouldExpirePtyConnect,
  shouldRequestSessionWake,
} from './pty-connection';

describe('shouldRequestSessionWake', () => {
  const base = { sandboxWaking: true, visible: true, canStart: true, alreadyRequested: false };

  test('a visible panel on a parked box asks the session to start', () => {
    // Reproduced 2026-09-16: after a page load with no cached PTY list, the
    // panel polled GET /kortix/pty (503) for 248 s and nothing woke the box.
    expect(shouldRequestSessionWake(base)).toBe(true);
  });

  test('asks once per waking episode', () => {
    expect(shouldRequestSessionWake({ ...base, alreadyRequested: true })).toBe(false);
  });

  test('a hidden panel never wakes a box: nobody is waiting for it', () => {
    expect(shouldRequestSessionWake({ ...base, visible: false })).toBe(false);
  });

  test('does nothing without the ids /start needs, or when the box is not parked', () => {
    expect(shouldRequestSessionWake({ ...base, canStart: false })).toBe(false);
    expect(shouldRequestSessionWake({ ...base, sandboxWaking: false })).toBe(false);
  });
});

describe('classifyPtyAttachProbe', () => {
  test('a PTY list that answers means the box is up and the upgrade failed for another reason', () => {
    expect(classifyPtyAttachProbe(null)).toBe('reachable');
  });

  test('reads the control-plane readiness 503 as not-ready', () => {
    // The exact body the local API returned for a parked box on 2026-09-16.
    expect(
      classifyPtyAttachProbe(
        '{"error":"sandbox not ready (status: stopped)","code":"sandbox_not_ready","retry":true}',
      ),
    ).toBe('not-ready');
    expect(classifyPtyAttachProbe(new Error('sandbox not ready (status: stopped)'))).toBe(
      'not-ready',
    );
  });

  test('any other list failure is unreachable', () => {
    expect(classifyPtyAttachProbe(new Error('Failed to list terminals'))).toBe('unreachable');
  });
});

describe('nextPtyAttachStep', () => {
  const base = { wakeArmed: true, failures: 1, wakingForMs: 0 };

  test('dials a waking box on a flat short cadence, not an exponential backoff', () => {
    // The wake took 16-31 s on a local Platinum box. A 15 s backoff ceiling
    // added up to 15 s of dead time AFTER the box was ready.
    expect(nextPtyAttachStep({ ...base, probe: 'not-ready' })).toEqual({
      kind: 'retry',
      delayMs: PTY_WAKE_RETRY_MS,
      phase: 'waking',
    });
    expect(
      nextPtyAttachStep({ ...base, probe: 'not-ready', failures: 9, wakingForMs: 60_000 }),
    ).toEqual({ kind: 'retry', delayMs: PTY_WAKE_RETRY_MS, phase: 'waking' });
  });

  test('stops waiting on a wake that outlives the deadline', () => {
    expect(
      nextPtyAttachStep({ ...base, probe: 'not-ready', wakingForMs: PTY_WAKE_DEADLINE_MS - 1 }),
    ).toMatchObject({ kind: 'retry' });
    expect(
      nextPtyAttachStep({ ...base, probe: 'not-ready', wakingForMs: PTY_WAKE_DEADLINE_MS }),
    ).toEqual({ kind: 'pause', reason: 'failed' });
  });

  test('retains the wake deadline when readiness errors alternate with transport failures', () => {
    for (const probe of ['reachable', 'unreachable'] as const) {
      expect(nextPtyAttachStep({
        ...base, probe, wakingForMs: PTY_WAKE_DEADLINE_MS,
      })).toEqual({ kind: 'pause', reason: 'failed' });
    }
  });

  test('never resurrects a parked box without user intent', () => {
    expect(nextPtyAttachStep({ ...base, probe: 'not-ready', wakeArmed: false })).toEqual({
      kind: 'pause',
      reason: 'asleep',
    });
  });

  test('backs off a reachable or unreachable failure, then gives up with a retry state', () => {
    const delays = [1, 2, 3, 4, 5].map((failures) => {
      const step = nextPtyAttachStep({ ...base, probe: 'reachable', failures });
      return step.kind === 'retry' ? step.delayMs : null;
    });
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 8_000]);
    expect(nextPtyAttachStep({ ...base, probe: 'unreachable', failures: 2 })).toEqual({
      kind: 'retry',
      delayMs: 2_000,
      phase: 'reconnecting',
    });
    expect(
      nextPtyAttachStep({ ...base, probe: 'reachable', failures: PTY_MAX_ATTACH_FAILURES + 1 }),
    ).toEqual({ kind: 'pause', reason: 'failed' });
  });
});

describe('classifyPtyClose', () => {
  test('replaces a daemon-side PTY that no longer exists even when the proxy reports code 1000', () => {
    expect(classifyPtyClose({ code: 1000, reason: 'pty not found', hadError: false })).toBe(
      'replace',
    );
  });

  test('reconnects transport failures regardless of proxy close-code normalization', () => {
    expect(classifyPtyClose({ code: 1000, reason: 'upstream error', hadError: true })).toBe(
      'reconnect',
    );
    expect(classifyPtyClose({ code: 1011, reason: 'upstream error', hadError: true })).toBe(
      'reconnect',
    );
    expect(classifyPtyClose({ code: 1000, reason: 'idle timeout', hadError: false })).toBe(
      'reconnect',
    );
  });

  test('leaves an intentional shell exit ended', () => {
    expect(classifyPtyClose({ code: 1000, reason: 'pty exited (0)', hadError: false })).toBe(
      'ended',
    );
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

  test('holds the connecting state while the failure is a sandbox readiness 503', () => {
    // A parked/booting box answers list/create with "sandbox not ready" — a
    // pending state, never a terminal error card.
    expect(
      deriveTerminalPanelState({ ...readyInput, isListError: true, isSandboxWaking: true }),
    ).toBe('connecting');
    expect(
      deriveTerminalPanelState({ ...readyInput, isCreateError: true, isSandboxWaking: true }),
    ).toBe('connecting');
  });

  test('turns a prolonged readiness wait into a local retry state', () => {
    expect(
      deriveTerminalPanelState({
        ...readyInput,
        isListError: true,
        isSandboxWaking: true,
        connectionWaitExpired: true,
      }),
    ).toBe('error');
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
