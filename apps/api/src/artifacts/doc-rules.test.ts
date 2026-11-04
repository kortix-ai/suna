import { describe, expect, test } from 'bun:test';
import {
  DOC_COMPACT_ROWS,
  DOC_BYTE_RATE,
  DOC_LEASE_TTL_MS,
  DOC_PAGE_MAX_BYTES,
  DocByteBudget,
  compactionWindow,
  decideFlush,
  decideLease,
  decideReset,
  isIncrementalDocPull,
  DocReadAuditThrottle,
  DOC_CATCH_UP_AUDIT_MS,
  pageCut,
  type DocLease,
} from './doc-rules';

const now = new Date('2026-11-04T12:00:00.000Z');
const later = (ms: number) => new Date(now.getTime() + ms);
const free: DocLease = { holder: null, userId: null, expiresAt: null };
const held = (holder: string, userId: string, expiresAt: Date): DocLease => ({ holder, userId, expiresAt });

describe('decideLease', () => {
  test('a free lease is acquired for 15 s', () => {
    const decision = decideLease(free, { holder: 'tab-a', userId: 'u1', release: false }, now);
    expect(decision).toEqual({ kind: 'acquire', leader: true, write: true, next: held('tab-a', 'u1', later(DOC_LEASE_TTL_MS)) });
  });

  test('an expired lease of another tab is taken over', () => {
    const decision = decideLease(held('tab-b', 'u2', later(-1)), { holder: 'tab-a', userId: 'u1', release: false }, now);
    expect(decision.kind).toBe('acquire');
    expect(decision.leader).toBe(true);
    expect(decision.next).toEqual(held('tab-a', 'u1', later(DOC_LEASE_TTL_MS)));
  });

  test('a lease that ends exactly now counts as expired', () => {
    expect(decideLease(held('tab-b', 'u2', now), { holder: 'tab-a', userId: 'u1', release: false }, now).leader).toBe(true);
  });

  test('our own live lease is renewed from now (a heartbeat: no audit row)', () => {
    const decision = decideLease(held('tab-a', 'u1', later(3_000)), { holder: 'tab-a', userId: 'u1', release: false }, now);
    expect(decision).toEqual({ kind: 'renew', leader: true, write: true, next: held('tab-a', 'u1', later(DOC_LEASE_TTL_MS)) });
  });

  test('our own expired lease is taken again', () => {
    expect(decideLease(held('tab-a', 'u1', later(-60_000)), { holder: 'tab-a', userId: 'u1', release: false }, now)).toMatchObject({ kind: 'acquire', leader: true });
  });

  test('a live lease of another tab is contested: no write, the other holder stays', () => {
    const current = held('tab-b', 'u2', later(10_000));
    expect(decideLease(current, { holder: 'tab-a', userId: 'u1', release: false }, now)).toEqual({ kind: 'contested', leader: false, write: false, next: current });
  });

  test('the same holder id from another person is not ours', () => {
    const current = held('tab-a', 'u2', later(10_000));
    expect(decideLease(current, { holder: 'tab-a', userId: 'u1', release: false }, now)).toEqual({ kind: 'contested', leader: false, write: false, next: current });
  });

  test('we release our own lease', () => {
    expect(decideLease(held('tab-a', 'u1', later(10_000)), { holder: 'tab-a', userId: 'u1', release: true }, now))
      .toEqual({ kind: 'release', leader: false, write: true, next: free });
  });

  test('a release of another tab\'s lease changes nothing', () => {
    const current = held('tab-b', 'u2', later(10_000));
    expect(decideLease(current, { holder: 'tab-a', userId: 'u1', release: true }, now)).toEqual({ kind: 'contested', leader: false, write: false, next: current });
  });
});

