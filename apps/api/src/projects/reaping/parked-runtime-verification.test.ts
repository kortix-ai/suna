import { describe, expect, test } from 'bun:test';
import { decideParkedRuntime } from './parked-runtime-verification';

/**
 * Incident 2026-08-12 (Platinum deleted sbx_01KZP370WDB8DGYNAQM1B875VR while it
 * held a completed backup). The Kortix-side finding this file exists for:
 *
 * NOTHING EVER RE-VERIFIED A PARKED SANDBOX. The box reaper's candidate
 * predicate is `status = 'active'` (reaping/box-queries.ts), and the wake
 * reconciler only looks at rows with a live wake fence. A row that is parked and
 * then left alone was never asked about again — so when the provider lost it,
 * Kortix kept advertising it as resumable until a human happened to open it.
 *
 * Measured on prod 2026-08-13: 16,243 parked rows had never been re-verified,
 * and 16 of them were already dead provider-side without Kortix knowing.
 */
describe('decideParkedRuntime', () => {
  const base = { providerStatus: 'stopped', identityState: null, wakeInProgress: false };

  test('a definitive `removed` on a healthy-looking parked row preserves the identity', () => {
    expect(decideParkedRuntime({ ...base, providerStatus: 'removed' })).toBe('preserve-lost');
  });

  test('an already-recorded loss is not re-reported on every rotation', () => {
    expect(
      decideParkedRuntime({ ...base, providerStatus: 'removed', identityState: 'unavailable' }),
    ).toBe('skip');
  });

  // The self-heal half. Without it, a sandbox that is genuinely restored (as 25
  // were on 2026-08-13) stays flagged `unavailable` forever and the session
  // keeps showing "this session's computer was lost" over a working box. That
  // state had to be cleared by hand during the incident — which is the proof
  // that the platform must clear it itself.
  test('a runtime that is provably back clears the unavailable flag', () => {
    for (const providerStatus of ['stopped', 'running']) {
      expect(decideParkedRuntime({ ...base, providerStatus, identityState: 'unavailable' })).toBe(
        'heal-restored',
      );
    }
  });

  // `unknown` is the answer a timeout/5xx produces. It is not existence proof in
  // either direction: healing on it would resurrect a genuinely dead session,
  // and preserving on it would kill a healthy one over one bad round-trip.
  test('`unknown` never heals and never condemns', () => {
    expect(decideParkedRuntime({ ...base, providerStatus: 'unknown' })).toBe('verified');
    expect(
      decideParkedRuntime({ ...base, providerStatus: 'unknown', identityState: 'unavailable' }),
    ).toBe('skip');
  });

  // A terminal provider state means the box EXISTS but is broken. It is not a
  // removal, so it must not trip the identity-loss path.
  test('a terminal-but-present box is not treated as lost', () => {
    expect(decideParkedRuntime({ ...base, providerStatus: 'terminal' })).toBe('verified');
  });

  test('an in-flight wake is left entirely to the wake fence', () => {
    expect(
      decideParkedRuntime({ ...base, providerStatus: 'removed', wakeInProgress: true }),
    ).toBe('skip');
    expect(
      decideParkedRuntime({
        ...base,
        providerStatus: 'running',
        identityState: 'unavailable',
        wakeInProgress: true,
      }),
    ).toBe('skip');
  });

  test('an ordinary healthy parked row is just stamped as verified', () => {
    expect(decideParkedRuntime(base)).toBe('verified');
  });

  // Mid-restore states must not be read as "it is back" — the restore can still
  // fail, and healing early would un-flag a session that is about to stay dead.
  test('a mid-restore state is not yet proof the runtime is back', () => {
    for (const providerStatus of ['restoring', 'starting', 'provisioning']) {
      expect(
        decideParkedRuntime({ ...base, providerStatus, identityState: 'unavailable' }),
      ).toBe('skip');
    }
  });
});
