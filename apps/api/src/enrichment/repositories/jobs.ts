/**
 * Queue access for enrichment jobs.
 *
 * The claim follows the house pattern from `session_lifecycle_commands`:
 * select candidates, then take each one with a conditional UPDATE guarded on
 * the status we observed. Two workers racing for the same row means one UPDATE
 * matches nothing and that worker simply moves on, so no row is ever processed
 * twice without a lease having expired first.
 *
 * Expired leases are reclaimed by the same query. A worker that crashes
 * mid-job leaves its row `running` with a stale `locked_until`, and the next
 * tick picks it up rather than leaving it stuck forever.
 */
import { enrichmentJobs } from '@kortix/db';
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import type { EnrichmentErrorCode } from '../errors';

export type EnrichmentJobRow = typeof enrichmentJobs.$inferSelect;

export const ACTIVE_STATUSES = ['queued', 'running'] as const;

export interface EnqueueArgs {
  accountId: string;
  projectId: string;
  createdBy: string | null;
  domain: string;
  idempotencyKey: string;
  force: boolean;
}

/**
 * Enqueue, or attach to the live job for the same project + domain. The
 * partial unique index is the real arbiter — the pre-check is an optimisation,
 * and a concurrent insert that loses the race is resolved by re-reading.
 */
export async function enqueueJob(
  args: EnqueueArgs,
): Promise<{ job: EnrichmentJobRow; attached: boolean }> {
  const existing = await findActiveJob(args.projectId, args.domain);
  if (existing) return { job: existing, attached: true };

  try {
    const [inserted] = await db
      .insert(enrichmentJobs)
      .values({
        accountId: args.accountId,
        projectId: args.projectId,
        createdBy: args.createdBy,
        domain: args.domain,
        idempotencyKey: args.idempotencyKey,
        status: 'queued',
        payload: { force: args.force },
      })
      .returning();
    return { job: inserted, attached: false };
  } catch (err) {
    const raced = await findActiveJob(args.projectId, args.domain);
    if (raced) return { job: raced, attached: true };
    throw err;
  }
}

export async function findActiveJob(
  projectId: string,
  domain: string,
): Promise<EnrichmentJobRow | null> {
  const [row] = await db
    .select()
    .from(enrichmentJobs)
    .where(
      and(
        eq(enrichmentJobs.projectId, projectId),
        eq(enrichmentJobs.domain, domain),
        inArray(enrichmentJobs.status, [...ACTIVE_STATUSES]),
      ),
    )
    .orderBy(desc(enrichmentJobs.createdAt))
    .limit(1);
  return row ?? null;
}

export async function getJobForAccount(
  jobId: string,
  accountId: string,
): Promise<EnrichmentJobRow | null> {
  const [row] = await db
    .select()
    .from(enrichmentJobs)
    .where(and(eq(enrichmentJobs.jobId, jobId), eq(enrichmentJobs.accountId, accountId)))
    .limit(1);
  return row ?? null;
}

export async function claimDueJobs(input: {
  workerId: string;
  limit: number;
  leaseMs: number;
  now?: Date;
}): Promise<EnrichmentJobRow[]> {
  const now = input.now ?? new Date();

  const candidates = await db
    .select()
    .from(enrichmentJobs)
    .where(
      or(
        and(
          eq(enrichmentJobs.status, 'queued'),
          lte(enrichmentJobs.availableAt, now),
          or(isNull(enrichmentJobs.lockedUntil), lte(enrichmentJobs.lockedUntil, now)),
        ),
        // A crashed worker's row: still `running`, but its lease has lapsed.
        and(eq(enrichmentJobs.status, 'running'), lte(enrichmentJobs.lockedUntil, now)),
      ),
    )
    .orderBy(asc(enrichmentJobs.availableAt), asc(enrichmentJobs.createdAt))
    .limit(input.limit);

  const claimed: EnrichmentJobRow[] = [];
  for (const row of candidates) {
    const [locked] = await db
      .update(enrichmentJobs)
      .set({
        status: 'running',
        attempts: row.attempts + 1,
        lockedBy: input.workerId,
        lockedUntil: new Date(now.getTime() + input.leaseMs),
        updatedAt: now,
      })
      .where(
        and(
          eq(enrichmentJobs.jobId, row.jobId),
          eq(enrichmentJobs.status, row.status),
          or(isNull(enrichmentJobs.lockedUntil), lte(enrichmentJobs.lockedUntil, now)),
        ),
      )
      .returning();
    if (locked) claimed.push(locked);
  }
  return claimed;
}

export async function completeJob(
  jobId: string,
  result: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  await db
    .update(enrichmentJobs)
    .set({
      status: 'succeeded',
      result,
      errorCode: null,
      lastError: null,
      lockedBy: null,
      lockedUntil: null,
      finishedAt: now,
      updatedAt: now,
    })
    .where(eq(enrichmentJobs.jobId, jobId));
}

export async function failJob(input: {
  jobId: string;
  errorCode: EnrichmentErrorCode;
  message: string;
  result?: Record<string, unknown>;
  deadLettered?: boolean;
}): Promise<void> {
  const now = new Date();
  await db
    .update(enrichmentJobs)
    .set({
      status: input.deadLettered ? 'dead_lettered' : 'failed',
      errorCode: input.errorCode,
      lastError: input.message.slice(0, 4_000),
      ...(input.result ? { result: input.result } : {}),
      lockedBy: null,
      lockedUntil: null,
      finishedAt: now,
      updatedAt: now,
    })
    .where(eq(enrichmentJobs.jobId, input.jobId));
}

/** Release a job back to the queue with a backoff gate. */
export async function rescheduleJob(input: {
  jobId: string;
  availableAt: Date;
  message: string;
}): Promise<void> {
  const now = new Date();
  await db
    .update(enrichmentJobs)
    .set({
      status: 'queued',
      availableAt: input.availableAt,
      lastError: input.message.slice(0, 4_000),
      lockedBy: null,
      lockedUntil: null,
      updatedAt: now,
    })
    .where(eq(enrichmentJobs.jobId, input.jobId));
}

export async function countActiveJobs(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(enrichmentJobs)
    .where(inArray(enrichmentJobs.status, [...ACTIVE_STATUSES]));
  return row?.count ?? 0;
}
