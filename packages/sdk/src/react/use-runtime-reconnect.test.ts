import { beforeEach, describe, expect, test } from 'bun:test';

import {
  classifyProbeResult,
  computeFailureStatus,
  FAIL_THRESHOLD_FIRST,
  FAIL_THRESHOLD_RECONNECT,
  isImmediateOfflineSignal,
  isImmediateOfflineStatus,
  nextPollDelay,
  POLL_CONNECTED,
  POLL_FAILING,
  POLL_UNREACHABLE,
  type ProbeResultLike,
} from './use-runtime-reconnect';
import {
  incrementSandboxFail,
  requestRuntimeReconnect,
  resetSandboxFail,
  useSandboxConnectionStore,
} from '../browser/stores/sandbox-connection-store';

function probe(overrides: Partial<ProbeResultLike>): ProbeResultLike {
  return { status: 200, ok: true, health: null, body: '', ...overrides };
}

describe('computeFailureStatus — first connection', () => {
  test('stays unchanged below FAIL_THRESHOLD_FIRST', () => {
    for (let n = 1; n < FAIL_THRESHOLD_FIRST; n++) {
      expect(computeFailureStatus(n, false, false)).toBeNull();
    }
  });

  test('flips to unreachable at exactly FAIL_THRESHOLD_FIRST consecutive failures', () => {
    expect(computeFailureStatus(FAIL_THRESHOLD_FIRST, false, false)).toBe('unreachable');
  });

  test('stays unreachable past the threshold', () => {
    expect(computeFailureStatus(FAIL_THRESHOLD_FIRST + 3, false, false)).toBe('unreachable');
  });
});

describe('manual runtime reconnect', () => {
  test('clears stale unreachable state and emits an immediate-retry signal', () => {
    useSandboxConnectionStore.setState({ status: 'unreachable', healthy: false, failCount: 7, runtimeError: 'stale', disconnectedAt: 123, manualRetryNonce: 4 });
    requestRuntimeReconnect();
    expect(useSandboxConnectionStore.getState()).toMatchObject({ status: 'connecting', healthy: null, failCount: 0, runtimeError: null, manualRetryNonce: 5 });
  });
});

describe('computeFailureStatus — reconnect (was previously connected)', () => {
  test('first miss drops into connecting, not unreachable', () => {
    expect(computeFailureStatus(1, true, false)).toBe('connecting');
  });

  test('flips to unreachable at exactly FAIL_THRESHOLD_RECONNECT consecutive failures', () => {
    expect(FAIL_THRESHOLD_RECONNECT).toBe(2);
    expect(computeFailureStatus(FAIL_THRESHOLD_RECONNECT, true, false)).toBe('unreachable');
  });
});

describe('computeFailureStatus — immediate offline signal', () => {
  test('short-circuits to unreachable on the very first failure regardless of history', () => {
    expect(computeFailureStatus(1, false, true)).toBe('unreachable');
    expect(computeFailureStatus(1, true, true)).toBe('unreachable');
  });
});

describe('computeFailureStatus — timeout counts as a plain failure', () => {
  test('a CHECK_TIMEOUT abort (no HTTP status to classify) never bypasses the threshold', () => {
    // The hook always passes immediateOffline=false for a thrown/aborted probe
    // (no resolved status/body exists to classify as immediate-offline) — a
    // timeout is a normal failure, counted like any other.
    expect(computeFailureStatus(1, false, false)).toBeNull();
    expect(computeFailureStatus(FAIL_THRESHOLD_FIRST - 1, false, false)).toBeNull();
    expect(computeFailureStatus(FAIL_THRESHOLD_FIRST, false, false)).toBe('unreachable');
  });

  test('a timeout after a prior successful connection uses the tighter reconnect threshold', () => {
    expect(computeFailureStatus(1, true, false)).toBe('connecting');
    expect(computeFailureStatus(2, true, false)).toBe('unreachable');
  });
});

describe('nextPollDelay', () => {
  test('polls slowly once connected and healthy', () => {
    expect(nextPollDelay('connected', true)).toBe(POLL_CONNECTED);
  });

  test('polls fast when connected but not yet healthy (opencode still booting)', () => {
    expect(nextPollDelay('connected', false)).toBe(POLL_FAILING);
  });

  test('polls at the unreachable cadence once confirmed down', () => {
    expect(nextPollDelay('unreachable', null)).toBe(POLL_UNREACHABLE);
    expect(nextPollDelay('unreachable', false)).toBe(POLL_UNREACHABLE);
  });

  test('polls fast while still connecting (initial phase)', () => {
    expect(nextPollDelay('connecting', null)).toBe(POLL_FAILING);
  });
});

describe('isImmediateOfflineStatus / isImmediateOfflineSignal', () => {
  test('502/503/504 are immediate-offline statuses', () => {
    expect(isImmediateOfflineStatus(502)).toBe(true);
    expect(isImmediateOfflineStatus(503)).toBe(true);
    expect(isImmediateOfflineStatus(504)).toBe(true);
    expect(isImmediateOfflineStatus(500)).toBe(false);
    expect(isImmediateOfflineStatus(200)).toBe(false);
  });

  test('a body saying no service answered is immediate-offline even on a non-5xx status', () => {
    expect(isImmediateOfflineSignal(400, 'no service is responding on this port')).toBe(true);
    expect(isImmediateOfflineSignal(400, 'target not reachable')).toBe(true);
    expect(isImmediateOfflineSignal(400, 'bad request')).toBe(false);
  });
});

describe('classifyProbeResult', () => {
  test('401/403 classify as auth-error, not immediate failure', () => {
    expect(classifyProbeResult(probe({ status: 401, ok: false }))).toEqual({ kind: 'auth-error' });
    expect(classifyProbeResult(probe({ status: 403, ok: false }))).toEqual({ kind: 'auth-error' });
  });

  test('503 classifies as booting and carries the parsed health body through', () => {
    const health = { status: 'starting' as const };
    expect(classifyProbeResult(probe({ status: 503, ok: false, health }))).toEqual({
      kind: 'booting',
      health,
    });
  });

  test('a resolved non-ok response classifies as failure, with the offline signal computed', () => {
    expect(classifyProbeResult(probe({ status: 502, ok: false }))).toEqual({
      kind: 'failure',
      immediateOffline: true,
    });
    expect(classifyProbeResult(probe({ status: 500, ok: false, body: 'internal error' }))).toEqual({
      kind: 'failure',
      immediateOffline: false,
    });
  });

  test('an ok response classifies as healthy and carries the parsed health body through', () => {
    const health = { runtimeReady: true, version: '1.2.3' };
    expect(classifyProbeResult(probe({ status: 200, ok: true, health }))).toEqual({
      kind: 'healthy',
      health,
    });
  });
});

describe('sandbox-connection-store recovery resets counters', () => {
  beforeEach(() => {
    useSandboxConnectionStore.setState({ failCount: 0 });
  });

  test('resetSandboxFail zeroes the counter so a later failure restarts from 1', () => {
    incrementSandboxFail();
    incrementSandboxFail();
    incrementSandboxFail();
    expect(useSandboxConnectionStore.getState().failCount).toBe(3);

    resetSandboxFail();
    expect(useSandboxConnectionStore.getState().failCount).toBe(0);

    incrementSandboxFail();
    expect(useSandboxConnectionStore.getState().failCount).toBe(1);
  });
});
