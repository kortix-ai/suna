import { afterEach, describe, expect, test } from 'bun:test';
import {
  EXECUTION_LEASE_METADATA_KEYS,
  decideExecutionLeaseWrite,
  executionLeaseStartedAtOf,
  executionLeaseUntilOf,
  hasActiveExecutionLease,
  leaseCeilingEnforced,
  maxLeaseHeldMs,
} from './execution-lease';

describe('execution lease policy', () => {
  const now = new Date('2026-07-11T20:00:00.000Z');
  test('vetoes stop only while the lease is live', () => {
    expect(hasActiveExecutionLease({ executionLeaseUntil: '2026-07-11T20:00:01.000Z' }, now)).toBe(
      true,
    );
    expect(hasActiveExecutionLease({ executionLeaseUntil: '2026-07-11T20:00:00.000Z' }, now)).toBe(
      false,
    );
  });
  test('fails closed on malformed or missing timestamps', () => {
    expect(executionLeaseUntilOf({ executionLeaseUntil: 'bad' })).toBeNull();
    expect(hasActiveExecutionLease(null, now)).toBe(false);
  });
});

describe('cumulative execution lease ceiling', () => {
  const now = new Date('2026-07-29T20:00:00.000Z');
  const ceilingMs = 6 * 60 * 60_000;
  const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();

  test('anchors the first lease write at now and allows it', () => {
    const decision = decideExecutionLeaseWrite({ metadata: null, now, ceilingMs });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error('unreachable');
    expect(decision.heldMs).toBe(0);
    expect(decision.patch.executionLeaseStartedAt).toBe(now.toISOString());
  });

  test('carries the original anchor forward instead of advancing it', () => {
    const anchor = at(3 * 60 * 60_000);
    const decision = decideExecutionLeaseWrite({
      metadata: { executionLeaseStartedAt: anchor, executionLeaseUntil: at(30_000) },
      now,
      ceilingMs,
    });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error('unreachable');
    expect(decision.patch.executionLeaseStartedAt).toBe(anchor);
    expect(decision.heldMs).toBe(3 * 60 * 60_000);
  });

  test('refuses a renew once the lease has been held past the ceiling', () => {
    const decision = decideExecutionLeaseWrite({
      metadata: { executionLeaseStartedAt: at(ceilingMs) },
      now,
      ceilingMs,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.heldMs).toBe(ceilingMs);
  });

  test('refuses the 264-hour immortal box measured in production', () => {
    const decision = decideExecutionLeaseWrite({
      metadata: { executionLeaseStartedAt: at(264 * 60 * 60_000) },
      now,
      ceilingMs,
    });
    expect(decision.allowed).toBe(false);
  });

  test('still allows a renew one millisecond before the ceiling', () => {
    const decision = decideExecutionLeaseWrite({
      metadata: { executionLeaseStartedAt: at(ceilingMs - 1) },
      now,
      ceilingMs,
    });
    expect(decision.allowed).toBe(true);
  });

  test('a future-dated anchor cannot buy immortality', () => {
    const decision = decideExecutionLeaseWrite({
      metadata: { executionLeaseStartedAt: new Date(now.getTime() + 86_400_000).toISOString() },
      now,
      ceilingMs,
    });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error('unreachable');
    expect(decision.patch.executionLeaseStartedAt).toBe(now.toISOString());
    expect(decision.heldMs).toBe(0);
  });

  test('a malformed anchor is treated as a fresh anchor, never as unbounded', () => {
    expect(executionLeaseStartedAtOf({ executionLeaseStartedAt: 'not-a-date' })).toBeNull();
    const decision = decideExecutionLeaseWrite({
      metadata: { executionLeaseStartedAt: 'not-a-date' },
      now,
      ceilingMs,
    });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error('unreachable');
    expect(decision.patch.executionLeaseStartedAt).toBe(now.toISOString());
  });

  test('the kill switch restores unbounded renewal', () => {
    const decision = decideExecutionLeaseWrite({
      metadata: { executionLeaseStartedAt: at(264 * 60 * 60_000) },
      now,
      ceilingMs,
      enforced: false,
    });
    expect(decision.allowed).toBe(true);
  });
});

describe('only a control-plane wake restores lease eligibility', () => {
  const now = new Date('2026-07-29T20:00:00.000Z');
  const ceilingMs = 6 * 60 * 60_000;
  const exhausted = {
    executionLeaseStartedAt: new Date(now.getTime() - 40 * 3_600_000).toISOString(),
    executionLeaseUntil: new Date(now.getTime() - 30_000).toISOString(),
    source: 'trigger:cron',
  };

  test('the wake key list covers every key the lease writes', () => {
    const decision = decideExecutionLeaseWrite({ metadata: null, now, ceilingMs });
    if (!decision.allowed) throw new Error('unreachable');
    const leaseOwned = Object.keys(decision.patch).filter((key) =>
      key.startsWith('executionLease'),
    );
    const wakeKeys: string[] = [...EXECUTION_LEASE_METADATA_KEYS];
    expect(leaseOwned.length).toBeGreaterThan(0);
    for (const key of leaseOwned) expect(wakeKeys).toContain(key);
  });

  test('deleting the wake keys makes an exhausted box leasable again', () => {
    expect(decideExecutionLeaseWrite({ metadata: exhausted, now, ceilingMs }).allowed).toBe(false);

    const woken: Record<string, unknown> = { ...exhausted };
    for (const key of EXECUTION_LEASE_METADATA_KEYS) delete woken[key];

    const afterWake = decideExecutionLeaseWrite({ metadata: woken, now, ceilingMs });
    expect(afterWake.allowed).toBe(true);
    expect(woken.source).toBe('trigger:cron');
  });
});

describe('the lease write must not forge the activity clock', () => {
  const now = new Date('2026-07-29T20:00:00.000Z');
  const ceilingMs = 6 * 60 * 60_000;

  test('an acquire never stamps lastTurnAt', () => {
    const decision = decideExecutionLeaseWrite({ metadata: null, now, ceilingMs });
    if (!decision.allowed) throw new Error('unreachable');
    expect(Object.keys(decision.patch)).not.toContain('lastTurnAt');
  });

  test('a renew never stamps lastTurnAt and leaves an existing one untouched', () => {
    const stale = '2026-07-20T04:00:00.000Z';
    const decision = decideExecutionLeaseWrite({
      metadata: {
        executionLeaseStartedAt: '2026-07-29T19:00:00.000Z',
        lastTurnAt: stale,
      },
      now,
      ceilingMs,
    });
    if (!decision.allowed) throw new Error('unreachable');
    expect(Object.keys(decision.patch)).not.toContain('lastTurnAt');
    expect(decision.patch.executionLeaseUntil).toBe('2026-07-29T20:02:00.000Z');
  });
});

describe('execution lease ceiling configuration', () => {
  const originalMinutes = process.env.KORTIX_EXECUTION_LEASE_MAX_HELD_MINUTES;
  const originalEnabled = process.env.KORTIX_EXECUTION_LEASE_CEILING_ENABLED;

  afterEach(() => {
    if (originalMinutes === undefined) delete process.env.KORTIX_EXECUTION_LEASE_MAX_HELD_MINUTES;
    else process.env.KORTIX_EXECUTION_LEASE_MAX_HELD_MINUTES = originalMinutes;
    if (originalEnabled === undefined) delete process.env.KORTIX_EXECUTION_LEASE_CEILING_ENABLED;
    else process.env.KORTIX_EXECUTION_LEASE_CEILING_ENABLED = originalEnabled;
  });

  test('defaults to a 6 hour ceiling, enforced', () => {
    delete process.env.KORTIX_EXECUTION_LEASE_MAX_HELD_MINUTES;
    delete process.env.KORTIX_EXECUTION_LEASE_CEILING_ENABLED;
    expect(maxLeaseHeldMs()).toBe(6 * 60 * 60_000);
    expect(leaseCeilingEnforced()).toBe(true);
  });

  test('is overridable and disengageable by env', () => {
    process.env.KORTIX_EXECUTION_LEASE_MAX_HELD_MINUTES = '90';
    process.env.KORTIX_EXECUTION_LEASE_CEILING_ENABLED = 'false';
    expect(maxLeaseHeldMs()).toBe(90 * 60_000);
    expect(leaseCeilingEnforced()).toBe(false);
  });
});
