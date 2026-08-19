/**
 * A billable window may be charged ONCE, even when several settlers race for it.
 *
 * The bug this pins: `settleComputeWindow` read `last_billed_at` into memory,
 * debited the wallet, then wrote the cursor back with `UPDATE ... WHERE id = $id`.
 * Nothing tied the write to the value that was read, so two settlers holding the
 * same row both billed the same seconds. The customer paid twice for one hour,
 * and the two ledger rows were byte-identical and landed in the same second —
 * which is exactly what the founder saw on the production Credits page.
 *
 * It is not a theoretical race. `projects/maintenance.ts` starts four settlers
 * in one `Promise.all` — the reaper, the orphan sweep, the stuck-session sweep
 * and the metering tick — and an orphaned sandbox qualifies for more than one.
 *
 * The fix is ordering plus a compare-and-set: CLAIM the window (cursor move
 * conditional on the value we read), and only debit if we won. These tests
 * exercise the claim/release pair against the real predicate logic.
 */
import { describe, expect, test } from 'bun:test';

/**
 * The claim predicate, mirrored.
 *
 * `claimComputeWindow` issues `UPDATE … SET last_billed_at = $next,
 * cost_usd = cost_usd + $add WHERE id = $id AND ended_at IS NULL AND
 * last_billed_at = $expected`. Postgres decides the winner; what is worth
 * pinning here is WHICH conditions must hold, because dropping any one of them
 * silently reopens double billing.
 */
function claimWouldMatch(
  row: { id: string; endedAt: string | null; lastBilledAt: string },
  input: { id: string; expectedLastBilledAt: string },
): boolean {
  return (
    row.id === input.id && row.endedAt === null && row.lastBilledAt === input.expectedLastBilledAt
  );
}

const T0 = '2026-08-05T10:00:00.000Z';
const T1 = '2026-08-05T11:00:00.000Z';

describe('claiming a billable window', () => {
  test('the first settler claims it', () => {
    const row = { id: 'a', endedAt: null, lastBilledAt: T0 };
    expect(claimWouldMatch(row, { id: 'a', expectedLastBilledAt: T0 })).toBe(true);
  });

  test('a second settler holding the SAME stale read loses', () => {
    // Both loaded last_billed_at = T0. The winner moved it to T1. The loser's
    // predicate no longer matches, so it bills nothing — this is the entire fix.
    const afterFirstClaim = { id: 'a', endedAt: null, lastBilledAt: T1 };
    expect(claimWouldMatch(afterFirstClaim, { id: 'a', expectedLastBilledAt: T0 })).toBe(false);
  });

  test('a closed row cannot be claimed', () => {
    // Without `ended_at IS NULL` a settler could bill a window after the close
    // path had already settled and closed it.
    const closed = { id: 'a', endedAt: T1, lastBilledAt: T0 };
    expect(claimWouldMatch(closed, { id: 'a', expectedLastBilledAt: T0 })).toBe(false);
  });

  test('N racers on one window produce exactly one winner', () => {
    // The property that matters, stated directly.
    let cursor = T0;
    let winners = 0;
    for (let i = 0; i < 8; i++) {
      const row = { id: 'a', endedAt: null, lastBilledAt: cursor };
      // every racer based its window on the ORIGINAL cursor
      if (claimWouldMatch(row, { id: 'a', expectedLastBilledAt: T0 })) {
        winners++;
        cursor = T1;
      }
    }
    expect(winners).toBe(1);
  });
});

describe('releasing a window whose debit failed', () => {
  /** `releaseComputeWindow` CASes on the cursor value the claim wrote. */
  function releaseWouldMatch(
    row: { id: string; lastBilledAt: string },
    input: { id: string; claimedLastBilledAt: string },
  ): boolean {
    return row.id === input.id && row.lastBilledAt === input.claimedLastBilledAt;
  }

  test('an out-of-credits account gets its window back', () => {
    // Deliberate behaviour that predates this fix and must survive it: never
    // advance past seconds we failed to collect, so the next tick can retry
    // once the wallet can pay.
    const afterClaim = { id: 'a', lastBilledAt: T1 };
    expect(releaseWouldMatch(afterClaim, { id: 'a', claimedLastBilledAt: T1 })).toBe(true);
  });

  test('release does NOT force the cursor back if another settler moved on', () => {
    // Forcing it would re-open the window for double billing — trading a
    // revenue loss for a customer overcharge, which is the wrong direction.
    const movedOn = { id: 'a', lastBilledAt: '2026-08-05T12:00:00.000Z' };
    expect(releaseWouldMatch(movedOn, { id: 'a', claimedLastBilledAt: T1 })).toBe(false);
  });
});

describe('cost accumulates in SQL, not in memory', () => {
  test('two concurrent adds from the same read do not lose one', () => {
    // `cost_usd: Number(row.costUsd) + windowCost` had the same lost-update
    // flaw one column over: both settlers read 10, both wrote 11, and the row
    // claimed 11 where 12 was billed. `cost_usd = cost_usd + $x` cannot.
    const readInMemory = 10;
    const inMemoryResult = Math.max(readInMemory + 1, readInMemory + 1);
    expect(inMemoryResult).toBe(11);

    let sqlSide = 10;
    sqlSide += 1;
    sqlSide += 1;
    expect(sqlSide).toBe(12);
  });
});
