/**
 * Integration test (real local PostgreSQL): the durable job queue.
 * Enqueue is idempotent per (queue, key); a claim is exclusive (SKIP LOCKED)
 * until its visibility timeout passes; a failure backs off and dies after
 * max_attempts; a stale worker cannot complete a job another worker re-claimed.
 * A running job holds one slot of its replica: a slow job stops no other queue,
 * and a job whose last claim never settled is dead instead of claimed forever.
 */
import { expect, test } from 'bun:test';
import { jobQueue } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { emitIntegrationEvent, INTEGRATION_EVENTS_QUEUE, registerEventConsumer } from '../integrations/event-inbox';
import { claimJobs, completeJob, enqueueJob, failJob, pruneFinishedJobs, registerJobHandler, runJobBatch } from '../shared/job-queue';

const queue = () => `test-${crypto.randomUUID()}`;

/** A handler that waits until `open()`, and counts its runs. */
function gated() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const handler = { runs: 0, open, run: async () => { handler.runs++; await opened; } };
  return handler;
}

/** `onSlotFree` for `runJobBatch`, and a promise per settle count. */
function settles() {
  let count = 0;
  const waiting: Array<{ at: number; resolve: () => void }> = [];
  return {
    onSlotFree: () => {
      count++;
      for (const w of waiting.filter((w) => w.at <= count)) w.resolve();
    },
    reached: (at: number) => new Promise<void>((resolve) => (count >= at ? resolve() : waiting.push({ at, resolve }))),
  };
}

const statuses = async (q: string) =>
  (await db.select({ status: jobQueue.status, attempts: jobQueue.attempts }).from(jobQueue).where(eq(jobQueue.queue, q)))
    .map((r) => `${r.status}/${r.attempts}`)
    .sort();

async function row(q: string, key: string) {
  const [r] = await db.select().from(jobQueue).where(and(eq(jobQueue.queue, q), eq(jobQueue.jobKey, key)));
  return r!;
}

test('enqueue is idempotent per (queue, key)', async () => {
  const q = queue();
  expect(await enqueueJob(q, 'k1', { a: 1 })).toBe(true);
  expect(await enqueueJob(q, 'k1', { a: 2 })).toBe(false);
  expect((await row(q, 'k1')).payload).toEqual({ a: 1 });
});

test('two concurrent claims never return the same job', async () => {
  const q = queue();
  for (let i = 0; i < 10; i++) await enqueueJob(q, `k${i}`);
  const [a, b] = await Promise.all([claimJobs([q], 6, 60_000), claimJobs([q], 6, 60_000)]);
  const ids = [...a, ...b].map((j) => j.jobId);
  expect(ids.length).toBe(10);
  expect(new Set(ids).size).toBe(10);
  expect(await claimJobs([q], 10, 60_000)).toEqual([]);
});

test('a job whose visibility timeout passed is claimed again (a worker crashed)', async () => {
  const q = queue();
  await enqueueJob(q, 'k');
  const [first] = await claimJobs([q], 1, 60_000);
  expect(first!.attempts).toBe(1);
  await db.update(jobQueue).set({ lockedUntil: sql`now() - interval '1 second'` }).where(eq(jobQueue.jobId, first!.jobId));
  const [second] = await claimJobs([q], 1, 60_000);
  expect(second!.jobId).toBe(first!.jobId);
  expect(second!.attempts).toBe(2);
  // The crashed worker's late completion is refused: the job belongs to the second claim.
  expect(await completeJob(first!)).toBe(false);
  expect(await completeJob(second!)).toBe(true);
  expect((await row(q, 'k')).status).toBe('done');
});

test('a failure backs off, and the last attempt marks the job dead', async () => {
  const q = queue();
  await enqueueJob(q, 'k', {}, { maxAttempts: 2 });
  const [first] = await claimJobs([q], 1, 60_000);
  await failJob(first!, new Error('boom 1'));
  let r = await row(q, 'k');
  expect(r.status).toBe('queued');
  expect(r.lastError).toBe('boom 1');
  expect(r.runAt.getTime()).toBeGreaterThan(Date.now());
  expect(await claimJobs([q], 1, 60_000)).toEqual([]);
  await db.update(jobQueue).set({ runAt: sql`now()` }).where(eq(jobQueue.jobId, first!.jobId));
  const [second] = await claimJobs([q], 1, 60_000);
  await failJob(second!, new Error('boom 2'));
  r = await row(q, 'k');
  expect(r.status).toBe('dead');
  expect(await claimJobs([q], 1, 60_000)).toEqual([]);
});

test('a done job is never re-run by a re-enqueue, and pruning drops old finished rows only', async () => {
  const q = queue();
  await enqueueJob(q, 'old');
  await enqueueJob(q, 'live');
  const [job] = await claimJobs([q], 1, 60_000);
  await completeJob(job!);
  expect(await enqueueJob(q, job!.jobKey)).toBe(false);
  await db.update(jobQueue).set({ updatedAt: sql`now() - interval '8 days'` }).where(eq(jobQueue.jobId, job!.jobId));
  await pruneFinishedJobs(7);
  const left = await db.select({ key: jobQueue.jobKey }).from(jobQueue).where(eq(jobQueue.queue, q));
  expect(left.map((r) => r.key)).toEqual([job!.jobKey === 'old' ? 'live' : 'old']);
});

