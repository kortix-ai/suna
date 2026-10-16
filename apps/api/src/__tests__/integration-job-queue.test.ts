/**
 * Integration test (real local PostgreSQL): the durable job queue.
 * Enqueue is idempotent per (queue, key); a claim is exclusive (SKIP LOCKED)
 * until its visibility timeout passes; a failure backs off and dies after
 * max_attempts; a stale worker cannot complete a job another worker re-claimed.
 */
import { expect, test } from 'bun:test';
import { jobQueue } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { claimJobs, completeJob, enqueueJob, failJob, pruneFinishedJobs } from '../shared/job-queue';

const queue = () => `test-${crypto.randomUUID()}`;

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
