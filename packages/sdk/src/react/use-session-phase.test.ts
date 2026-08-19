// The reopen-panic rule. A health 503 that races a live /start is NOT a failure —
// it is the ordinary shape of waking a parked box.
import { describe, expect, test } from 'bun:test';
import { derivePhase } from './use-session-phase';

const RUNTIME_503 = { status: 503, body: { error: 'sandbox not ready (status: stopped)' } };
const base = { terminal: false, startError: null, runtimeError: null, startSettled: false, switched: false };

describe('derivePhase', () => {
  test('a runtime 503 while /start is still working reads as starting, not error', () => {
    expect(derivePhase({ ...base, runtimeError: RUNTIME_503 })).toBe('starting');
  });

  test('the same 503 after /start has settled is a real error', () => {
    expect(derivePhase({ ...base, runtimeError: RUNTIME_503, startSettled: true })).toBe('error');
  });

  test('a /start error is terminal immediately — nothing else is coming', () => {
    expect(derivePhase({ ...base, startError: new Error('nope') })).toBe('error');
  });

  test('a terminal stage is an error regardless of /start', () => {
    expect(derivePhase({ ...base, terminal: true })).toBe('error');
  });

  test('switched with no error is ready', () => {
    expect(derivePhase({ ...base, switched: true })).toBe('ready');
  });

  // PRECEDENCE, not clairvoyance. `derivePhase` cannot tell a removed runtime
  // from a parked one and this test does not claim it can: a provider_removed
  // row answers the proxy with the same `sandbox not ready (status: stopped)`
  // string a waking box does, and the copy the user reads is chosen downstream
  // from that raw string, not here. What is pinned is that the `terminal`
  // branch is checked FIRST, so a 503 arriving alongside a terminal /start
  // stage cannot pull the phase back down to 'starting'. That a removed
  // runtime never renders as waking on apps/web follows from /start reporting
  // stage 'failed'/'stopped' — this branch shadowing the 503 one — and not
  // from anything derivePhase knows about the error.
  test('a terminal stage wins over a runtime 503 that arrives with it', () => {
    expect(derivePhase({ ...base, terminal: true, runtimeError: RUNTIME_503 })).toBe('error');
  });

  // T17 — PR #6273's own text flagged this branch ("unguarded seam 2")
  // as shipped with no dedicated regression test beyond the two cases above.
  // These pin the `startSettled` gate on `runtimeError` from more angles, so a
  // future edit that drops it (`if (input.runtimeError) return 'error';`,
  // un-gated) cannot pass silently no matter which input combination changes
  // first. See this task's MUTATION CHECK for the real red output from that
  // exact mutation.
  describe('the startSettled gate on runtimeError — extra coverage (T17)', () => {
    test('runtimeError present, startSettled false, switched true: still "starting", not "error"', () => {
      // `switched` only matters on the error-free path (line 27) — an
      // in-flight runtimeError must keep blocking "ready" AND must not leak
      // into "error" just because the sandbox already switched in.
      expect(derivePhase({ ...base, runtimeError: RUNTIME_503, switched: true })).toBe('starting');
    });

    test('runtimeError present, startSettled true, switched true: settles to "error", not "ready"', () => {
      expect(
        derivePhase({ ...base, runtimeError: RUNTIME_503, startSettled: true, switched: true }),
      ).toBe('error');
    });

    test('a non-503 runtimeError is gated identically — the gate is on startSettled, not the error shape', () => {
      const genericError = new Error('boom');
      expect(derivePhase({ ...base, runtimeError: genericError })).toBe('starting');
      expect(derivePhase({ ...base, runtimeError: genericError, startSettled: true })).toBe('error');
    });

    test('startSettled flipping true->false cannot un-error a runtime error once terminal is also true', () => {
      // terminal (line 24) is checked before the runtimeError/startSettled
      // branch (line 25) and never depends on startSettled — regardless of
      // its value, a terminal stage is always 'error'.
      expect(
        derivePhase({ ...base, terminal: true, runtimeError: RUNTIME_503, startSettled: false }),
      ).toBe('error');
      expect(
        derivePhase({ ...base, terminal: true, runtimeError: RUNTIME_503, startSettled: true }),
      ).toBe('error');
    });
  });
});