test('a slow job holds one slot: another queue runs, and the slow queue waits only for its own batch', async () => {
  const slow = queue();
  const fast = queue();
  const gate = gated();
  let fastRuns = 0;
  registerJobHandler(slow, gate.run, 60_000, 1);
  registerJobHandler(fast, async () => { fastRuns++; }, 60_000);
  await enqueueJob(slow, 's1');
  await enqueueJob(slow, 's2');
  await enqueueJob(fast, 'f1');
  const settled = settles();

  // The call returns while the slow job still runs (the tick used to wait for it).
  expect(await runJobBatch(4, { wait: false, onSlotFree: settled.onSlotFree })).toBe(2);
  await settled.reached(1);
  expect(fastRuns).toBe(1);
  expect(await statuses(fast)).toEqual(['done/1']);
  // One slow job runs (batch 1); its second waits unclaimed.
  expect(await statuses(slow)).toEqual(['queued/0', 'queued/1']);
  expect(await runJobBatch(4, { wait: false, onSlotFree: settled.onSlotFree })).toBe(0);

  gate.open();
  await settled.reached(2);
  expect(await runJobBatch()).toBe(1);
  expect(await statuses(slow)).toEqual(['done/1', 'done/1']);
});

test('a replica runs at most `limit` jobs at once across its queues', async () => {
  const queues = [queue(), queue(), queue()];
  const gates = queues.map(() => gated());
  queues.forEach((q, i) => registerJobHandler(q, gates[i]!.run, 60_000));
  for (const q of queues) await enqueueJob(q, 'k');
  const settled = settles();

  expect(await runJobBatch(2, { wait: false, onSlotFree: settled.onSlotFree })).toBe(2);
  const all = (await Promise.all(queues.map(statuses))).flat().sort();
  expect(all).toEqual(['queued/0', 'queued/1', 'queued/1']);
  expect(await runJobBatch(2, { wait: false, onSlotFree: settled.onSlotFree })).toBe(0);

  gates.forEach((g) => g.open());
  await settled.reached(2);
  expect(await runJobBatch(2)).toBe(1);
  expect((await Promise.all(queues.map(statuses))).flat()).toEqual(['done/1', 'done/1', 'done/1']);
});

test('a job whose last claim never settled is dead, not run again, and keeps its earlier error', async () => {
  const q = queue();
  let runs = 0;
  registerJobHandler(q, async () => { runs++; }, 60_000);
  await enqueueJob(q, 'k', {}, { maxAttempts: 2 });
  // Attempt 2 of 2 was claimed and its replica died: the claim expired unsettled.
  await db
    .update(jobQueue)
    .set({ attempts: 2, lastError: 'boom 1', lockedUntil: sql`now() - interval '1 second'` })
    .where(and(eq(jobQueue.queue, q), eq(jobQueue.jobKey, 'k')));

  expect(await runJobBatch()).toBe(1);
  expect(runs).toBe(0);
  const r = await row(q, 'k');
  expect(r.status).toBe('dead');
  expect(r.lastError).toStartWith('attempt 2 of 2 never settled');
  expect(r.lastError).toEndWith('previous: boom 1');
});

test("each integration's events ride their own queue; Telegram keeps the shared one", async () => {
  const integration = `synthetic${crypto.randomUUID().slice(0, 8)}`;
  const seen: Array<{ id: string; finalAttempt: boolean }> = [];
  registerEventConsumer(`${integration}.`, async (event, run) => {
    seen.push({ id: event.id, finalAttempt: run.finalAttempt });
  });
  const event = (type: string, id: string) => ({ id, source: `${type.split('.')[0]}:src`, type, time: '2026-10-27T00:00:00Z', subject: null, projectId: crypto.randomUUID(), data: {} });
  const telegramId = crypto.randomUUID();
  expect(await emitIntegrationEvent(event(`${integration}.thing.created`, 'e1'))).toBe(true);
  expect(await emitIntegrationEvent(event('telegram.message.created', telegramId))).toBe(true);
  try {
    expect(await statuses(`${INTEGRATION_EVENTS_QUEUE}.${integration}`)).toEqual(['queued/0']);
    const [telegram] = await db.select({ queue: jobQueue.queue }).from(jobQueue).where(eq(jobQueue.jobKey, `telegram:src:${telegramId}`));
    expect(telegram?.queue).toBe(INTEGRATION_EVENTS_QUEUE);

    await runJobBatch();
    expect(seen).toEqual([{ id: 'e1', finalAttempt: false }]);
    expect(await statuses(`${INTEGRATION_EVENTS_QUEUE}.${integration}`)).toEqual(['done/1']);
  } finally {
    await db.delete(jobQueue).where(eq(jobQueue.jobKey, `telegram:src:${telegramId}`));
  }
});
