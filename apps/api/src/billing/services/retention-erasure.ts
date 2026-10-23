/**
 * The retention backstop for whole accounts. The DPA and the Data Retention
 * Policy promise that a terminated account's personal data is deleted within
 * 90 days of the termination.
 *
 * What "terminated" means (decision D6b, 2026-10-14): an account closure, and
 * nothing else. A closure is an open `account_deletion_requests` row, written
 * by `POST /v1/account/request-deletion` or by the auth-user-delete trigger.
 * The account closes at the row's `scheduled_for` (the end of the 14-day
 * grace). A plan cancellation, a downgrade to Free, a payment failure or an
 * idle Free account is not a closure. The selection below matches `CLOSING`
 * in `projects/session-log-purge.ts` with one difference: it keeps a request
 * whose account row is already gone. That is a partial run (the routine
 * deletes the data before the login), and only a retry deletes the rest.
 *
 * Normally the account-deletion worker erases a closure on its date. It leaves
 * a request for a person when the request is more than 2 days past its date
 * (`MAX_OVERDUE`), when the run keeps failing, or while
 * `ACCOUNT_DELETION_SWEEP_PAUSED` is set. This backstop takes every closure
 * still open `RETENTION_ERASURE_AFTER_DAYS` (default 80) after its date and
 * runs the one deletion routine (`runAccountDeletion`) on it, so the account
 * is gone before day 90.
 *
 * A closure whose account still acts as a live customer (`LIVE`: a paid plan
 * whose payment is not cancelled, or a session created or a turn started after
 * the close) is not erased. It is recorded as `skipped_live` for a person.
 *
 * Every decision leaves one `kortix.retention_erasures` row per account, UTC
 * day and mode: ids, dates and the outcome, no personal data. The row has no
 * foreign key, so it outlives the account. `dry_run` writes `would_erase` and
 * deletes nothing.
 *
 * A tick is bounded (`RETENTION_ERASURE_BATCH` accounts) and idempotent: an
 * account decided today in this mode is not selected again today, the claim is
 * atomic, and a failed run returns the request to `pending` for tomorrow.
 */
import { retentionErasures } from '@kortix/db';
import { sql } from 'drizzle-orm';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { liveClosedAccountSql } from '../../projects/surface';
import {
  claimOpenDeletionRequest,
  markDeletionCompleted,
  releaseDeletionRequest,
} from '../repositories/account-deletion';
import { runAccountDeletion } from './account-deletion';

export const RETENTION_ERASURE_BATCH = 25;
const ERROR_MAX_CHARS = 500;

export type RetentionMode = 'dry_run' | 'execute';
export type RetentionOutcome = 'would_erase' | 'erased' | 'failed' | 'skipped_live';

export type RetentionCandidate = {
  account_id: string;
  request_id: string;
  requested_at: string | null;
  closed_at: string;
  live: boolean;
};

export type RetentionResult = { selected: number } & Record<RetentionOutcome, number>;

/**
 * The closures due for the backstop on `now`, oldest close first: open,
 * closed at least `afterDays` ago, and not yet decided
 * today in `mode`. `request_id` is the earliest-dated open request.
 */
export async function dueClosures(
  now: Date,
  afterDays: number,
  mode: RetentionMode,
  limit: number,
): Promise<RetentionCandidate[]> {
  const at = sql`${now.toISOString()}::timestamptz`;
  const rows = await db.execute(sql`
    select k.account_id::text as account_id, r.id::text as request_id,
      r.requested_at, k.closed_at, ${liveClosedAccountSql('k')} as live
    from (select r.account_id, min(r.scheduled_for) as closed_at
      from kortix.account_deletion_requests r
      where r.status in ('pending', 'processing') and not coalesce(r.is_cancelled, false)
      group by r.account_id) k
    cross join lateral (
      select r.id, r.requested_at from kortix.account_deletion_requests r
      where r.account_id = k.account_id and r.status in ('pending', 'processing')
        and not coalesce(r.is_cancelled, false)
      order by r.scheduled_for, r.id limit 1) r
    where k.closed_at + make_interval(days => ${afterDays}) <= ${at}
      and not exists (select 1 from kortix.retention_erasures e
        where e.account_id = k.account_id and e.mode = ${mode}
          and e.run_on = (${at} at time zone 'utc')::date)
    order by k.closed_at, k.account_id
    limit ${limit}`);
  return rows as unknown as RetentionCandidate[];
}

