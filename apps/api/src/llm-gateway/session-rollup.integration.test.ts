// The gateway sessions reader (listProjectGatewaySessionSpend) reads the
// settled-day rollup kortix.gateway_session_daily for the marked days and the
// raw log rows for everything newer. Against a real PostgreSQL: the merged
// answer equals the raw scan exactly; an unsettled day is never answered from
// the rollup; settling a closed day recomputes it from the log rows and marks
// it, oldest day first, with no hole in the marks.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { gatewayRequestLogs, gatewaySessionDaily, gatewaySessionDays } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

const { db } = await import('../shared/db');
const { seedProject, removeSeeded } = await import('../__tests__/helpers/integration-fixtures');
const { listProjectGatewaySessionSpend } = await import('../shared/session-costs');
const { settleLastGatewaySessionDay } = await import('./session-rollup');

const DAY_MS = 86_400_000;
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

withDb('gateway_session_daily settled rollup', () => {
  const seeded: Awaited<ReturnType<typeof seedProject>>[] = [];
  afterAll(() => removeSeeded(seeded));

  // The mark and rollup tables are global state — one row-set per UTC day
  // across every project, because a day is settled once for all of them (a
  // live log row's created_at is always "now", so a settled day never gains
  // rows in real traffic). Each test needs its own settle boundary.
  beforeEach(async () => {
    await db.delete(gatewaySessionDaily);
    await db.delete(gatewaySessionDays);
  });

  async function request(
    project: { account_id: string; project_id: string },
    row: { session: string; ageMs: number; final?: number; upstream?: number; ok?: boolean; mode?: string },
  ) {
    await db.insert(gatewayRequestLogs).values({
      requestId: `req_${crypto.randomUUID()}`,
      accountId: project.account_id,
      projectId: project.project_id,
      sessionId: row.session,
      requestedModel: 'kortix/test',
      resolvedModel: 'kortix/test',
      provider: 'test',
      status: row.ok === false ? 500 : 200,
      ok: row.ok !== false,
      inputTokens: 1_000,
      outputTokens: 37,
      billingMode: row.mode ?? 'credits',
      finalCost: (row.final ?? 0).toFixed(10),
      upstreamCost: (row.upstream ?? 0).toFixed(10),
      createdAt: new Date(Date.now() - row.ageMs),
    });
  }

  /** Marks for every closed day before `dayBefore`, as the worker leaves them. */
  async function seedMarksThrough(dayBefore: Date) {
    await db.execute(sql`
      insert into kortix.gateway_session_days (day)
      select gs::date
      from generate_series(
        ((now() - interval '371 days') at time zone 'UTC')::date::timestamp,
        ((${dayBefore.toISOString()}::timestamptz at time zone 'UTC')::date - 1)::timestamp,
        interval '1 day'
      ) as gs
      on conflict do nothing`);
  }

  test('the merged answer equals the raw scan, and settling marks the day', async () => {
    const project = await seedProject('session-rollup-equal');
    seeded.push(project);
    const closedAgeMs = 2 * DAY_MS + 60_000; // the day before yesterday
    const todayAgeMs = 60_000;
    await request(project, { session: 'sess-a', ageMs: closedAgeMs, final: 0.0123456789 });
    await request(project, { session: 'sess-a', ageMs: closedAgeMs + 3_600_000, upstream: 0.25, mode: 'none' });
    await request(project, { session: 'sess-b', ageMs: closedAgeMs + 7_200_000, ok: false });
    await request(project, { session: 'sess-b', ageMs: todayAgeMs, final: 0.5 });
    await request(project, { session: 'sess-c', ageMs: todayAgeMs, upstream: 0.125 });

    const read = () =>
      listProjectGatewaySessionSpend({ accountId: project.account_id, projectId: project.project_id, days: 7 });

    // Nothing settled yet (the marks table is empty): the reader answers the
    // whole window from the raw rows.
    const raw = await read();
    expect(raw.window_days).toBe(7);
    expect(raw.sessions).toHaveLength(3);

    // Now mark everything except the closed day, as the worker leaves it, and
    // settle that one day.
    await seedMarksThrough(new Date(Date.now() - closedAgeMs));
    expect(await settleLastGatewaySessionDay()).toBe(true);

    // The settle marked exactly the oldest closed day with no mark — the day
    // the seed left unmarked — and left no hole in the marks: the reader's
    // boundary is the FIRST unmarked day, so a hole would hide rows.
    const [tail] = await db.execute<{ last: string; holes: number }>(sql`
      select max(day)::text as last,
        (select count(*)::int from generate_series(
           (select min(day) from kortix.gateway_session_days),
           (select max(day) from kortix.gateway_session_days),
           interval '1 day') as d
         where not exists (select 1 from kortix.gateway_session_days m where m.day = d::date)) as holes
      from kortix.gateway_session_days`);
    expect(tail.last).toBe(utcDay(new Date(Date.now() - closedAgeMs)));
    expect(tail.holes).toBe(0);

    // The closed day's rollup rows equal the raw aggregates, per session.
    const rollup = await db
      .select()
      .from(gatewaySessionDaily)
      .where(eq(gatewaySessionDaily.projectId, project.project_id));
    expect(rollup).toHaveLength(2); // sess-a and sess-b on the closed day
    // sess-b: one failed request, zero cost.
    const b = rollup.find((row) => row.sessionId === 'sess-b');
    expect(b).toMatchObject({ requests: 1, errors: 1 });
    expect(Number(b?.totalCost)).toBe(0);
    // sess-a: one Kortix-managed row (0.0123456789) + one own-key row (upstream 0.25).
    const a = rollup.find((row) => row.sessionId === 'sess-a');
    expect(Number(a?.totalCost)).toBeCloseTo(0.0123456789 + 0.25, 9);

    // The marked day comes from the rollup and the raw day from the logs:
    // the merged answer is the same raw scan, per session. Money goes through
    // toBeCloseTo — the merge rounds to 10 decimals, the raw sum carries
    // binary-float dust in the last bits.
    const merged = await read();
    const bySession = (rows: typeof raw.sessions) =>
      [...rows].sort((left, right) => left.session_id.localeCompare(right.session_id));
    const mergedRows = bySession(merged.sessions);
    const rawRows = bySession(raw.sessions);
    expect(mergedRows.map((row) => row.session_id)).toEqual(rawRows.map((row) => row.session_id));
    for (let index = 0; index < rawRows.length; index += 1) {
      expect(mergedRows[index]).toMatchObject({
        requests: rawRows[index].requests,
        errors: rawRows[index].errors,
        tokens: rawRows[index].tokens,
        models: rawRows[index].models,
        last_at: rawRows[index].last_at,
        priced_requests: rawRows[index].priced_requests,
        unpriced_requests: rawRows[index].unpriced_requests,
      });
      expect(mergedRows[index].llm_cost).toBeCloseTo(rawRows[index].llm_cost, 9);
      expect(mergedRows[index].total_cost).toBeCloseTo(rawRows[index].total_cost, 9);
      expect(mergedRows[index].estimated_usage_value).toBe(rawRows[index].estimated_usage_value);
    }

    // Everything closed is settled: the next tick has no work.
    expect(await settleLastGatewaySessionDay()).toBe(true); // yesterday (no logs)
    expect(await settleLastGatewaySessionDay()).toBe(false);
  });

  test('an unsettled day is never answered from the rollup', async () => {
    const project = await seedProject('session-rollup-boundary');
    seeded.push(project);
    const closedAgeMs = 2 * DAY_MS + 60_000;
    await request(project, { session: 'sess-a', ageMs: closedAgeMs, final: 0.1 });
    await request(project, { session: 'sess-live', ageMs: 60_000, final: 0.2 });
    await seedMarksThrough(new Date(Date.now() - closedAgeMs));

    expect(await settleLastGatewaySessionDay()).toBe(true);

    // Prove the marked day really is answered from the rollup: tamper with it
    // and the reader must report the tampered number.
    await db
      .update(gatewaySessionDaily)
      .set({ totalCost: '999' })
      .where(eq(gatewaySessionDaily.projectId, project.project_id));

    const sessions = await listProjectGatewaySessionSpend({
      accountId: project.account_id,
      projectId: project.project_id,
      days: 7,
    });
    const tampered = sessions.sessions.find((session) => session.session_id === 'sess-a');
    expect(tampered?.llm_cost).toBe(999);
    // The unsettled day is still raw: the new session is present next to it.
    expect(sessions.sessions.find((session) => session.session_id === 'sess-live')).toMatchObject({
      llm_cost: 0.2,
      requests: 1,
    });
  });
});
