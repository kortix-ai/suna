/**
 * Integration test (real PostgreSQL): trigger run history (KRTX-1743).
 *
 * Proves, with an injected clock: a manual or webhook fire writes one run row
 * with its source and status; a rejected webhook delivery is stored unverified;
 * a payload over 64 KiB is stored as a size marker; a run closes from its
 * turn's `session_turns` row, on any terminal relay and in maintenance; `max_lateness` turns a stale cron slot into
 * a skipped run and advances `next_fire_at`; without it the slot fires once;
 * retention deletes old non-cron and rejected runs and keeps cron rows.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { accounts, projectSessions, projectTriggerExecutions, projectTriggerRuntime, projects, sessionTurns } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../shared/db';
import {
  claimDueScheduleSlots,
  claimTriggerExecutions,
  purgeExpiredTriggerRuns,
  recordTriggerRun,
  triggerRunFromFire,
} from './trigger-execution-store';
import { recordTriggerRunEnd, settleTriggerRunsFromTurns } from './lib/trigger-run-outcome';
import { nextTriggerScheduleSlot, triggerScheduleRevision } from './trigger-schedule';
import type { GitTriggerSpec } from './triggers';

const CONFIRMATION = 'I_UNDERSTAND_THIS_DELETES_TEST_DATA';
const HAS_CONFIRMED_TEST_DB = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === CONFIRMATION &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const describeWithDb = HAS_CONFIRMED_TEST_DB ? describe : describe.skip;

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const SLUG = 'run-history-proof';

const cronSpec: GitTriggerSpec = {
  slug: SLUG,
  path: `kortix.yaml#triggers.${SLUG}`,
  name: 'Run history proof',
  type: 'cron',
  agent: 'default',
  model: null,
  enabled: true,
  promptTemplate: 'Prove the run history',
  cron: '0 0 * * * *',
  runAt: null,
  timezone: 'UTC',
  secretEnv: null,
  run: null,
  monitorMode: null,
  intervalSeconds: null,
  expectEventWithinSeconds: null,
  sessionMode: 'fresh',
  pinnedSessionId: null,
  sessionKey: null,
  filter: null,
};
const webhookSpec: GitTriggerSpec = { ...cronSpec, type: 'webhook', cron: null, secretEnv: 'RUN_HISTORY_SECRET' };

const noPush = async () => ({ sent: 0 as const, reason: 'no_devices' as const });

async function runs() {
  return db
    .select()
    .from(projectTriggerExecutions)
    .where(and(eq(projectTriggerExecutions.projectId, PROJECT), eq(projectTriggerExecutions.slug, SLUG)));
}

async function run(executionId: string) {
  const [row] = await db
    .select()
    .from(projectTriggerExecutions)
    .where(eq(projectTriggerExecutions.executionId, executionId));
  return row!;
}

async function seedSession(): Promise<string> {
  const sessionId = crypto.randomUUID();
  await db.insert(projectSessions).values({
    sessionId,
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: `trigger-${sessionId.slice(0, 8)}`,
    createdBy: OWNER,
    metadata: { trigger_kind: 'git', trigger_slug: SLUG, trigger_source: 'manual', trigger_type: 'cron' },
  });
  return sessionId;
}

/** One manual fire that reached `sessionId`, stamped `at`. */
async function fire(sessionId: string, at: string) {
  return recordTriggerRun({
    projectId: PROJECT, slug: SLUG, source: 'manual', spec: cronSpec, payload: {},
    status: 'succeeded', sessionId, now: new Date(at),
  });
}

/** One `session_turns` ledger row; open unless `endedAt` is given. */
async function seedTurn(
  sessionId: string,
  turn: { startedAt: string; endedAt?: string; endReason?: string; endError?: { name: string; message: string } },
): Promise<string> {
  const turnToken = crypto.randomUUID();
  await db.insert(sessionTurns).values({
    turnToken,
    sessionId,
    sandboxId: crypto.randomUUID(),
    projectId: PROJECT,
    accountId: ACCOUNT,
    state: turn.endedAt ? 'ended' : 'active',
    endReason: turn.endReason ?? null,
    endError: turn.endError ?? null,
    startedAt: new Date(turn.startedAt),
    endedAt: turn.endedAt ? new Date(turn.endedAt) : null,
  });
  return turnToken;
}

