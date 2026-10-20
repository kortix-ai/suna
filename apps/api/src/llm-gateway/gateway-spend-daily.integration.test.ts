// The gateway budgets read kortix.gateway_spend_daily, a running total that an
// AFTER INSERT trigger on gateway_request_logs keeps. Against a real
// PostgreSQL: the totals equal the old SUM over the log rows for every billing
// mode, member and period; a pending (not yet complete) day makes the readers
// sum the logs; settling a closed day recomputes it exactly.
import { afterAll, describe, expect, test } from 'bun:test';
import { gatewayRequestLogs, gatewaySpendDaily, gatewaySpendPendingDays } from '@kortix/db';
import { and, eq, gte, sql } from 'drizzle-orm';

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

const { db } = await import('../shared/db');
const { seedProject, removeSeeded } = await import('../__tests__/helpers/integration-fixtures');
const { totalSpendWhereSql, totalSpendSql } = await import('../shared/llm-spend');
const { budgetSpends, monthToDateGatewaySpend, settleGatewaySpendDay, startOfBudgetPeriod } = await import('./budgets');

const MEMBER_A = '00000000-0000-4000-a000-0000000000aa';
const MEMBER_B = '00000000-0000-4000-a000-0000000000bb';
const DAY_MS = 86_400_000;
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

const BUDGETS = [
  { scope: 'project', subjectUserId: null, period: 'day' },
  { scope: 'project', subjectUserId: null, period: 'week' },
  { scope: 'project', subjectUserId: null, period: 'month' },
  { scope: 'member', subjectUserId: MEMBER_A, period: 'month' },
  { scope: 'member', subjectUserId: MEMBER_B, period: 'week' },
];