describe('decideFlush', () => {
  const lease = held('tab-a', 'u1', later(10_000));
  // The file's entry version now, read server-side from Files.
  const state = { flushedSeq: 4, latestSeq: 9, lease, currentVersion: 'v7' };
  const flush = (seq: number, extra: Partial<{ holder: string; userId: string; version: string }> = {}) =>
    ({ holder: 'tab-a', userId: 'u1', seq, version: 'v7', ...extra });

  test('the lease holder flushes a newer seq at the file\u2019s current version: applied, and it advanced (its writers are named)', () => {
    expect(decideFlush(state, flush(7))).toEqual({ ok: true, apply: true, advanced: true });
  });

  test('the same seq again is applied (a newer version of the same updates) but did not advance: nobody is named again', () => {
    expect(decideFlush(state, flush(4))).toEqual({ ok: true, apply: true, advanced: false });
  });

  test('an older seq is accepted but sets nothing and names nobody', () => {
    expect(decideFlush(state, flush(3))).toEqual({ ok: true, apply: false, advanced: false });
  });

  test('a version that is not the file\u2019s current one (a replay, or an invented one) → version_mismatch', () => {
    expect(decideFlush(state, flush(7, { version: 'v6' }))).toEqual({ ok: false, code: 'version_mismatch' });
    expect(decideFlush({ ...state, currentVersion: null }, flush(7))).toEqual({ ok: false, code: 'version_mismatch' });
  });

  test('a seq beyond the latest update is refused', () => {
    expect(decideFlush(state, flush(10))).toEqual({ ok: false, code: 'invalid_seq' });
  });

  test('another tab, or the same holder id from another person, is not the leader (checked first)', () => {
    expect(decideFlush(state, flush(7, { holder: 'tab-b', version: 'v6' }))).toEqual({ ok: false, code: 'not_leader' });
    expect(decideFlush(state, flush(7, { userId: 'u2' }))).toEqual({ ok: false, code: 'not_leader' });
  });

  test('no lease at all → not the leader', () => {
    expect(decideFlush({ ...state, lease: free }, flush(7))).toEqual({ ok: false, code: 'not_leader' });
  });

  test('an expired lease that nobody took over is still ours', () => {
    expect(decideFlush({ ...state, lease: held('tab-a', 'u1', later(-5_000)) }, flush(7))).toEqual({ ok: true, apply: true, advanced: true });
  });
});

describe('pageCut', () => {
  const rows = (...sizes: number[]) => sizes.map((size, i) => ({ seq: i + 1, size }));

  test('no rows → an empty page', () => {
    expect(pageCut([], 100)).toEqual({ count: 0, hasMore: false });
  });

  test('rows that fit take the whole page', () => {
    expect(pageCut(rows(10, 20, 30), 100)).toEqual({ count: 3, hasMore: false });
  });

  test('the page stops before the row that would pass the budget', () => {
    expect(pageCut(rows(40, 40, 40), 100)).toEqual({ count: 2, hasMore: true });
  });

  test('a single row larger than the budget still makes progress', () => {
    expect(pageCut(rows(500, 1), 100)).toEqual({ count: 1, hasMore: true });
  });

  test('a row cap passed in by the caller marks has_more', () => {
    expect(pageCut(rows(1, 1, 1), 100, 2)).toEqual({ count: 2, hasMore: true });
  });
});

describe('compactionWindow', () => {
  const rows = (count: number, size: (i: number) => number) => Array.from({ length: count }, (_, i) => ({ seq: 100 + i, size: size(i) }));

  test(`${DOC_COMPACT_ROWS} rows or fewer → no compaction`, () => {
    expect(compactionWindow(rows(DOC_COMPACT_ROWS, () => 50))).toBeNull();
  });

  test('more rows than the threshold → every row merges into the highest seq', () => {
    expect(compactionWindow(rows(DOC_COMPACT_ROWS + 1, () => 50))).toEqual({ fromSeq: 100, toSeq: 100 + DOC_COMPACT_ROWS, rows: DOC_COMPACT_ROWS + 1 });
  });

  test('the window stops at the byte budget', () => {
    const half = Math.floor(DOC_PAGE_MAX_BYTES / 2);
    expect(compactionWindow(rows(DOC_COMPACT_ROWS + 1, () => half))).toEqual({ fromSeq: 100, toSeq: 101, rows: 2 });
  });

  test('a first row past the budget is skipped, the rows after it still merge', () => {
    const plan = compactionWindow(rows(DOC_COMPACT_ROWS + 1, (i) => (i === 0 ? DOC_PAGE_MAX_BYTES + 1 : 50)));
    expect(plan).toEqual({ fromSeq: 101, toSeq: 100 + DOC_COMPACT_ROWS, rows: DOC_COMPACT_ROWS });
  });

  test('when no two neighbours fit the budget → no compaction', () => {
    expect(compactionWindow(rows(DOC_COMPACT_ROWS + 1, () => DOC_PAGE_MAX_BYTES))).toBeNull();
  });
});

describe('decideReset', () => {
  test('the lease holder, or anyone while the lease is free or expired, may reset', () => {
    expect(decideReset(held('tab-a', 'u1', later(10_000)), { holder: 'tab-a', userId: 'u1' }, now)).toBe(true);
    expect(decideReset(free, { holder: 'tab-b', userId: 'u2' }, now)).toBe(true);
    expect(decideReset(held('tab-a', 'u1', later(-1)), { holder: 'tab-b', userId: 'u2' }, now)).toBe(true);
  });

  test('another live holder, or the same holder id from another person → not allowed', () => {
    expect(decideReset(held('tab-a', 'u1', later(10_000)), { holder: 'tab-b', userId: 'u2' }, now)).toBe(false);
    expect(decideReset(held('tab-a', 'u1', later(10_000)), { holder: 'tab-a', userId: 'u2' }, now)).toBe(false);
  });
});