async function endTurn(turnToken: string, endReason: string, endedAt: string, endError?: { name: string; message: string }) {
  await db
    .update(sessionTurns)
    .set({ state: 'ended', endReason, endError: endError ?? null, endedAt: new Date(endedAt) })
    .where(eq(sessionTurns.turnToken, turnToken));
}

async function seedCron(spec: GitTriggerSpec, nextFireAt: Date) {
  await db.insert(projectTriggerRuntime).values({
    projectId: PROJECT,
    slug: SLUG,
    triggerType: 'cron',
    enabled: true,
    scheduleCron: spec.cron,
    scheduleTimezone: spec.timezone,
    scheduleRevision: triggerScheduleRevision(spec),
    scheduleSpec: spec as unknown as Record<string, unknown>,
    nextFireAt,
  });
}

async function runtime() {
  const [row] = await db
    .select()
    .from(projectTriggerRuntime)
    .where(and(eq(projectTriggerRuntime.projectId, PROJECT), eq(projectTriggerRuntime.slug, SLUG)));
  return row!;
}

async function cleanup() {
  await db.delete(sessionTurns).where(eq(sessionTurns.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
}

describeWithDb('trigger run history — real PostgreSQL', () => {
  beforeEach(async () => {
    await cleanup();
    await db.insert(accounts).values({ accountId: ACCOUNT, name: 'trigger-run-history-test' });
    await db.insert(projects).values({
      projectId: PROJECT,
      accountId: ACCOUNT,
      name: 'trigger run history',
      repoUrl: 'https://example.test/run-history.git',
    });
  });
  afterEach(cleanup);

  test('a manual fire that reached a session is one succeeded run with run_status running', async () => {
    const sessionId = await seedSession();
    const commandId = crypto.randomUUID();
    const now = new Date('2026-10-16T09:00:00.000Z');
    const runId = await recordTriggerRun({
      projectId: PROJECT,
      slug: SLUG,
      source: 'manual',
      spec: cronSpec,
      payload: { source: 'manual', message: { text: '' } },
      ...triggerRunFromFire({ status: 'fired', sessionId, commandId }),
      now,
    });
    expect(runId).toBeString();
    const row = await run(runId!);
    expect(row).toMatchObject({
      source: 'manual',
      status: 'succeeded',
      sessionId,
      commandId,
      runStatus: 'running',
      payloadVerified: true,
      lastError: null,
      replayOf: null,
      payload: { source: 'manual', message: { text: '' } },
    });
    expect(row.scheduleRevision).toMatch(/^manual:[0-9a-f-]{36}$/);
    expect(row.scheduledFor.toISOString()).toBe(now.toISOString());
    expect(row.createdAt.toISOString()).toBe(now.toISOString());
    expect(row.completedAt?.toISOString()).toBe(now.toISOString());

    // A run row is terminal: the execution drain never claims it.
    expect(await claimTriggerExecutions({ now, workerId: 'run-history', limit: 10 })).toHaveLength(0);
  });

  test('a fire result maps to its run: queued into a session, deduped, failed', async () => {
    const sessionId = await seedSession();
    const now = new Date('2026-10-16T09:05:00.000Z');
    const base = { projectId: PROJECT, slug: SLUG, source: 'webhook' as const, spec: webhookSpec, payload: { body: {} }, now };
    const queued = await recordTriggerRun({
      ...base,
      ...triggerRunFromFire({ status: 'queued', sessionId, reason: 'prompt queued for delivery' }),
    });
    const deduped = await recordTriggerRun({ ...base, ...triggerRunFromFire({ status: 'queued', sessionId, deduped: true }) });
    const failed = await recordTriggerRun({ ...base, ...triggerRunFromFire({ status: 'failed', error: 'No account owner available to own the session' }) });
    const commandId = crypto.randomUUID();
    const requeued = await recordTriggerRun({
      ...base,
      ...triggerRunFromFire({ status: 'failed', requeued: true, commandId, error: 'sandbox capacity exhausted' }),
    });

    expect(await run(queued!)).toMatchObject({ source: 'webhook', status: 'succeeded', sessionId, runStatus: 'running', lastError: null });
    expect(await run(deduped!)).toMatchObject({ status: 'skipped', sessionId, runStatus: null, lastError: 'deduped' });
    expect(await run(failed!)).toMatchObject({
      status: 'failed',
      sessionId: null,
      runStatus: null,
      lastError: 'No account owner available to own the session',
    });
    // A create that went back to the lifecycle queue may still run: not failed.
    expect(await run(requeued!)).toMatchObject({
      status: 'requeued',
      sessionId: null,
      commandId,
      runStatus: null,
      lastError: 'sandbox capacity exhausted',
    });
    // The claim worker takes only queued/running rows, so none of these.
    expect(await claimTriggerExecutions({ now, workerId: 'run-history', limit: 10 })).toHaveLength(0);
  });

  test('a webhook rejected before its signature verified is stored rejected and unverified', async () => {
    const now = new Date('2026-10-16T09:10:00.000Z');
    const runId = await recordTriggerRun({
      projectId: PROJECT,
      slug: SLUG,
      source: 'webhook',
      spec: webhookSpec,
      payload: { body: { event: 'push' }, headers: {} },
      verified: false,
      status: 'rejected',
      error: 'signature_mismatch',
      now,
    });
    expect(await run(runId!)).toMatchObject({
      source: 'webhook',
      status: 'rejected',
      payloadVerified: false,
      lastError: 'signature_mismatch',
      sessionId: null,
      runStatus: null,
      payload: { body: { event: 'push' }, headers: {} },
    });
  });

  test('a payload over 64 KiB is stored as a size marker; one at the limit is kept', async () => {
    const now = new Date('2026-10-16T09:15:00.000Z');
    const big = { body: 'x'.repeat(70_000) };
    const bytes = Buffer.byteLength(JSON.stringify(big));
    // {"body":"<n x>"} is n + 11 bytes: exactly 64 KiB.
    const atLimit = { body: 'y'.repeat(64 * 1024 - 11) };
    expect(Buffer.byteLength(JSON.stringify(atLimit))).toBe(64 * 1024);
    const base = { projectId: PROJECT, slug: SLUG, source: 'manual' as const, spec: cronSpec, status: 'succeeded' as const, now };
    const capped = await recordTriggerRun({ ...base, payload: big });
    const kept = await recordTriggerRun({ ...base, payload: atLimit });
    expect((await run(capped!)).payload).toEqual({ truncated: true, bytes });
    expect((await run(kept!)).payload).toEqual(atLimit);
  });

  test('a turn end closes the run whose turn ended, with the outcome the turn ledger recorded', async () => {
    const sessionId = await seedSession();
    const older = await fire(sessionId, '2026-10-16T10:00:00.000Z');
    const newer = await fire(sessionId, '2026-10-16T10:01:00.000Z');
    const end = {
      projectId: PROJECT,
      accountId: ACCOUNT,
      sessionId,
      metadata: { trigger_kind: 'git', trigger_slug: SLUG },
      outcome: 'closed' as const,
      childSession: false,
    };
    await seedTurn(sessionId, {
      startedAt: '2026-10-16T10:00:01.000Z',
      endedAt: '2026-10-16T10:05:00.000Z',
      endReason: 'failed',
      endError: { name: 'APIError', message: 'Payment Required: Insufficient credits.' },
    });
    const newerTurn = await seedTurn(sessionId, { startedAt: '2026-10-16T10:05:01.000Z' });
    await recordTriggerRunEnd(
      { ...end, status: 'error', error: { name: 'APIError', message: 'Payment Required: Insufficient credits.' } },
      noPush,
    );
    expect(await run(older!)).toMatchObject({
      runStatus: 'failed',
      runError: 'Out of credits: Payment Required: Insufficient credits.',
    });
    expect((await run(older!)).runEndedAt?.toISOString()).toBe('2026-10-16T10:05:00.000Z');
    // The newer fire's turn is still going.
    expect(await run(newer!)).toMatchObject({ runStatus: 'running', runEndedAt: null });

    await endTurn(newerTurn, 'completed', '2026-10-16T10:09:00.000Z');
    await recordTriggerRunEnd({ ...end, status: 'idle' }, noPush);
    expect(await run(newer!)).toMatchObject({ runStatus: 'succeeded', runError: null });
    expect((await run(newer!)).runEndedAt?.toISOString()).toBe('2026-10-16T10:09:00.000Z');
    // A closed run keeps its first outcome.
    expect(await run(older!)).toMatchObject({ runStatus: 'failed' });

    // A pinned trigger's (or a reminder's) session carries no trigger
    // metadata; its run still closes.
    const pinned = await fire(sessionId, '2026-10-16T10:09:30.000Z');
    await seedTurn(sessionId, { startedAt: '2026-10-16T10:09:31.000Z', endedAt: '2026-10-16T10:10:00.000Z', endReason: 'completed' });
    await recordTriggerRunEnd({ ...end, metadata: {}, status: 'idle' }, noPush);
    expect(await run(pinned!)).toMatchObject({ runStatus: 'succeeded' });

    // A subagent turn says nothing about the run.
    const third = await fire(sessionId, '2026-10-16T10:10:30.000Z');
    const thirdTurn = await seedTurn(sessionId, { startedAt: '2026-10-16T10:10:31.000Z' });
    await recordTriggerRunEnd({ ...end, status: 'idle', childSession: true }, noPush);
    expect(await run(third!)).toMatchObject({ runStatus: 'running', runEndedAt: null });

    // A stopped turn closes the run as failed with "stopped", and is still
    // not a trigger run outcome: the trigger runtime is not touched.
    await endTurn(thirdTurn, 'failed', '2026-10-16T10:12:00.000Z', { name: 'MessageAbortedError', message: 'aborted' });
    const result = await recordTriggerRunEnd(
      { ...end, status: 'error', error: { name: 'MessageAbortedError', message: 'aborted' } },
      noPush,
    );
    expect(result).toBe('not_a_trigger_run');
    expect(await run(third!)).toMatchObject({ runStatus: 'failed', runError: 'stopped' });
    expect((await run(third!)).runEndedAt?.toISOString()).toBe('2026-10-16T10:12:00.000Z');
  });

  test('a run whose turn another path closed is not left running, and the next run is not blamed for it', async () => {
    // Prod, 2026-10-21: the turn ended, but the terminal relay did not answer
    // `closed` (the turn was already settled), so the run stayed "Running".
    // The next fire into the same session then closed THAT run with its own
    // outcome, and its own run stayed "Running" instead.
    const sessionId = await seedSession();
    const first = await fire(sessionId, '2026-10-21T13:06:57.000Z');
    await seedTurn(sessionId, { startedAt: '2026-10-21T13:06:58.000Z', endedAt: '2026-10-21T13:17:04.000Z', endReason: 'completed' });
    const end = {
      projectId: PROJECT,
      accountId: ACCOUNT,
      sessionId,
      metadata: { trigger_kind: 'git', trigger_slug: SLUG },
      status: 'idle' as const,
      childSession: false,
    };
    await recordTriggerRunEnd({ ...end, outcome: 'already_closed' }, noPush);
    expect(await run(first!)).toMatchObject({ runStatus: 'succeeded', runError: null });
    expect((await run(first!)).runEndedAt?.toISOString()).toBe('2026-10-21T13:17:04.000Z');

    const second = await fire(sessionId, '2026-10-21T13:38:26.000Z');
    const secondTurn = await seedTurn(sessionId, { startedAt: '2026-10-21T13:38:27.000Z' });
    expect(await run(second!)).toMatchObject({ runStatus: 'running', runEndedAt: null });
    await endTurn(secondTurn, 'failed', '2026-10-21T13:50:00.000Z', { name: 'APIError', message: 'Bad Gateway' });
    await recordTriggerRunEnd({ ...end, status: 'error', error: { name: 'APIError', message: 'Bad Gateway' }, outcome: 'closed' }, noPush);
    expect(await run(second!)).toMatchObject({ runStatus: 'failed' });
    expect((await run(second!)).runEndedAt?.toISOString()).toBe('2026-10-21T13:50:00.000Z');
    expect(await run(first!)).toMatchObject({ runStatus: 'succeeded' });
  });

  test('the maintenance settle closes runs whose turn ended with no relay at all', async () => {
    const sessionId = await seedSession();
    const gone = await fire(sessionId, '2026-10-21T10:00:00.000Z');
    await seedTurn(sessionId, { startedAt: '2026-10-21T10:00:01.000Z', endedAt: '2026-10-21T10:20:00.000Z', endReason: 'runtime_gone' });
    const live = await fire(sessionId, '2026-10-21T10:30:00.000Z');
    await seedTurn(sessionId, { startedAt: '2026-10-21T10:30:01.000Z' });
    const otherSession = await seedSession();
    const undelivered = await fire(otherSession, '2026-10-21T10:00:00.000Z');

    expect(await settleTriggerRunsFromTurns()).toBe(1);
    expect(await run(gone!)).toMatchObject({
      runStatus: 'failed',
      runError: 'The sandbox stopped before the turn ended.',
    });
    expect((await run(gone!)).runEndedAt?.toISOString()).toBe('2026-10-21T10:20:00.000Z');
    // A turn still going, and a fire whose prompt has not started a turn, stay open.
    expect(await run(live!)).toMatchObject({ runStatus: 'running', runEndedAt: null });
    expect(await run(undelivered!)).toMatchObject({ runStatus: 'running', runEndedAt: null });
    // Idempotent: nothing left to settle.
    expect(await settleTriggerRunsFromTurns()).toBe(0);
  });

  test('max_lateness skips a stale slot as a run and advances next_fire_at to the next future slot', async () => {
    const spec = { ...cronSpec, maxLatenessSeconds: 3600 };
    const scheduledFor = new Date('2026-07-27T01:00:00.000Z');
    const now = new Date('2026-07-27T03:30:00.000Z');
    await seedCron(spec, scheduledFor);

    expect(await claimDueScheduleSlots({ now, limit: 10 })).toHaveLength(0);

    const rows = await runs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'cron',
      status: 'skipped',
      lastError: 'missed: 150 min late, beyond max_lateness 1h',
      sessionId: null,
    });
    expect(rows[0]!.scheduledFor.toISOString()).toBe(scheduledFor.toISOString());
    expect(rows[0]!.completedAt?.toISOString()).toBe(now.toISOString());

    const next = nextTriggerScheduleSlot(spec, now, { jitterKey: `${PROJECT}:${SLUG}` });
    const row = await runtime();
    expect(row.nextFireAt?.toISOString()).toBe(next!.toISOString());
    expect(row.nextFireAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(row.lastScheduledFor?.toISOString()).toBe(scheduledFor.toISOString());

    // Nothing fires: the drain has no queued row to claim.
    expect(await claimTriggerExecutions({ now, workerId: 'run-history', limit: 10 })).toHaveLength(0);
  });

  test('a slot within max_lateness fires', async () => {
    const spec = { ...cronSpec, maxLatenessSeconds: 3600 };
    const scheduledFor = new Date('2026-07-27T01:00:00.000Z');
    await seedCron(spec, scheduledFor);
    const claimed = await claimDueScheduleSlots({ now: new Date('2026-07-27T01:59:00.000Z'), limit: 10 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.execution).toMatchObject({ status: 'queued', lastError: null });
  });

  test('without max_lateness a stale slot still fires once', async () => {
    const scheduledFor = new Date('2026-07-27T01:00:00.000Z');
    const now = new Date('2026-07-27T03:30:00.000Z');
    await seedCron(cronSpec, scheduledFor);

    const claimed = await claimDueScheduleSlots({ now, limit: 10 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.execution).toMatchObject({ source: 'cron', status: 'queued', lastError: null });
    expect(await runs()).toHaveLength(1);
    expect((await runtime()).nextFireAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(await claimTriggerExecutions({ now, workerId: 'run-history', limit: 10 })).toHaveLength(1);
  });

  test('retention deletes non-cron runs after 30 days and rejected runs after 7, and keeps cron rows', async () => {
    const now = new Date('2026-10-16T12:00:00.000Z');
    const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60_000);
    const base = { projectId: PROJECT, slug: SLUG, spec: webhookSpec, payload: {} };
    const oldManual = await recordTriggerRun({ ...base, source: 'manual', status: 'succeeded', now: daysAgo(31) });
    const recentManual = await recordTriggerRun({ ...base, source: 'manual', status: 'succeeded', now: daysAgo(29) });
    const oldRejected = await recordTriggerRun({ ...base, source: 'webhook', verified: false, status: 'rejected', error: 'signature_mismatch', now: daysAgo(8) });
    const recentRejected = await recordTriggerRun({ ...base, source: 'webhook', verified: false, status: 'rejected', error: 'signature_mismatch', now: daysAgo(6) });
    await seedCron(cronSpec, daysAgo(40));
    expect(await claimDueScheduleSlots({ now: daysAgo(40), limit: 10 })).toHaveLength(1);

    expect(await purgeExpiredTriggerRuns(now)).toBe(2);
    const left = (await runs()).map((row) => row.executionId).sort();
    const cronRow = (await runs()).find((row) => row.source === 'cron');
    expect(cronRow).toBeDefined();
    expect(left).toEqual([recentManual!, recentRejected!, cronRow!.executionId].sort());
    expect(left).not.toContain(oldManual!);
    expect(left).not.toContain(oldRejected!);
  });
});
