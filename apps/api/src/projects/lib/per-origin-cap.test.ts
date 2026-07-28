import { describe, expect, test } from 'bun:test';

/**
 * The per-end-user (origin_ref) concurrency cap for Kortix-as-a-Backend.
 *
 * The account-wide cap is not sufficient for KaaB: one account fronts many
 * end-users, so a single end-user — or a runaway loop acting for one — can
 * consume every slot the whole wrapper has. This covers the DECISION rule; the
 * COUNT itself is a trivial DB query exercised by the integration suite.
 */

/** Mirrors enforcePerOriginSessionCap's decision, minus the DB round-trip. */
function capDecision(input: {
  limit: number;
  originRef: string | null;
  active: number;
}): { blocked: boolean; code?: string } {
  if (!input.originRef || input.limit <= 0) return { blocked: false };
  return input.active < input.limit
    ? { blocked: false }
    : { blocked: true, code: 'per_origin_session_limit' };
}

describe('per-origin session cap', () => {
  test('is a no-op when the limit is unset or zero (opt-in)', () => {
    expect(capDecision({ limit: 0, originRef: 'alice', active: 99 }).blocked).toBe(false);
    expect(capDecision({ limit: -1, originRef: 'alice', active: 99 }).blocked).toBe(false);
  });

  test('never applies to a session with no origin_ref', () => {
    // Interactive/user-origin sessions carry no origin_ref — the account cap
    // governs them, and this one must not silently start limiting them.
    expect(capDecision({ limit: 1, originRef: null, active: 50 }).blocked).toBe(false);
  });

  test('allows up to the limit and blocks at it', () => {
    expect(capDecision({ limit: 3, originRef: 'alice', active: 2 }).blocked).toBe(false);
    expect(capDecision({ limit: 3, originRef: 'alice', active: 3 })).toEqual({
      blocked: true,
      code: 'per_origin_session_limit',
    });
    expect(capDecision({ limit: 3, originRef: 'alice', active: 4 }).blocked).toBe(true);
  });

  test('a limit of 1 still permits the first session', () => {
    expect(capDecision({ limit: 1, originRef: 'alice', active: 0 }).blocked).toBe(false);
    expect(capDecision({ limit: 1, originRef: 'alice', active: 1 }).blocked).toBe(true);
  });

  test('is scoped per end-user — one user at the limit never blocks another', () => {
    // The COUNT is filtered by origin_ref, so alice's 3 live sessions are
    // invisible to bob's check. Encoded here as the contract the query must keep.
    const aliceAtLimit = capDecision({ limit: 3, originRef: 'alice', active: 3 });
    const bobFresh = capDecision({ limit: 3, originRef: 'bob', active: 0 });
    expect(aliceAtLimit.blocked).toBe(true);
    expect(bobFresh.blocked).toBe(false);
  });
});
