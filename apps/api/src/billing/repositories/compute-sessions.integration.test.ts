import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, sandboxComputeSessions } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { isUniqueViolation } from '../../shared/postgres-errors';
import {
  claimComputeWindow,
  findStaleActiveSessions,
  getOpenComputeSession,
  insertComputeSession,
  releaseComputeWindow,
} from './compute-sessions';

// Runs against a real PostgreSQL only: the properties under test are the
// `uniq_sandbox_compute_sessions_one_open` index and the compare-and-set
// statements that stop two settlers from billing one window twice.
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

async function stored(id: string) {
  const [found] = await db
    .select({
      state: sandboxComputeSessions.state,
      endedAt: sandboxComputeSessions.endedAt,
      lastBilledAt: sandboxComputeSessions.lastBilledAt,
      costUsd: sandboxComputeSessions.costUsd,
    })
    .from(sandboxComputeSessions)
    .where(eq(sandboxComputeSessions.id, id));
  return {
    state: found!.state,
    endedAt: found!.endedAt === null ? null : new Date(found!.endedAt).toISOString(),
    lastBilledAt: new Date(found!.lastBilledAt).toISOString(),
    costUsd: Number(found!.costUsd),
  };
}

withDb('claiming and releasing a billing window', () => {
  const T0 = '2026-09-01T10:00:00.000Z';
  const T1 = '2026-09-01T10:05:00.000Z';
  const T2 = '2026-09-01T10:10:00.000Z';

  beforeAll(async () => {
    await db.delete(accounts).where(eq(accounts.accountId, accountId));
    await db.insert(accounts).values({ accountId, name: 'Compute window claim test' });
  });
  afterAll(async () => {
    await db.delete(sandboxComputeSessions).where(eq(sandboxComputeSessions.sandboxId, sandboxId));
    await db.delete(accounts).where(eq(accounts.accountId, accountId));
  });
  afterEach(async () => {
    await db.delete(sandboxComputeSessions).where(eq(sandboxComputeSessions.sandboxId, sandboxId));
  });

  test('of eight settlers holding one read, exactly one claims the window', async () => {
    const open = await insertComputeSession(row(T0));
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        claimComputeWindow({ id: open!.id, expectedLastBilledAt: T0, nextLastBilledAt: T1, addCostUsd: 0.25 }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await stored(open!.id)).toEqual({ state: 'active', endedAt: null, lastBilledAt: T1, costUsd: 0.25 });
  });

  test('sequential claims add their costs in SQL', async () => {
    const open = await insertComputeSession(row(T0));
    await claimComputeWindow({ id: open!.id, expectedLastBilledAt: T0, nextLastBilledAt: T1, addCostUsd: 0.25 });
    await claimComputeWindow({ id: open!.id, expectedLastBilledAt: T1, nextLastBilledAt: T2, addCostUsd: 0.5 });
    expect(await stored(open!.id)).toMatchObject({ lastBilledAt: T2, costUsd: 0.75 });
  });

  test('a terminal claim closes the row at the cursor, and a closed row cannot be claimed', async () => {
    const open = await insertComputeSession(row(T0));
    expect(
      await claimComputeWindow({
        id: open!.id,
        expectedLastBilledAt: T0,
        nextLastBilledAt: T1,
        addCostUsd: 0.25,
        terminalState: 'stopped',
      }),
    ).toBe(true);
    expect(await stored(open!.id)).toEqual({ state: 'stopped', endedAt: T1, lastBilledAt: T1, costUsd: 0.25 });
    expect(
      await claimComputeWindow({ id: open!.id, expectedLastBilledAt: T1, nextLastBilledAt: T2, addCostUsd: 0.5 }),
    ).toBe(false);
    expect(await stored(open!.id)).toMatchObject({ lastBilledAt: T1, costUsd: 0.25 });
  });

  test('a release gives the claimed window back', async () => {
    const open = await insertComputeSession(row(T0));
    await claimComputeWindow({ id: open!.id, expectedLastBilledAt: T0, nextLastBilledAt: T1, addCostUsd: 0.25 });
    expect(
      await releaseComputeWindow({
        id: open!.id,
        claimedLastBilledAt: T1,
        revertToLastBilledAt: T0,
        subCostUsd: 0.25,
      }),
    ).toBe(true);
    expect(await stored(open!.id)).toEqual({ state: 'active', endedAt: null, lastBilledAt: T0, costUsd: 0 });
  });

  test('a terminal release reopens only the exact terminal claim it made', async () => {
    const open = await insertComputeSession(row(T0));
    await claimComputeWindow({
      id: open!.id,
      expectedLastBilledAt: T0,
      nextLastBilledAt: T1,
      addCostUsd: 0.25,
      terminalState: 'finalized',
    });
    const release = { id: open!.id, claimedLastBilledAt: T1, revertToLastBilledAt: T0, subCostUsd: 0.25 };
    expect(await releaseComputeWindow({ ...release, terminalState: 'stopped' })).toBe(false);
    expect(await stored(open!.id)).toMatchObject({ state: 'finalized', endedAt: T1 });
    expect(await releaseComputeWindow({ ...release, terminalState: 'finalized' })).toBe(true);
    expect(await stored(open!.id)).toEqual({ state: 'active', endedAt: null, lastBilledAt: T0, costUsd: 0 });
  });

  test('a stale release cannot move the cursor back', async () => {
    const open = await insertComputeSession(row(T0));
    await claimComputeWindow({ id: open!.id, expectedLastBilledAt: T0, nextLastBilledAt: T1, addCostUsd: 0.25 });
    await claimComputeWindow({ id: open!.id, expectedLastBilledAt: T1, nextLastBilledAt: T2, addCostUsd: 0.5 });
    const stale = { id: open!.id, claimedLastBilledAt: T1, revertToLastBilledAt: T0, subCostUsd: 0.25 };
    expect(await releaseComputeWindow(stale)).toBe(false);
    expect(await stored(open!.id)).toMatchObject({ lastBilledAt: T2, costUsd: 0.75 });
  });

  test('a partial release cannot reopen a window closed after its claim', async () => {
    const open = await insertComputeSession(row(T0));
    await claimComputeWindow({ id: open!.id, expectedLastBilledAt: T0, nextLastBilledAt: T1, addCostUsd: 0.25 });
    await claimComputeWindow({
      id: open!.id,
      expectedLastBilledAt: T1,
      nextLastBilledAt: T1,
      addCostUsd: 0,
      terminalState: 'stopped',
    });
    expect(
      await releaseComputeWindow({ id: open!.id, claimedLastBilledAt: T1, revertToLastBilledAt: T0, subCostUsd: 0.25 }),
    ).toBe(false);
    expect(await stored(open!.id)).toEqual({ state: 'stopped', endedAt: T1, lastBilledAt: T1, costUsd: 0.25 });
  });

  test('the maintenance tick reads the longest-unsettled active windows first', async () => {
    const sandboxes = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    try {
      await insertComputeSession({ ...row(T1), sandboxId: sandboxes[0]! });
      await insertComputeSession({ ...row(T0), sandboxId: sandboxes[1]! });
      await insertComputeSession({ ...row('2026-09-01T09:55:00.000Z'), sandboxId: sandboxes[2]! });
      await insertComputeSession({ ...row(T0), sandboxId: sandboxes[3]!, state: 'stopped' });
      const stale = await findStaleActiveSessions(new Date(T1), 2);
      expect(stale.map((found) => found.sandboxId)).toEqual([sandboxes[2], sandboxes[1]]);
      expect((await findStaleActiveSessions(new Date(T0))).map((found) => found.sandboxId)).toEqual([
        sandboxes[2],
        sandboxes[1],
      ]);
    } finally {
      for (const id of sandboxes) {
        await db.delete(sandboxComputeSessions).where(eq(sandboxComputeSessions.sandboxId, id));
      }
    }
  });
});