async function record(
  row: RetentionCandidate,
  now: Date,
  mode: RetentionMode,
  outcome: RetentionOutcome,
  error?: string,
): Promise<void> {
  const values = {
    accountId: row.account_id,
    requestId: row.request_id,
    requestedAt: row.requested_at ? new Date(row.requested_at) : null,
    closedAt: new Date(row.closed_at),
    runOn: now.toISOString().slice(0, 10),
    mode,
    outcome,
    error: error ? error.slice(0, ERROR_MAX_CHARS) : null,
    decidedAt: now,
  };
  await db
    .insert(retentionErasures)
    .values(values)
    .onConflictDoUpdate({
      target: [retentionErasures.accountId, retentionErasures.runOn, retentionErasures.mode],
      set: { outcome: values.outcome, error: values.error, decidedAt: values.decidedAt },
    });
}

/** Erase one closure through the deletion routine. Returns the outcome to record. */
async function erase(row: RetentionCandidate): Promise<{ outcome: RetentionOutcome; error?: string } | null> {
  const request = await claimOpenDeletionRequest(row.request_id);
  // A cancel or the account-deletion worker got there first: nothing to record.
  if (!request) return null;
  try {
    await runAccountDeletion(request.accountId, request.userId, request.id);
    await markDeletionCompleted(request.id);
    return { outcome: 'erased' };
  } catch (err) {
    await releaseDeletionRequest(request.id).catch((releaseErr) =>
      logger.error('[RetentionErasure] release failed', { requestId: request.id, error: String(releaseErr) }),
    );
    // A Supabase or Stripe error is not always an Error instance: read its message.
    const message = (err as { message?: unknown } | null)?.message;
    return { outcome: 'failed', error: typeof message === 'string' ? message : String(err) };
  }
}

export async function processRetentionErasures(
  options: { now?: Date; mode?: RetentionMode; afterDays?: number; limit?: number } = {},
): Promise<RetentionResult> {
  const now = options.now ?? new Date();
  const afterDays = options.afterDays ?? config.RETENTION_ERASURE_AFTER_DAYS;
  let mode: RetentionMode = options.mode ?? (config.RETENTION_ERASURE_MODE === 'execute' ? 'execute' : 'dry_run');
  if (mode === 'execute' && config.ACCOUNT_DELETION_SWEEP_PAUSED) {
    logger.warn('[RetentionErasure] ACCOUNT_DELETION_SWEEP_PAUSED is set: this tick runs as dry_run');
    mode = 'dry_run';
  }

  const result: RetentionResult = { selected: 0, would_erase: 0, erased: 0, failed: 0, skipped_live: 0 };
  const rows = await dueClosures(now, afterDays, mode, options.limit ?? RETENTION_ERASURE_BATCH);
  result.selected = rows.length;

  for (const row of rows) {
    let decision: { outcome: RetentionOutcome; error?: string } | null;
    if (row.live) decision = { outcome: 'skipped_live' };
    else if (mode === 'dry_run') decision = { outcome: 'would_erase' };
    else decision = await erase(row);
    if (!decision) continue;
    if (decision.outcome === 'failed') {
      logger.error('[RetentionErasure] erasure failed', { accountId: row.account_id, error: decision.error });
    }
    await record(row, now, mode, decision.outcome, decision.error);
    result[decision.outcome]++;
  }

  logger.info('[RetentionErasure] tick', { mode, afterDays, ...result });
  return result;
}
