import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  classifyProbeResult,
  computeFailureStatus,
  FAIL_THRESHOLD_FIRST,
  FAIL_THRESHOLD_RECONNECT,
  isImmediateOfflineSignal,
  isImmediateOfflineStatus,
  nextPollDelay,
  runtimeErrorFromHealth,
  RUNTIME_EVIDENCE_FRESH_MS,
  shouldCountProbeFailure,
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
  return {
    status: 200,
    ok: true,
    health: null,
    body: '',
    hop: null,
    upstreamStatus: null,
    ...overrides,
  };
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
      hop: null,
      upstreamStatus: null,
    });
    expect(classifyProbeResult(probe({ status: 500, ok: false, body: 'internal error' }))).toEqual({
      kind: 'failure',
      immediateOffline: false,
      hop: null,
      upstreamStatus: null,
    });
  });

  test('a 0.12.8-shaped result still compiles and classifies as unattributed', () => {
    // `ProbeResultLike` is published on `@kortix/sdk/react` and appears only in
    // INPUT position — constructing one is the ONLY way to call
    // `classifyProbeResult`. Making `hop`/`upstreamStatus` required would break
    // every external caller at compile time, so they are optional and read as
    // null. This literal is exactly what 0.12.8's `.d.ts` allows.
    const published: ProbeResultLike = { status: 502, ok: false, health: null, body: '' };

    expect(classifyProbeResult(published)).toEqual({
      kind: 'failure',
      immediateOffline: true,
      hop: null,
      upstreamStatus: null,
    });
  });

  test('a failure carries the proxy hop through untouched, so the caller can weigh it', () => {
    expect(
      classifyProbeResult(
        probe({ status: 502, ok: false, hop: 'upstream_port', upstreamStatus: 502 }),
      ),
    ).toEqual({
      kind: 'failure',
      immediateOffline: true,
      hop: 'upstream_port',
      upstreamStatus: 502,
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

// The SSE-evidence veto STAYS. It is not the hop gate's weaker predecessor —
// the two cover disjoint failures, and the one the veto covers is the one the
// hop cannot name (see `shouldCountProbeFailure`).
// `bootingSinceAt` bounds the one case `failCount`/`unreachable` structurally
// cannot: a sandbox proxy that keeps answering 503 ("booting") resets
// `failCount` to 0 on every tick (see `classifyProbeResult`), so `unreachable`
// never fires no matter how long OpenCode stays wedged mid-boot. This clock —
// set while not healthy, cleared the instant it is — is what
// `useRuntimeBootStalled()` reads to give that case a time bound anyway.
describe('bootingSinceAt tracks the not-yet-healthy stretch', () => {
  test('setOpenCodeHealth(false) arms the clock once, not on every call', () => {
    useSandboxConnectionStore.setState({ bootingSinceAt: null });
    setOpenCodeHealth(false);
    const first = useSandboxConnectionStore.getState().bootingSinceAt;
    expect(first).not.toBeNull();

    setOpenCodeHealth(false);
    expect(useSandboxConnectionStore.getState().bootingSinceAt).toBe(first);
  });

  test('setOpenCodeHealth(true) clears it', () => {
    useSandboxConnectionStore.setState({ bootingSinceAt: Date.now() - 60_000 });
    setOpenCodeHealth(true);
    expect(useSandboxConnectionStore.getState().bootingSinceAt).toBeNull();
  });

  test('requestRuntimeReconnect gives the clock a fresh start', () => {
    const stale = Date.now() - 120_000;
    useSandboxConnectionStore.setState({ bootingSinceAt: stale });
    requestRuntimeReconnect();
    const next = useSandboxConnectionStore.getState().bootingSinceAt;
    expect(next).not.toBeNull();
    expect(next).not.toBe(stale);
  });

  test('resetForServerSwitch (plain path) arms the clock for the new mount', () => {
    useSandboxConnectionStore.setState({ bootingSinceAt: null });
    resetForServerSwitch();
    expect(useSandboxConnectionStore.getState().bootingSinceAt).not.toBeNull();
  });

  // RC-3 — a PARKED sandbox (the platform answered from the session row without
  // dialling the box: `hop === 'control_plane'`) is not booting. Arming the
  // stall clock for it escalates an idle session to "Still waking… taking
  // longer than usual" forever, because nothing is actually starting and the
  // 503 repeats on every 150ms tick. The parked path must NOT arm the clock,
  // and must clear one a prior mount armed.
  test('setOpenCodeHealth(parked) does NOT arm the boot-stall clock', () => {
    useSandboxConnectionStore.setState({ bootingSinceAt: null });
    setOpenCodeHealth(false, undefined, null, { parked: true });
    expect(useSandboxConnectionStore.getState().bootingSinceAt).toBeNull();
  });

  test('setOpenCodeHealth(parked) clears a clock a prior mount armed', () => {
    useSandboxConnectionStore.setState({ bootingSinceAt: Date.now() - 60_000 });
    setOpenCodeHealth(false, undefined, null, { parked: true });
    expect(useSandboxConnectionStore.getState().bootingSinceAt).toBeNull();
  });

  test('a genuine booting box (no parked flag) still arms the clock', () => {
    useSandboxConnectionStore.setState({ bootingSinceAt: null });
    setOpenCodeHealth(false);
    expect(useSandboxConnectionStore.getState().bootingSinceAt).not.toBeNull();
  });
});

// RC-1 — a normal cold boot returns `{status:'starting', reason:'schema not
// ready'}` (503). That `reason` used to land in `store.runtimeError`, and the
// route painted a terminal "OpenCode runtime is not ready" card from it. Only
// a genuine `boot_error` is an error; `reason`/`message`/`status` are routine
// progress and must NEVER become the store's runtimeError.
describe('runtimeErrorFromHealth — only a real boot_error is an error', () => {
  test('surfaces boot_error when present', () => {
    expect(runtimeErrorFromHealth({ boot_error: 'daemon crashed at import' })).toBe(
      'daemon crashed at import',
    );
  });

  test('routine boot progress (reason/message/status) is NOT an error', () => {
    expect(runtimeErrorFromHealth({ status: 'starting', reason: 'schema not ready' })).toBeNull();
    expect(runtimeErrorFromHealth({ message: 'booting' })).toBeNull();
    expect(runtimeErrorFromHealth({ status: 'starting' })).toBeNull();
  });

  test('null/empty health carries no error', () => {
    expect(runtimeErrorFromHealth(null)).toBeNull();
    expect(runtimeErrorFromHealth({})).toBeNull();
  });
});

describe('live SSE evidence vetoes probe failures', () => {
  test('a probe failure is ignored while runtime events are provably flowing', () => {
    // An SSE frame that arrived 2s ago is proof the runtime is reachable —
    // a slow/timed-out health probe on a loaded box must not override it.
    expect(shouldIgnoreProbeFailure(10_000 - 2_000, 10_000)).toBe(true);
  });

  test('a probe failure counts once the event stream has gone quiet', () => {
    expect(shouldIgnoreProbeFailure(60_000 - RUNTIME_EVIDENCE_FRESH_MS - 1, 60_000)).toBe(false);
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

// The hop gate ADDS to the veto above; it does not replace it. Both inputs are
// read in one place so the interaction is asserted rather than assumed — the
// hook itself has no render harness in this repo.
describe('shouldCountProbeFailure — only failures that mean "the runtime is gone"', () => {
  const quiet = { lastRuntimeEvidenceAt: null, nowMs: 10_000 };

  test('a provider ingress failure counts: the box itself did not answer', () => {
    expect(shouldCountProbeFailure({ hop: 'provider_ingress', ...quiet })).toBe(true);
  });

  test('a daemon failure counts: the runtime process did not answer', () => {
    expect(shouldCountProbeFailure({ hop: 'daemon', ...quiet })).toBe(true);
  });

  test('a control-plane answer never counts — it is an answer, not silence', () => {
    // `503 sandbox not ready (status: stopped)` is the control plane telling us
    // the row is parked. The box being parked is not the box being unreachable,
    // and treating it as such is what drove the runtime to "unreachable" while
    // `/start` was still resuming it.
    expect(shouldCountProbeFailure({ hop: 'control_plane', ...quiet })).toBe(false);
  });

  test("an upstream-port failure never counts — that is the user's own process", () => {
    // The single worst symptom this closes: a dev server the agent has not
    // started yet made the whole session render "Waking this session up…".
    expect(shouldCountProbeFailure({ hop: 'upstream_port', ...quiet })).toBe(false);
  });

  test('an unattributed failure counts when nothing else is answering', () => {
    // A network error, a `CHECK_TIMEOUT` abort, or a response from something
    // that is not our proxy carries no hop. Refusing to count those would mean
    // a browser that lost the network never leaves "connected" — the reconnect
    // poller would stop doing its only job.
    expect(shouldCountProbeFailure({ hop: null, ...quiet })).toBe(true);
  });

  // THE INCIDENT (2026-08-17, Essentia): a box saturated by a heavy turn streams
  // SSE frames fine and misses the 20s probe deadline. The abort carries NO hop,
  // and a proxy 502 raised from the same saturation carries `daemon` — both
  // "count" on hop alone, so two misses flip the session to `unreachable`, the
  // SSE stream (gated on `sandboxStatus === 'connected'`) is torn down mid-turn
  // and the transcript freezes. The hop cannot see this; the frame can.
  test('a timed-out probe does NOT count while frames are still arriving', () => {
    expect(shouldCountProbeFailure({ hop: null, lastRuntimeEvidenceAt: 8_000, nowMs: 10_000 })).toBe(
      false,
    );
  });

  test('a daemon-attributed failure does NOT count while frames are still arriving', () => {
    expect(
      shouldCountProbeFailure({ hop: 'daemon', lastRuntimeEvidenceAt: 8_000, nowMs: 10_000 }),
    ).toBe(false);
  });

  test('a daemon failure counts again once the frames stop', () => {
    expect(
      shouldCountProbeFailure({
        hop: 'daemon',
        lastRuntimeEvidenceAt: 10_000 - RUNTIME_EVIDENCE_FRESH_MS,
        nowMs: 10_000,
      }),
    ).toBe(true);
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
