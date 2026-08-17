import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  classifyProbeResult,
  computeFailureStatus,
  FAIL_THRESHOLD_FIRST,
  FAIL_THRESHOLD_RECONNECT,
  isImmediateOfflineSignal,
  isImmediateOfflineStatus,
  nextPollDelay,
  RUNTIME_EVIDENCE_FRESH_MS,
  shouldIgnoreProbeFailure,
  POLL_CONNECTED,
  POLL_FAILING,
  POLL_UNREACHABLE,
  type ProbeResultLike,
} from './use-runtime-reconnect';
import {
  incrementSandboxFail,
  markRuntimeReadyVerified,
  noteRuntimeEvidence,
  requestRuntimeReconnect,
  resetForServerSwitch,
  resetSandboxFail,
  setOpenCodeHealth,
  setSandboxStatus,
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

describe('live SSE evidence vetoes probe failures', () => {
  test('a probe failure is ignored while runtime events are provably flowing', () => {
    // An SSE frame that arrived 2s ago is proof the runtime is reachable —
    // a slow/timed-out health probe on a loaded box must not override it.
    expect(shouldIgnoreProbeFailure(10_000 - 2_000, 10_000)).toBe(true);
  });

  test('a probe failure counts once the event stream has gone quiet', () => {
    expect(
      shouldIgnoreProbeFailure(60_000 - RUNTIME_EVIDENCE_FRESH_MS - 1, 60_000),
    ).toBe(false);
  });

  test('no recorded evidence never vetoes a failure', () => {
    expect(shouldIgnoreProbeFailure(null, 10_000)).toBe(false);
  });

  test('noteRuntimeEvidence records the arrival time in the store', () => {
    useSandboxConnectionStore.setState({ lastRuntimeEvidenceAt: null });
    noteRuntimeEvidence(1234);
    expect(useSandboxConnectionStore.getState().lastRuntimeEvidenceAt).toBe(1234);
  });
});

// T8 defect 1 — `useRuntimeReconnect`'s first-mount
// `resetForServerSwitch()` (called unconditionally here, matching the hook's
// own `if (isFirstMount) resetForServerSwitch();`) must converge to
// connected+healthy regardless of whether `useSession`'s mount-time seed
// (`markRuntimeReadyVerified()`, driven by `cachedStartResultIsReady` in
// `use-session.ts`) ran before or after it. Both orderings are exercised
// directly at the store level — this package has no hook-render harness, so
// this is the level everything in this file is already tested at.
describe('mount-time ordering: markRuntimeReadyVerified vs resetForServerSwitch', () => {
  // `markRuntimeReadyVerified`/`resetForServerSwitch` round-trip through
  // `sessionStorage` — this bun test environment has a `window` shim but no
  // `sessionStorage` (see `session-start-stash.test.ts` for the same shim),
  // so without this both silently no-op (caught, swallowed) and the test
  // would pass for the wrong reason.
  class MemoryStorage {
    private map = new Map<string, string>();
    getItem(key: string): string | null {
      return this.map.has(key) ? this.map.get(key)! : null;
    }
    setItem(key: string, value: string): void {
      this.map.set(key, value);
    }
    removeItem(key: string): void {
      this.map.delete(key);
    }
    clear(): void {
      this.map.clear();
    }
  }
  beforeEach(() => {
    (globalThis as any).sessionStorage = new MemoryStorage();
  });
  afterEach(() => {
    delete (globalThis as any).sessionStorage;
  });

  test('seed-then-reset: a flag set before the first-mount reset makes reset seed connected+healthy instead of clobbering it', () => {
    // `useSession`'s useIsomorphicLayoutEffect ran first (a cache-hit /start
    // — Task A's staleTime made `stage==='ready'` visible on this mount's
    // very first render, strictly before any `useEffect`, this reset
    // included).
    markRuntimeReadyVerified();

    // `useRuntimeReconnect`'s first-mount reset — a plain `useEffect`, always
    // fires after every `useLayoutEffect` in the tree.
    resetForServerSwitch();

    expect(useSandboxConnectionStore.getState()).toMatchObject({
      status: 'connected',
      healthy: true,
    });
  });

  test('reset-then-seed: reset runs first (no flag yet); the health-seed effect converges it directly afterward, unaffected by what reset just wrote', () => {
    // No cached ready result was visible yet — a genuine network /start,
    // still in flight when this mount's reset runs.
    resetForServerSwitch();
    expect(useSandboxConnectionStore.getState()).toMatchObject({
      status: 'connecting',
      healthy: null,
    });

    // /start resolves ready later; `useSession`'s health-seed effect (step 3)
    // writes the store directly once `switched` flips — `resetForServerSwitch`
    // never runs again for this mount (`useRuntimeReconnect` only calls it on
    // first mount), so nothing clobbers this.
    setSandboxStatus('connected');
    setOpenCodeHealth(true);

    expect(useSandboxConnectionStore.getState()).toMatchObject({
      status: 'connected',
      healthy: true,
    });
  });
});
