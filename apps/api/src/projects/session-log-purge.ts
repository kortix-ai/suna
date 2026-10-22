/**
 * Retention purge (P2.8, decisions D6 and D6b). The legal page promises that customer
 * content is "deleted within 90 days after it ends", files included. Two things
 * end content, each with its own windows:
 *
 * | what ended                | rows go          | objects go (rows + 7 days) | all gone |
 * | a session was deleted     | delete + 30 days | delete + 37 days           | day 37   |
 * | the account was closed    | close + 80 days  | close + 87 days            | day 87   |
 *
 * "Rows" are the v2 `session_log*` rows and, until the v1 mirror is drained
 * (`mirrorDrained`), the v1 `session_transcript_*` rows.
 * "Objects" are everything under `<project_id>/<session_id>/` in the
 * `session-attachments` bucket: uploads, offloaded log texts (P2.3) and the
 * orphans a skipped capture batch leaves (P2.7b). Objects go after their rows,
 * 7 days later, because Supabase backups do not cover Storage: a restore of the
 * database inside that gap still finds its objects.
 *
 * How an end is recorded today:
 * - a session delete stamps the ISO string `project_sessions.metadata.deletedAt`
 *   (`deleteSession`; the account deletion stamps it too). Until the rows go,
 *   the session is in the trash: `restoreSession` strips the stamp, and this
 *   purge then skips it. `SESSION_DELETE_ROWS_DAYS` is therefore also the
 *   restore window (`sessionRestoreUntil`), and the done marker below ends it.
 * - an account closure (D6b: the only signal that ends a subscription) is an
 *   `account_deletion_requests` row with status `pending` or `processing`; the
 *   account is closed at its `scheduled_for` (the end of the 14-day grace in which
 *   `cancel-deletion` still works). Plan cancellation, a downgrade to free and payment
 *   failure are not closures: `credit_accounts` is never read. Normally the
 *   account-deletion worker erases the whole account at `scheduled_for` (the account
 *   row cascades to every session row, `deleteAccountExternalStores` removes the
 *   files), and `delete-immediately` erases at once. This window is the backstop for a
 *   closure that does not erase: the worker leaves a request more than 2 days past its
 *   date for a person (`MAX_OVERDUE` in `billing/repositories/account-deletion.ts`),
 *   a run that keeps failing falls into that backlog, and `ACCOUNT_DELETION_SWEEP_PAUSED`
 *   stops the worker. Such content goes here; the purge row's reason is
 *   `subscription_ended`. A closing account that still acts as a live customer (a paid
 *   tier whose payment is not cancelled, or any session created or turn started after
 *   the close) is skipped whole and counted in the tick line (`liveClosed`): it is left
 *   for a person. A cancelled request reopens the account: once a session's objects
 *   are gone, the purge deletes its `subscription_ended` marker, so a session the
 *   account reuses can be purged again. Not covered: a team account whose owner closed
 *   their personal account (the deletion request names the personal account only).
 *
 * Known limits: an archived project stamps no session `deletedAt`; a rows purge that
 * runs late (worker off, backlog) moves its objects phase past day 90 by the same delay.
 * The day-37 phase is the only delete of a deleted session's attachment folder:
 * `deleteSession` keeps it so a restore gets the files back (KRTX-1734).
 * `kortix.account_subscription_ends` is unused since D6b: a later release drops it.
 *
 * A session is never touched while it is in use:
 * - a session that is not deleted, and whose account is not closed;
 * - any session of a closed account that has a paid live plan, or that created a
 *   session or ran a turn after the close;
 * - a session whose delete stamp is gone (restored) or unreadable.
 *
 * Each purged session keeps one `session_content_purges` row: the done marker
 * (a second pass selects only sessions without one). It holds ids, a reason
 * and two timestamps, and goes with the session row. A capture that writes rows
 * for an already purged session is not purged again; only a returning customer
 * can cause one, because the session is skipped while in use.
 *
 * A tick is bounded (`batchSize` sessions per phase, oldest due first) and
 * idempotent: a DELETE of absent rows and a removal of absent objects change
 * nothing. A store failure leaves the session due; the next tick retries it.
 * Ids go to debug logs only; the info line carries counts.
 */
import {
  sessionContentPurges,
  sessionLogBlobs,
  sessionLogMessages,
  sessionLogs,
  sessionLogThreads,
  sessionTranscriptMessages,
  sessionTranscriptMirrors,
} from '@kortix/db';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { sessionAttachmentStore } from './lib/session-attachments';
import { mirrorDrained } from './session-log-capture';

