/**
 * BOUNDED SANDBOX LIFETIME — the authorship rule.
 *
 * The leak this whole feature exists to close is a SELF-RENEWING,
 * SANDBOX-AUTHORED extension. `access.kind === 'principal'` does not rule one
 * out: the box holds an executor token bound to its own session, so a request
 * it issues against itself authenticates perfectly. These tests pin the ONE
 * discriminator that separates the two — the credential's session binding.
 */
import { describe, expect, test } from 'bun:test';
import { observeControlPlaneEvent, observeExtension } from './observation';

describe('observeExtension', () => {
  test('refuses a box arming ITSELF — the exact shape of the leak', () => {
    expect(
      observeExtension({ principalSessionId: 'sess-a', recordSessionId: 'sess-a' }),
    ).toBeNull();
  });

  test('admits a browser/JWT caller, whose credential is not session-bound', () => {
    // Kortix-as-a-Backend shares ONE created_by across every end-user, so a null
    // session binding is the norm for real human traffic, not an edge case.
    expect(
      observeExtension({ principalSessionId: null, recordSessionId: 'sess-a' }),
    ).not.toBeNull();
  });

  test('admits one session-bound principal acting on a DIFFERENT session', () => {
    // A CLI session driving another session is a real, observed turn start.
    expect(
      observeExtension({ principalSessionId: 'sess-b', recordSessionId: 'sess-a' }),
    ).not.toBeNull();
  });

  test('reads the clock itself — a caller cannot supply the instant', () => {
    const before = Date.now();
    const proof = observeExtension({ principalSessionId: null, recordSessionId: 'sess-a' });
    const after = Date.now();
    expect(proof).not.toBeNull();
    expect(proof?.at.getTime()).toBeGreaterThanOrEqual(before);
    expect(proof?.at.getTime()).toBeLessThanOrEqual(after);
  });

  test('observeExtension takes exactly one argument, so no clock can be injected', () => {
    // Guards against a future "convenience" overload accepting an `at`.
    expect(observeExtension.length).toBe(1);
    expect(observeControlPlaneEvent.length).toBe(0);
  });
});

describe('the branded type (compile-time layer)', () => {
  test('a raw Date is not assignable where a proof is required', () => {
    // The real assertion is `tsc --noEmit`: `extendDeadline(t, ms, new Date())`
    // does not compile, because ObservedExtension is branded with a unique
    // symbol this file does not export. That is checked by
    // architecture.test.ts's guard-violation fixture, which compiles a file
    // that tries exactly that and asserts the compiler rejects it. This case
    // documents the intent next to the producer so the two are found together.
    const proof = observeControlPlaneEvent();
    expect(proof.at).toBeInstanceOf(Date);
  });
});
