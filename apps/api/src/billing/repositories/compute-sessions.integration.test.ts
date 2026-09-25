import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, sandboxComputeSessions } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { isUniqueViolation } from '../../shared/postgres-errors';
import { getOpenComputeSession, insertComputeSession } from './compute-sessions';

// Runs against a real PostgreSQL only: the property under test is the
// `uniq_sandbox_compute_sessions_one_open` index.
const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;
const accountId = '00000000-0000-4000-a000-000000009c01';
const sandboxId = '00000000-0000-4000-a000-000000009c02';

function row(startedAt: string) {
  return {
    accountId,
    sandboxId,
    provider: 'platinum' as const,
    cpuCores: 2,
    memoryGb: 4,
    diskGb: 10,
    state: 'active',
    startedAt,
    lastBilledAt: startedAt,
  };
}

withDb('one open metering row per sandbox', () => {
  beforeAll(async () => {
    await db.delete(accounts).where(eq(accounts.accountId, accountId));
    await db.insert(accounts).values({ accountId, name: 'Compute session uniqueness test' });
  });
  afterAll(async () => {
    await db.delete(sandboxComputeSessions).where(eq(sandboxComputeSessions.sandboxId, sandboxId));
    await db.delete(accounts).where(eq(accounts.accountId, accountId));
  });
  afterEach(async () => {
    await db.delete(sandboxComputeSessions).where(eq(sandboxComputeSessions.sandboxId, sandboxId));
  });

  test('two concurrent opens for one sandbox leave exactly one open row', async () => {
    const now = new Date().toISOString();
    const results = await Promise.allSettled([insertComputeSession(row(now)), insertComputeSession(row(now))]);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(failed).toHaveLength(1);
    // The fallback in startComputeSession keys on this: the driver error
    // arrives wrapped, so a plain `.code` read would miss it.
    expect(isUniqueViolation(failed[0]!.reason)).toBe(true);
    const open = await db
      .select({ id: sandboxComputeSessions.id })
      .from(sandboxComputeSessions)
      .where(eq(sandboxComputeSessions.sandboxId, sandboxId));
    expect(open).toHaveLength(1);
    expect((await getOpenComputeSession(sandboxId))?.id).toBe(open[0]!.id);
  });

  test('a closed row does not block the next open row', async () => {
    const first = await insertComputeSession(row(new Date(Date.now() - 60_000).toISOString()));
    await db
      .update(sandboxComputeSessions)
      .set({ endedAt: new Date().toISOString() as never })
      .where(eq(sandboxComputeSessions.id, first!.id));
    await expect(insertComputeSession(row(new Date().toISOString()))).resolves.toBeTruthy();
  });
});