/**
 * Days from a session delete to its rows purge: the restore window too. The SQL twin is
 * `kortix.session_delete_due_at` (migration `20261022130858924_mirror_sessions_without_log.sql`),
 * which the purge below and the backfill selection read.
 */
export const SESSION_DELETE_ROWS_DAYS = 30;
/** Days from an account closure to its rows purge: objects follow 7 days later, all gone by day 87 < 90. */
const ACCOUNT_CLOSED_ROWS_DAYS = 80;
const OBJECTS_AFTER_ROWS_DAYS = 7;
export const PURGE_BATCH_SIZE = 200;

const DAY_MS = 86_400_000;

/**
 * The last instant a deleted session can be restored: its rows purge is due
 * then. Null for a stamp that is not a date (the purge never takes those).
 */
export function sessionRestoreUntil(deletedAt: unknown): Date | null {
  const at = typeof deletedAt === 'string' ? Date.parse(deletedAt) : Number.NaN;
  return Number.isFinite(at) ? new Date(at + SESSION_DELETE_ROWS_DAYS * DAY_MS) : null;
}
// A raw `sql` parameter is not a Date: the driver takes a string.
const instant = (at: Date) => sql`${at.toISOString()}::timestamptz`;

type Store = Pick<ReturnType<typeof sessionAttachmentStore>, 'removeSession'>;
type DueSession = { session_id: string; project_id: string; account_id: string; reason: string };
/** `liveClosed`: closing accounts past their window that still act live, left for a person. */
export type PurgeResult = { sessions: number; objects: number; failed: number; liveClosed: number };

/**
 * The closing accounts and their close date: an open request (`pending` or `processing`;
 * a legacy row with `is_cancelled` set is a cancel), the earliest `scheduled_for` wins.
 * `completed` needs nothing: the account row is gone. `cancelled` reopens the account.
 * A request row outlives its account (no foreign key): only accounts that exist count.
 */
const CLOSING = sql`
  select r.account_id, min(r.scheduled_for) as closed_at
  from kortix.account_deletion_requests r
  join kortix.accounts a on a.account_id = r.account_id
  where r.status in ('pending', 'processing') and not coalesce(r.is_cancelled, false)
  group by r.account_id`;

/**
 * A closing account that still acts as a live customer: a paid tier whose payment is
 * not cancelled, or any session created, or any turn started, after the close. The
 * backstop leaves it for a person, like the account-deletion worker does.
 */
const LIVE = (k: string) => sql.raw(`(
  exists (select 1 from kortix.credit_accounts c
    where c.account_id = ${k}.account_id and coalesce(c.tier, 'free') <> 'free'
      and coalesce(c.payment_status, '') not in ('canceled', 'cancelled', 'deleted'))
  or exists (select 1 from kortix.project_sessions s2
    where s2.account_id = ${k}.account_id and (s2.created_at > ${k}.closed_at
      or exists (select 1 from kortix.session_turns t where t.session_id = s2.session_id and t.started_at > ${k}.closed_at))))`);

/**
 * Forget the `subscription_ended` markers of an account that is open again (its closure
 * was cancelled), once that session's objects are gone too: a cancel between the two
 * phases must not leave a half-erased session. A session the account reuses can then be
 * purged again, and objects written after a marker are not left behind forever. A
 * completed closure has no markers left: the account row cascades to them.
 */
// ponytail: scans session_content_purges for the reason each tick (no index on reason).
// The table holds one row per purged session; index (reason, account_id) when a tick measures slow.
async function forgetReopenedAccounts(): Promise<void> {
  await db.execute(sql`
    delete from kortix.session_content_purges p
    where p.reason = 'subscription_ended' and p.objects_purged_at is not null
      and not exists (select 1 from (${CLOSING}) k where k.account_id = p.account_id)`);
}

/** Closing accounts whose window is due but that still act live: left for a person. */
async function liveClosedAccounts(now: Date): Promise<number> {
  const [row] = await db.execute(sql`
    select count(*)::int as n from (${CLOSING}) k
    where k.closed_at + make_interval(days => ${ACCOUNT_CLOSED_ROWS_DAYS}) <= ${instant(now)} and ${LIVE('k')}`);
  return Number((row as { n: number }).n);
}