describe('DocByteBudget (pushed bytes per person per process)', () => {
  const MiB = 1024 * 1024;

  test(`a burst of ${DOC_BYTE_RATE.burstBytes / MiB} MiB passes, the next byte waits`, () => {
    const budget = new DocByteBudget();
    expect(budget.take('u1', 3 * MiB, 0)).toEqual({ allowed: true });
    expect(budget.take('u1', MiB, 0)).toEqual({ allowed: true });
    const refused = budget.take('u1', 1, 0);
    expect(refused.allowed).toBe(false);
    expect(refused.allowed ? 0 : refused.retryAfterMs).toBeGreaterThan(0);
    // Other people have their own budget.
    expect(budget.take('u2', 4 * MiB, 0)).toEqual({ allowed: true });
  });

  test(`it refills at ${DOC_BYTE_RATE.bytesPerSecond / MiB} MiB a second, never past the burst`, () => {
    const budget = new DocByteBudget();
    budget.take('u1', 4 * MiB, 0);
    expect(budget.take('u1', MiB, 250).allowed).toBe(false);
    expect(budget.take('u1', MiB, 500)).toEqual({ allowed: true });
    expect(budget.take('u1', 4 * MiB, 60_000)).toEqual({ allowed: true });
    expect(budget.take('u1', 1, 60_000).allowed).toBe(false);
  });

  test('a refused take spends nothing, and retryAfterMs is when it would fit', () => {
    const budget = new DocByteBudget();
    budget.take('u1', 4 * MiB, 0);
    const refused = budget.take('u1', 2 * MiB, 0);
    expect(refused).toEqual({ allowed: false, retryAfterMs: 1_000 });
    expect(budget.take('u1', 2 * MiB, 1_000)).toEqual({ allowed: true });
  });

  test('a take larger than the burst can never pass', () => {
    expect(new DocByteBudget().take('u1', 4 * MiB + 1, 0).allowed).toBe(false);
  });
});

describe('isIncrementalDocPull (an incremental pull writes no audit row; a full read does)', () => {
  test('after > 0 without base is incremental; after = 0, or base, is a full read', () => {
    expect(isIncrementalDocPull({ after: 3, base: false })).toBe(true);
    expect(isIncrementalDocPull({ after: 0, base: false })).toBe(false);
    expect(isIncrementalDocPull({ after: 3, base: true })).toBe(false);
    expect(isIncrementalDocPull({ after: 0, base: true })).toBe(false);
  });
});

describe('DocReadAuditThrottle (one catch-up pull audit row per person and Artifact per 10 min)', () => {
  test('the first catch-up pull of a key is recorded; the next ones inside the window are not; after it, one more is', () => {
    const throttle = new DocReadAuditThrottle();
    expect(throttle.shouldRecord('u1:a1', 0)).toBe(true);
    expect(throttle.shouldRecord('u1:a1', 1_000)).toBe(false);
    expect(throttle.shouldRecord('u1:a1', DOC_CATCH_UP_AUDIT_MS - 1)).toBe(false);
    expect(throttle.shouldRecord('u1:a1', DOC_CATCH_UP_AUDIT_MS)).toBe(true);
    expect(throttle.shouldRecord('u1:a1', DOC_CATCH_UP_AUDIT_MS + 1)).toBe(false);
  });

  test('another person or another Artifact has its own window', () => {
    const throttle = new DocReadAuditThrottle();
    expect(throttle.shouldRecord('u1:a1', 0)).toBe(true);
    expect(throttle.shouldRecord('u2:a1', 0)).toBe(true);
    expect(throttle.shouldRecord('u1:a2', 0)).toBe(true);
  });

  test('the map is bounded: past maxKeys the oldest keys go, and a forgotten key is recorded again (never fewer rows)', () => {
    const throttle = new DocReadAuditThrottle(DOC_CATCH_UP_AUDIT_MS, 100);
    for (let i = 0; i < 1_000; i++) throttle.shouldRecord(`u${i}:a1`, i);
    expect(throttle.size).toBeLessThanOrEqual(100);
    expect(throttle.shouldRecord('u0:a1', 2_000)).toBe(true);
    expect(throttle.shouldRecord('u999:a1', 2_000)).toBe(false);
  });
});
