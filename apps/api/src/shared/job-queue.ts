/**
 * The durable job queue: one Postgres table (`kortix.job_queue`), no broker.
 *
 *   enqueueJob(queue, key, payload)  idempotent per (queue, key): a key that
 *                                    exists is a no-op, so producers re-send freely
 *   claimJobs(queues, n, visibility) FOR UPDATE SKIP LOCKED; a claimed row is
 *                                    hidden until `locked_until`, then claimable
 *                                    again (the worker that held it crashed)
 *   completeJob / failJob            only the current claim (same `attempts`) may
 *                                    settle a job; failure backs off exponentially
 *                                    and marks the job `dead` after max_attempts
 *
 * `startJobWorker()` (workers/job-queue-worker.ts) runs on every replica: SKIP LOCKED spreads the work, and a
 * restart loses nothing because a claim is only a timestamp. Handlers must be
 * idempotent: a job runs at least once. A job holds one of its replica's slots
 * while it runs, so a slow job never stops another queue; a run that outlives
 * its visibility is claimed again while it still runs.
 */
import { jobQueue } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './db';
import { trackDetached } from './drain';
import { logger } from '../lib/logger';

export type Job = typeof jobQueue.$inferSelect;
export type JobHandler = (job: Job) => Promise<void>;

type Handler = { run: JobHandler; visibilityMs: number; batch?: number; running: number };

// replica-local: the handler registry is code, registered at import; every replica registers the same handlers.
const handlers = new Map<string, Handler>();
// This replica's running jobs, and the queue the next claim visits first.
let running = 0;
let first = 0;

/**
 * Register the handler of one queue. `visibilityMs` must exceed the handler's
 * worst run time. `batch`: jobs of this queue running at once on a replica
 * (default: the replica's limit).
 */
export function registerJobHandler(queue: string, run: JobHandler, visibilityMs = 5 * 60_000, batch?: number): void {
  handlers.set(queue, { run, visibilityMs, batch, running: 0 });
}

/** Insert a job unless `(queue, key)` exists. True when this call inserted it. */
export async function enqueueJob(
  queue: string,
  key: string,
  payload: Record<string, unknown> = {},
  opts: { runAt?: Date; maxAttempts?: number } = {},
): Promise<boolean> {
  const inserted = await db
    .insert(jobQueue)
    .values({
      queue,
      jobKey: key,
      payload,
      ...(opts.runAt ? { runAt: opts.runAt } : {}),
      ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}),
    })
    .onConflictDoNothing({ target: [jobQueue.queue, jobQueue.jobKey] })
    .returning({ jobId: jobQueue.jobId });
  return inserted.length > 0;
}

/**
 * Insert many jobs of one queue in one statement; existing keys are skipped. Returns how many were new.
 * `executor`: a transaction, so the jobs commit with the state change that produced them.
 */
export async function enqueueJobs(
  queue: string,
  jobs: Array<{ key: string; payload?: Record<string, unknown> }>,
  opts: { maxAttempts?: number; executor?: Pick<typeof db, 'insert'> } = {},
): Promise<number> {
  if (jobs.length === 0) return 0;
  const inserted = await (opts.executor ?? db)
    .insert(jobQueue)
    .values(jobs.map((job) => ({
      queue,
      jobKey: job.key,
      payload: job.payload ?? {},
      ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}),
    })))
    .onConflictDoNothing({ target: [jobQueue.queue, jobQueue.jobKey] })
    .returning({ jobId: jobQueue.jobId });
  return inserted.length;
}

/** Claim up to `limit` due jobs of these queues, hidden from other workers for `visibilityMs`. */
export async function claimJobs(queues: string[], limit: number, visibilityMs: number): Promise<Job[]> {
  if (queues.length === 0 || limit < 1) return [];
  const due = sql`(
    SELECT job_id FROM kortix.job_queue
     WHERE queue IN (${sql.join(queues.map((q) => sql`${q}`), sql`, `)})
       AND status = 'queued' AND run_at <= now()
       AND (locked_until IS NULL OR locked_until < now())
     ORDER BY run_at
     LIMIT ${limit}
     FOR UPDATE SKIP LOCKED)`;
  return db
    .update(jobQueue)
    .set({
      lockedUntil: sql`now() + make_interval(secs => ${visibilityMs / 1000})`,
      attempts: sql`${jobQueue.attempts} + 1`,
      updatedAt: sql`now()`,
    })
    .where(inArray(jobQueue.jobId, due))
    .returning();
}

