import { describe, expect, test } from 'bun:test';
import { decideParkedRuntime, decideRemovedParkedOutcome } from './parked-runtime-verification';

/**
 * Incident 2026-08-12 (Platinum deleted a parked sandbox while it held a
 * completed backup). The Kortix-side finding this file exists for:
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
  const base = {
    providerStatus: 'stopped',
    identityState: null,
    wakeInProgress: false,
    stopPending: false,
  };

  test('a `removed` parked row is not condemned until the recovery gate answers', () => {
    // `getStatus` collapses `failed-start`, `deleted`, `lost` and a 404 into
    // `removed`. Only `recoverInPlace` can tell a restorable box from a gone one,
    // so the sweep must ask it before it writes a permanent loss.
    expect(decideParkedRuntime({ ...base, providerStatus: 'removed' })).toBe('attempt-recovery');
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
    expect(decideParkedRuntime({ ...base, providerStatus: 'removed', wakeInProgress: true })).toBe(
      'skip',
    );
    expect(
      decideParkedRuntime({
        ...base,
        providerStatus: 'running',
        identityState: 'unavailable',
        wakeInProgress: true,
      }),
    ).toBe('skip');
  });

  test('a running provider with a durable stop intent is stopped again', () => {
    expect(
      decideParkedRuntime({
        ...base,
        providerStatus: 'running',
        stopPending: true,
      }),
    ).toBe('stop-pending');
  });

  test('a stopped provider with durable stop intent still closes compute before cleanup', () => {
    expect(decideParkedRuntime({ ...base, stopPending: true })).toBe('settle-stop-pending');
  });

  test('a wake fence outranks a stale stop intent', () => {
    expect(
      decideParkedRuntime({
        ...base,
        providerStatus: 'running',
        stopPending: true,
        wakeInProgress: true,
      }),
    ).toBe('skip');
  });

  test('an inconclusive provider status retains durable stop intent', () => {
    for (const providerStatus of ['unknown', 'terminal', 'starting']) {
      expect(decideParkedRuntime({ ...base, providerStatus, stopPending: true })).toBe('skip');
    }
  });

  test('an ordinary healthy parked row is just stamped as verified', () => {
    expect(decideParkedRuntime(base)).toBe('verified');
  });

  // Mid-restore states must not be read as "it is back" — the restore can still
  // fail, and healing early would un-flag a session that is about to stay dead.
  test('a mid-restore state is not yet proof the runtime is back', () => {
    for (const providerStatus of ['restoring', 'starting', 'provisioning']) {
      expect(decideParkedRuntime({ ...base, providerStatus, identityState: 'unavailable' })).toBe(
        'skip',
      );
    }
  });
});

/**
 * The `parked_runtime_removed` pattern (Better Stack `24ac0e9a`): the parked
 * sweep saw `getStatus() === 'removed'` and wrote a permanent loss without ever
 * asking the provider whether the runtime could be recovered in place. Every
 * occurrence was a distinct box, one report each — not a repeat flood — but a
 * `failed-start` box that had booted before, or a tombstoned box with a
 * completed backup, was condemned before any user opened it while the `/start`
 * open path would have recovered it.
 */
describe('decideRemovedParkedOutcome', () => {
  const never = async () => {
    throw new Error('must not be called');
  };

  test('a recovering provider is never reported lost and is marked recovered', async () => {
    const marked: string[] = [];
    const outcome = await decideRemovedParkedOutcome({
      externalId: 'sbx_test',
      recoverInPlace: async () => 'recovering',
      claim: async () => true,
      markRecovered: async (recovery) => {
        marked.push(recovery);
        return true;
      },
    });
    expect(outcome).toBe('recovered');
    expect(marked).toEqual(['recovering']);
  });

  test('a running provider is recorded as an in-place recovery', async () => {
    const marked: string[] = [];
    const outcome = await decideRemovedParkedOutcome({
      externalId: 'sbx_test',
      recoverInPlace: async () => 'running',
      claim: async () => true,
      markRecovered: async (recovery) => {
        marked.push(recovery);
        return true;
      },
    });
    expect(outcome).toBe('recovered');
    expect(marked).toEqual(['running']);
  });

  test('an explicit unavailable authorizes the loss', async () => {
    const outcome = await decideRemovedParkedOutcome({
      externalId: 'sbx_test',
      recoverInPlace: async () => 'unavailable',
      claim: async () => true,
      markRecovered: never,
    });
    expect(outcome).toBe('preserve-lost');
  });

  test('a provider that cannot recover in place keeps the historical preserve', async () => {
    const outcome = await decideRemovedParkedOutcome({
      externalId: 'sbx_test',
      recoverInPlace: undefined,
      claim: never,
      markRecovered: never,
    });
    expect(outcome).toBe('preserve-lost');
  });

  test('a recovery already owned by another caller is left alone', async () => {
    const outcome = await decideRemovedParkedOutcome({
      externalId: 'sbx_test',
      recoverInPlace: never,
      claim: async () => false,
      markRecovered: never,
    });
    expect(outcome).toBe('recovery-in-flight');
  });

  test('a losing mark write does not report a loss', async () => {
    const outcome = await decideRemovedParkedOutcome({
      externalId: 'sbx_test',
      recoverInPlace: async () => 'recovering',
      claim: async () => true,
      markRecovered: async () => false,
    });
    expect(outcome).toBe('recovery-in-flight');
  });

  test('a provider throw is read as unavailable, not as a recovery', async () => {
    const outcome = await decideRemovedParkedOutcome({
      externalId: 'sbx_test',
      recoverInPlace: async () => {
        throw new Error('provider down');
      },
      claim: async () => true,
      markRecovered: never,
    });
    expect(outcome).toBe('preserve-lost');
  });
});
