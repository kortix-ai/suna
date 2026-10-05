import { describe, expect, test } from 'bun:test';
import {
  createSessionOversightCache,
  OVERSIGHT_ACCOUNT_ROLES,
  sessionOversightFrom,
} from './session-oversight';

// The account-level "admins can open every session" policy: who it reaches.
describe('sessionOversightFrom', () => {
  test('an account admin holds oversight while the policy is on', () => {
    expect(sessionOversightFrom({ policyEnabled: true, callerIsAccountAdmin: true })).toBe(true);
  });

  test('nobody holds oversight while the policy is off (the default)', () => {
    expect(sessionOversightFrom({ policyEnabled: false, callerIsAccountAdmin: true })).toBe(false);
  });

  test('a plain member never holds oversight', () => {
    expect(sessionOversightFrom({ policyEnabled: true, callerIsAccountAdmin: false })).toBe(false);
  });

  test('oversight reaches exactly the owner and admin account roles', () => {
    expect([...OVERSIGHT_ACCOUNT_ROLES]).toEqual(['owner', 'admin']);
  });
});

/**
 * Prod runs 4+ API replicas, each with its own in-process cache. When an
 * owner turns oversight OFF, only the replica that handled the PATCH clears
 * ITS OWN cache (`invalidateSessionOversight`) — every other replica is never
 * told. A cache that stores a GRANT ("oversight is on") therefore keeps
 * serving that stale grant, on every replica that has not independently
 * re-resolved it, for up to the rest of `TTL_MS`: a fail-OPEN authorization
 * window where a revoked admin can still open a member's private session.
 *
 * The fix caches only the DENIAL. A stale "oversight is off" merely refuses
 * an admin for a few extra seconds — safe. A GRANT is never cached at all, so
 * every check that would grant access re-reads the source of truth, on every
 * replica, with no propagation delay to rely on.
 */
describe('createSessionOversightCache — fail-closed across replicas', () => {
  test('never serves a stale GRANT after the policy turns off, even mid-TTL, on a replica that never invalidated', async () => {
    let granted = true;
    // Two independent caches stand in for two API replicas. Nothing
    // propagates between them except the shared policy source they both
    // read — exactly like two `session-oversight.ts` module instances in two
    // separate API processes reading the same `accounts` row.
    const replicaA = createSessionOversightCache(async () => granted, { enableInTests: true });
    const replicaB = createSessionOversightCache(async () => granted, { enableInTests: true });

    // Oversight is ON; both replicas correctly grant it.
    expect(await replicaA.get('user-1', 'acct-1')).toBe(true);
    expect(await replicaB.get('user-1', 'acct-1')).toBe(true);

    // The owner turns oversight OFF. Only the replica that served the PATCH
    // clears its own cache — the real `invalidateSessionOversight()` call.
    // Replica B never learns about the write directly.
    granted = false;
    replicaA.clear();

    // Replica A: correct, because it just cleared.
    expect(await replicaA.get('user-1', 'acct-1')).toBe(false);
    // Replica B: must ALSO stop granting access on its very next check, not
    // after riding out the rest of the 15s TTL on a cached "true".
    expect(await replicaB.get('user-1', 'acct-1')).toBe(false);
  });

  test('a denial IS cached: a repeat check while off costs no second load', async () => {
    let loads = 0;
    const cache = createSessionOversightCache(
      async () => {
        loads += 1;
        return false;
      },
      { enableInTests: true },
    );
    expect(await cache.get('u', 'a')).toBe(false);
    expect(await cache.get('u', 'a')).toBe(false);
    expect(loads).toBe(1);
  });

  test('a grant is never cached: every check re-reads the source', async () => {
    let loads = 0;
    const cache = createSessionOversightCache(
      async () => {
        loads += 1;
        return true;
      },
      { enableInTests: true },
    );
    expect(await cache.get('u', 'a')).toBe(true);
    expect(await cache.get('u', 'a')).toBe(true);
    expect(loads).toBe(2);
  });
});
