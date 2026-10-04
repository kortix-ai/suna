/**
 * Integration test (real local PostgreSQL): `claimRecoveryAttempt`'s row-lock
 * CAS is the ONLY thing standing between "2 recoveries/hour per box" and a
 * runaway restart loop once two API replicas race the same `runtime_gone`
 * event — a unit test with an injected `db` cannot prove the lock actually
 * serializes concurrent writers against the real table.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import {
  MAX_RECOVERIES_PER_WINDOW,
  RECOVERY_MIN_GAP_MS,
  claimRecoveryAttempt,
} from '../projects/session-lifecycle/unattended-runtime-recovery';
import { db } from '../lib/db';

const SANDBOX_ID = crypto.randomUUID();
const SESSION_ID = `unattended-recovery-${SANDBOX_ID}`;
const ACCOUNT_ID = crypto.randomUUID();
const PROJECT_ID = crypto.randomUUID();

type Rows = { rows?: Array<Record<string, unknown>> } & Array<Record<string, unknown>>;
const asRows = (result: unknown) => (result as Rows).rows ?? (result as Rows);

async function readAttempts(): Promise<number[]> {
  const result = await db.execute(sql`
    SELECT metadata FROM kortix.session_sandboxes WHERE sandbox_id = ${SANDBOX_ID}::uuid`);
  const row = asRows(result)[0] as { metadata?: { autoRecovery?: { attempts?: number[] } } } | undefined;
  return row?.metadata?.autoRecovery?.attempts ?? [];
}

beforeEach(async () => {
  await db.execute(sql`
    INSERT INTO kortix.session_sandboxes
      (sandbox_id, session_id, account_id, project_id, status, metadata)
    VALUES (${SANDBOX_ID}::uuid, ${SESSION_ID}, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid,
            'active', '{}'::jsonb)
    ON CONFLICT (sandbox_id) DO UPDATE
       SET status = 'active',
           metadata = '{}'::jsonb`);
});

afterAll(async () => {
  await db
    .execute(sql`DELETE FROM kortix.session_sandboxes WHERE sandbox_id = ${SANDBOX_ID}::uuid`)
    .catch(() => undefined);
});

describe('claimRecoveryAttempt — real row, real lock', () => {
  test('a fresh box may claim, and the attempt is durably recorded', async () => {
    const now = Date.now();
    expect(await claimRecoveryAttempt(SANDBOX_ID, now)).toBe('claimed');
    expect(await readAttempts()).toEqual([now]);
  });

  test(`the ${MAX_RECOVERIES_PER_WINDOW + 1}th attempt inside the rolling hour is bounded`, async () => {
    const t0 = Date.now();
    for (let i = 0; i < MAX_RECOVERIES_PER_WINDOW; i++) {
      const claim = await claimRecoveryAttempt(SANDBOX_ID, t0 + i * RECOVERY_MIN_GAP_MS);
      expect(claim).toBe('claimed');
    }
    const overBudget = await claimRecoveryAttempt(
      SANDBOX_ID,
      t0 + MAX_RECOVERIES_PER_WINDOW * RECOVERY_MIN_GAP_MS,
    );
    expect(overBudget).toBe('bounded');
    expect(await readAttempts()).toHaveLength(MAX_RECOVERIES_PER_WINDOW);
  });

  // Simulates two API replicas racing the SAME box-gone event. Both start
  // from a budget of one remaining attempt; the row lock must let exactly one
  // through and tell the other `bounded`, never let both spend the last slot.
  test('two concurrent callers racing the last slot in the budget: exactly one is claimed', async () => {
    const t0 = Date.now();
    // Spend all but one attempt first, deterministically.
    for (let i = 0; i < MAX_RECOVERIES_PER_WINDOW - 1; i++) {
      expect(await claimRecoveryAttempt(SANDBOX_ID, t0 + i * RECOVERY_MIN_GAP_MS)).toBe('claimed');
    }
    const raceAt = t0 + MAX_RECOVERIES_PER_WINDOW * RECOVERY_MIN_GAP_MS;
    const [a, b] = await Promise.all([
      claimRecoveryAttempt(SANDBOX_ID, raceAt),
      claimRecoveryAttempt(SANDBOX_ID, raceAt),
    ]);
    const outcomes = [a, b].sort();
    expect(outcomes).toEqual(['bounded', 'claimed']);
    expect(await readAttempts()).toHaveLength(MAX_RECOVERIES_PER_WINDOW);
  });

  test('an attempt outside the rolling window does not count against the budget', async () => {
    const longAgo = Date.now() - 3 * 60 * 60 * 1000; // 3h ago
    expect(await claimRecoveryAttempt(SANDBOX_ID, longAgo)).toBe('claimed');
    const now = longAgo + 3 * 60 * 60 * 1000;
    for (let i = 0; i < MAX_RECOVERIES_PER_WINDOW; i++) {
      expect(await claimRecoveryAttempt(SANDBOX_ID, now + i * RECOVERY_MIN_GAP_MS)).toBe('claimed');
    }
    // The stale attempt was pruned, so only the fresh window's attempts remain.
    expect(await readAttempts()).toHaveLength(MAX_RECOVERIES_PER_WINDOW);
  });
});