// ponytail: reads project_sessions whole each tick (no index on metadata.deletedAt). One
// hourly scan is cheap at today's size; index the stamp when a tick measures slow.
/** The sessions whose rows are due, oldest due first. */
async function dueSessions(now: Date, limit: number): Promise<DueSession[]> {
  const rows = await db.execute(sql`
    with closed as (select k.* from (${CLOSING}) k where not ${LIVE('k')})
    select s.session_id, s.project_id::text as project_id, s.account_id::text as account_id, x.reason
    from kortix.project_sessions s
    left join closed e on e.account_id = s.account_id
    -- Null for a session that is not deleted, or whose stamp is not the ISO instant
    -- deleteSession writes: one unreadable stamp cannot fail the query for every other session.
    cross join lateral (select
      kortix.session_delete_due_at(s.metadata) as deleted_due,
      e.closed_at + make_interval(days => ${ACCOUNT_CLOSED_ROWS_DAYS}) as closed_due) w
    cross join lateral (select
      least(w.deleted_due, w.closed_due) as due_at,
      case when w.deleted_due is not null and (w.closed_due is null or w.deleted_due <= w.closed_due)
        then 'session_deleted' else 'subscription_ended' end as reason) x
    where x.due_at <= ${instant(now)}
      and not exists (select 1 from kortix.session_content_purges p where p.session_id = s.session_id)
    order by x.due_at, s.session_id
    limit ${limit}`);
  return rows as unknown as DueSession[];
}

/**
 * Every row of one session in both stores, then its done marker, in one transaction. `drained`:
 * the v1 mirror is drained (`mirrorDrained`), so its tables are not touched; the Release B2
 * migration drops them with every row left in them.
 */
async function purgeRows(row: DueSession, now: Date, drained: boolean): Promise<void> {
  const id = row.session_id;
  await db.transaction(async (tx) => {
    await tx.delete(sessionLogMessages).where(eq(sessionLogMessages.sessionId, id));
    await tx.delete(sessionLogThreads).where(eq(sessionLogThreads.sessionId, id));
    await tx.delete(sessionLogBlobs).where(eq(sessionLogBlobs.sessionId, id));
    await tx.delete(sessionLogs).where(eq(sessionLogs.sessionId, id));
    if (!drained) {
      await tx.delete(sessionTranscriptMessages).where(eq(sessionTranscriptMessages.sessionId, id));
      await tx.delete(sessionTranscriptMirrors).where(eq(sessionTranscriptMirrors.sessionId, id));
    }
    await tx
      .insert(sessionContentPurges)
      .values({ sessionId: id, projectId: row.project_id, accountId: row.account_id, reason: row.reason, rowsPurgedAt: now })
      .onConflictDoNothing();
  });
}

export async function purgeSessionContent(
  options: { now?: Date; batchSize?: number; store?: Store } = {},
): Promise<PurgeResult> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? PURGE_BATCH_SIZE;
  const result: PurgeResult = { sessions: 0, objects: 0, failed: 0, liveClosed: 0 };

  await forgetReopenedAccounts();
  result.liveClosed = await liveClosedAccounts(now);
  const drained = await mirrorDrained();
  for (const row of await dueSessions(now, batchSize)) {
    try {
      await purgeRows(row, now, drained);
      result.sessions += 1;
      logger.debug('[session-purge] rows purged', { sessionId: row.session_id, reason: row.reason });
    } catch (error) {
      // The transaction rolled back: the session stays due and the other sessions go on.
      result.failed += 1;
      logger.debug('[session-purge] rows purge failed', {
        sessionId: row.session_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const objectsDueBefore = new Date(now.getTime() - OBJECTS_AFTER_ROWS_DAYS * DAY_MS);
  const dueObjects = await db
    .select({ sessionId: sessionContentPurges.sessionId, projectId: sessionContentPurges.projectId })
    .from(sessionContentPurges)
    .where(and(isNull(sessionContentPurges.objectsPurgedAt), lte(sessionContentPurges.rowsPurgedAt, objectsDueBefore)))
    .orderBy(sessionContentPurges.rowsPurgedAt)
    .limit(batchSize);
  const store = options.store ?? sessionAttachmentStore();
  for (const { sessionId, projectId } of dueObjects) {
    try {
      await store.removeSession(projectId, sessionId);
      await db.update(sessionContentPurges).set({ objectsPurgedAt: now }).where(eq(sessionContentPurges.sessionId, sessionId));
      result.objects += 1;
    } catch (error) {
      result.failed += 1;
      logger.debug('[session-purge] object removal failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (result.sessions + result.objects + result.failed + result.liveClosed > 0) logger.info('[session-purge] tick', result);
  return result;
}