withDb('gateway_spend_daily running total', () => {
  const seeded: Awaited<ReturnType<typeof seedProject>>[] = [];
  afterAll(() => removeSeeded(seeded));

  async function request(
    project: { account_id: string; project_id: string },
    row: { actor?: string | null; mode?: string | null; final?: number; upstream?: number; ageMs?: number; ok?: boolean },
  ) {
    await db.insert(gatewayRequestLogs).values({
      requestId: `req_${crypto.randomUUID()}`,
      accountId: project.account_id,
      projectId: project.project_id,
      actorUserId: row.actor ?? null,
      requestedModel: 'kortix/test',
      resolvedModel: 'kortix/test',
      provider: 'test',
      status: row.ok === false ? 500 : 200,
      ok: row.ok !== false,
      inputTokens: 1_000,
      outputTokens: 37,
      billingMode: row.mode ?? null,
      finalCost: (row.final ?? 0).toFixed(10),
      upstreamCost: (row.upstream ?? 0).toFixed(10),
      createdAt: new Date(Date.now() - (row.ageMs ?? 60_000)),
    });
  }

  /** The pre-rollup measure: one SUM over the log rows per budget window. */
  async function logSum(projectId: string, now = new Date()): Promise<number[]> {
    const out: number[] = [];
    for (const b of BUDGETS) {
      const start = startOfBudgetPeriod(b.period as 'day', now);
      const [row] = await db
        .select({
          v: totalSpendWhereSql(
            b.subjectUserId
              ? sql`${gatewayRequestLogs.actorUserId} = ${b.subjectUserId}`
              : sql`true`,
          ),
        })
        .from(gatewayRequestLogs)
        .where(and(eq(gatewayRequestLogs.projectId, projectId), gte(gatewayRequestLogs.createdAt, start)));
      out.push(row?.v ?? 0);
    }
    return out;
  }

  async function seedMix(project: { account_id: string; project_id: string }) {
    // Every billing-mode branch of shared/llm-spend.ts, with and without an actor.
    await request(project, { actor: MEMBER_A, mode: 'credits', final: 0.0123456789, upstream: 0.009 });
    await request(project, { actor: MEMBER_A, mode: 'platform-fee', final: 0.001, upstream: 0.02 });
    await request(project, { actor: MEMBER_B, mode: 'none', upstream: 0.3333333333 });
    await request(project, { actor: null, mode: null, final: 0.5, upstream: 0.25 }); // legacy managed
    await request(project, { actor: MEMBER_B, mode: null, upstream: 0.125 }); // legacy BYOK
    await request(project, { actor: MEMBER_A, mode: 'credits', ok: false });
    await request(project, { actor: MEMBER_B, mode: 'none', upstream: 1.5, ageMs: 2 * DAY_MS });
    await request(project, { actor: MEMBER_A, mode: 'credits', final: 2, ageMs: 40 * DAY_MS });
  }

  test('a pending day makes every reader sum the log rows', async () => {
    const project = await seedProject('spend-daily-pending');
    seeded.push(project);
    await seedMix(project);
    // Tamper with the running total: a pending day must hide it.
    await db
      .update(gatewaySpendDaily)
      .set({ totalCost: '999' })
      .where(eq(gatewaySpendDaily.projectId, project.project_id));
    await db.insert(gatewaySpendPendingDays).values({ day: utcDay(new Date()) }).onConflictDoNothing();

    const spends = await budgetSpends(project.project_id, BUDGETS);
    expect(spends.map((s) => s.spentUsd)).toEqual(await logSum(project.project_id));
  });

  test('with no pending day the running total equals the log SUM, before and after new requests', async () => {
    const project = await seedProject('spend-daily-equal');
    seeded.push(project);
    await seedMix(project);
    await db.delete(gatewaySpendPendingDays);

    const before = await logSum(project.project_id);
    expect(before.some((v) => v > 0)).toBe(true);
    expect((await budgetSpends(project.project_id, BUDGETS)).map((s) => s.spentUsd)).toEqual(before);

    await request(project, { actor: MEMBER_B, mode: 'none', upstream: 0.0000000001 });
    await request(project, { actor: MEMBER_A, mode: 'credits', final: 0.7 });
    const after = await logSum(project.project_id);
    expect(after).not.toEqual(before);
    expect((await budgetSpends(project.project_id, BUDGETS)).map((s) => s.spentUsd)).toEqual(after);

    // The read path is the running total, not a SUM in disguise.
    await db
      .update(gatewaySpendDaily)
      .set({ totalCost: sql`${gatewaySpendDaily.totalCost} + 1000` })
      .where(and(eq(gatewaySpendDaily.projectId, project.project_id), eq(gatewaySpendDaily.actorUserId, MEMBER_A)));
    const tampered = await budgetSpends(project.project_id, BUDGETS);
    expect(tampered[3]!.spentUsd).toBeGreaterThan(1000);
  });

  test('month-to-date project and member spend equal the log aggregates', async () => {
    const project = await seedProject('spend-daily-mtd');
    seeded.push(project);
    await seedMix(project);
    await db.delete(gatewaySpendPendingDays);

    const monthStart = startOfBudgetPeriod('month');
    const where = and(
      eq(gatewayRequestLogs.projectId, project.project_id),
      gte(gatewayRequestLogs.createdAt, monthStart),
    );
    const [projectAgg] = await db
      .select({ requests: sql<number>`count(*)::int`, cost: totalSpendSql })
      .from(gatewayRequestLogs)
      .where(where);
    const members = await db
      .select({
        userId: sql<string>`${gatewayRequestLogs.actorUserId}`,
        requests: sql<number>`count(*)::int`,
        cost: totalSpendSql,
        tokens: sql<number>`coalesce(sum(${gatewayRequestLogs.inputTokens} + ${gatewayRequestLogs.outputTokens}), 0)::float8`,
      })
      .from(gatewayRequestLogs)
      .where(and(where, sql`${gatewayRequestLogs.actorUserId} is not null`))
      .groupBy(gatewayRequestLogs.actorUserId);
    const byUser = (rows: { userId: string }[]) =>
      [...rows].sort((a, b) => a.userId.localeCompare(b.userId));

    const full = await monthToDateGatewaySpend(project.project_id, null);
    expect(full.project).toEqual({ requests: projectAgg!.requests, cost: projectAgg!.cost });
    expect(byUser(full.members)).toEqual(byUser(members));

    const own = await monthToDateGatewaySpend(project.project_id, MEMBER_B);
    expect(own.members).toEqual(members.filter((m) => m.userId === MEMBER_B));
  });

  test('settling a closed pending day recomputes it from the log rows and clears it', async () => {
    const project = await seedProject('spend-daily-settle');
    seeded.push(project);
    await seedMix(project);
    await db.delete(gatewaySpendPendingDays);
    const closed = utcDay(new Date(Date.now() - 2 * DAY_MS - 60_000));
    const exact = await db
      .select()
      .from(gatewaySpendDaily)
      .where(and(eq(gatewaySpendDaily.projectId, project.project_id), eq(gatewaySpendDaily.day, closed)));
    expect(exact.length).toBe(1);

    await db
      .update(gatewaySpendDaily)
      .set({ totalCost: '42', requests: 9 })
      .where(and(eq(gatewaySpendDaily.projectId, project.project_id), eq(gatewaySpendDaily.day, closed)));
    await db.insert(gatewaySpendPendingDays).values([{ day: closed }, { day: utcDay(new Date()) }]);

    expect(await settleGatewaySpendDay()).toBe(true);
    // Today is still open: it stays pending, and the next tick has no work.
    expect(await settleGatewaySpendDay()).toBe(false);
    const pending = await db.select().from(gatewaySpendPendingDays);
    expect(pending.map((p) => p.day)).toEqual([utcDay(new Date())]);
    const settled = await db
      .select()
      .from(gatewaySpendDaily)
      .where(and(eq(gatewaySpendDaily.projectId, project.project_id), eq(gatewaySpendDaily.day, closed)));
    expect(settled).toEqual(exact);
  });
});
