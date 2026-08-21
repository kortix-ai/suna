import { describe, expect, test } from 'bun:test';

import { InflightBudget } from './inflight-budget';

const MiB = 1024 * 1024;

describe('InflightBudget', () => {
  test('admits a request that fits', () => {
    const b = new InflightBudget({ maxBytes: 100, perRequestMaxBytes: 100, amplification: 1 });
    const lease = b.admit(40);
    expect(lease.ok).toBe(true);
  });

  test('releasing returns the capacity', () => {
    const b = new InflightBudget({ maxBytes: 100, perRequestMaxBytes: 100, amplification: 1 });
    const first = b.admit(100);
    expect(first.ok).toBe(true);
    if (first.ok) first.release();
    expect(b.inflightBytes).toBe(0);
    expect(b.admit(100).ok).toBe(true);
  });

  test('a second large request is REFUSED rather than accepted into an OOM', () => {
    const b = new InflightBudget({ maxBytes: 100, perRequestMaxBytes: 100, amplification: 1 });
    const first = b.admit(80);
    expect(first.ok).toBe(true);
    const second = b.admit(80);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('overloaded');
  });

  // The distinction that makes the error message honest and actionable.
  test('a request bigger than the WHOLE budget is "too_large", not "overloaded"', () => {
    const b = new InflightBudget({ maxBytes: 100, perRequestMaxBytes: 100, amplification: 1 });
    const r = b.admit(500);
    expect(r.ok).toBe(false);
    // Retrying will never help; saying "overloaded" would send the client into
    // a pointless retry loop.
    if (!r.ok) expect(r.reason).toBe('too_large');
  });

  // Anti-deadlock: an empty gateway must always accept one admissible request,
  // or a single big turn could never run at all.
  test('an idle budget always admits one request at the per-request ceiling', () => {
    const b = new InflightBudget({ maxBytes: 128 * MiB, perRequestMaxBytes: 128 * MiB, amplification: 1 });
    const r = b.admit(128 * MiB);
    expect(r.ok).toBe(true);
  });

  test('release is idempotent — a double release cannot manufacture capacity', () => {
    const b = new InflightBudget({ maxBytes: 100, perRequestMaxBytes: 100, amplification: 1 });
    const lease = b.admit(60);
    expect(lease.ok).toBe(true);
    if (lease.ok) {
      lease.release();
      lease.release();
      lease.release();
    }
    expect(b.inflightBytes).toBe(0);
    // 60 was returned exactly once, so exactly 100 is free — not 220.
    expect(b.admit(100).ok).toBe(true);
  });

  test('accounts for the amplification factor, not just the wire bytes', () => {
    // A body costs more than its wire size once it is a UTF-16 string plus a
    // parsed object graph. A budget that ignored that would admit ~3x what the
    // process can actually hold.
    const b = new InflightBudget({ maxBytes: 300, perRequestMaxBytes: 300, amplification: 3 });
    const first = b.admit(50); // charges 150
    expect(first.ok).toBe(true);
    expect(b.inflightBytes).toBe(150);
    const second = b.admit(50); // charges 150 -> exactly full
    expect(second.ok).toBe(true);
    const third = b.admit(1);
    expect(third.ok).toBe(false);
  });

  test('many concurrent small requests are unaffected', () => {
    const b = new InflightBudget({ maxBytes: 10 * MiB, perRequestMaxBytes: 1 * MiB, amplification: 1 });
    const leases = [];
    for (let i = 0; i < 500; i++) {
      const r = b.admit(1_000);
      expect(r.ok).toBe(true);
      if (r.ok) leases.push(r);
    }
    for (const l of leases) l.release();
    expect(b.inflightBytes).toBe(0);
  });

  test('the default amplification is applied when none is given', () => {
    // Guards the safe default: a budget constructed without an explicit
    // amplification must NOT count raw wire bytes, or it admits ~3x what the
    // process can hold.
    const b = new InflightBudget({ maxBytes: 300, perRequestMaxBytes: 300 });
    b.admit(50);
    expect(b.inflightBytes).toBe(150);
  });

  test('a zero budget disables admission control entirely', () => {
    const b = new InflightBudget({ maxBytes: 0, perRequestMaxBytes: 0, amplification: 1 });
    expect(b.admit(999 * MiB).ok).toBe(true);
  });

  test('reports utilisation so it can be logged and alarmed on', () => {
    const b = new InflightBudget({ maxBytes: 1_000, perRequestMaxBytes: 1_000, amplification: 1 });
    b.admit(250);
    expect(b.utilisation).toBeCloseTo(0.25, 5);
  });
});