const ownClaim = (job: Job) =>
  and(eq(jobQueue.jobId, job.jobId), eq(jobQueue.attempts, job.attempts), eq(jobQueue.status, 'queued'));

/** Mark a claimed job done. False when the claim is stale (another worker re-claimed it). */
export async function completeJob(job: Job): Promise<boolean> {
  const done = await db
    .update(jobQueue)
    .set({ status: 'done', lockedUntil: null, updatedAt: sql`now()` })
    .where(ownClaim(job))
    .returning({ jobId: jobQueue.jobId });
  return done.length > 0;
}

/** Backoff after attempt n: 10 s · 2^(n-1), capped at 1 h. */
export function retryDelayMs(attempts: number): number {
  return Math.min(10_000 * 2 ** Math.max(0, attempts - 1), 60 * 60_000);
}

/** Record a failure: retry later with backoff, or `dead` after the last attempt. */
export async function failJob(job: Job, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  const last = job.attempts >= job.maxAttempts;
  await db
    .update(jobQueue)
    .set({
      status: last ? 'dead' : 'queued',
      runAt: sql`now() + make_interval(secs => ${retryDelayMs(job.attempts) / 1000})`,
      lockedUntil: null,
      lastError: message,
      updatedAt: sql`now()`,
    })
    .where(ownClaim(job));
  if (last) logger.error('[job-queue] job dead after max attempts', { queue: job.queue, key: job.jobKey, error: message });
}

/** Delete done and dead jobs older than `days`. Bounds the table. */
export async function pruneFinishedJobs(days = 7): Promise<void> {
  await db.execute(
    sql`DELETE FROM kortix.job_queue WHERE status <> 'queued' AND updated_at < now() - make_interval(days => ${days})`,
  );
}

/**
 * Claim due jobs into this replica's free slots and start them: at most `limit`
 * jobs at once, at most `batch` of one queue, and never every slot for one
 * queue (one stays for the others). A slow job holds only its own slot, so no
 * other queue waits for it. The queue claimed first rotates, so a
 * busy queue cannot take every slot that frees. The shutdown drain waits for
 * started jobs. `wait: false` (the worker) returns once they started, and
 * `onSlotFree` runs as each one settles; otherwise the call waits for them.
 * Returns how many jobs started.
 */
export async function runJobBatch(
  limit = 4,
  opts: { wait?: boolean; onSlotFree?: () => void } = {},
): Promise<number> {
  const queues = [...handlers];
  const started: Promise<void>[] = [];
  for (let i = 0; i < queues.length; i++) {
    const [queue, handler] = queues[(first + i) % queues.length]!;
    const cap = Math.min(handler.batch ?? limit, Math.max(1, limit - 1));
    const free = Math.min(cap - handler.running, limit - running);
    for (const job of await claimJobs([queue], free, handler.visibilityMs)) {
      handler.running += 1;
      running += 1;
      const run = runJob(handler, job).finally(() => {
        handler.running -= 1;
        running -= 1;
        opts.onSlotFree?.();
      });
      trackDetached(run);
      started.push(run);
    }
  }
  first += 1;
  if (opts.wait !== false) await Promise.all(started);
  return started.length;
}

/** Run one claimed job and settle it. Never throws. */
async function runJob(handler: Handler, job: Job): Promise<void> {
  const startedAt = Date.now();
  try {
    // The claim of the last attempt never settled: its replica died, a deploy
    // cut it, or it ran past its visibility. Without this a job that kills its
    // replica is claimed again forever.
    if (job.attempts > job.maxAttempts) {
      throw new Error(
        `attempt ${job.maxAttempts} of ${job.maxAttempts} never settled (a crash, a deploy, or a run longer than its visibility); previous: ${job.lastError ?? 'none'}`,
      );
    }
    await handler.run(job);
    await completeJob(job);
  } catch (error) {
    logger.warn('[job-queue] job failed', { queue: job.queue, key: job.jobKey, attempts: job.attempts, error: String(error) });
    await failJob(job, error).catch((settleError) =>
      logger.error('[job-queue] job not settled; its claim expires', { queue: job.queue, key: job.jobKey, error: String(settleError) }));
  }
  // ponytail: no lease heartbeat. A run past its visibility is claimed again (here or
  // on a peer) while it still runs, so its handler must be a no-op on a second run.
  // Add a heartbeat and a deadline for a handler that cannot be.
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs > handler.visibilityMs) {
    logger.warn('[job-queue] run outlived its visibility', { queue: job.queue, key: job.jobKey, elapsedMs, visibilityMs: handler.visibilityMs });
  }
}
