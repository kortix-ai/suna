/**
 * Retention purge (P2.8, decision D6). The legal page promises that customer
 * content is "deleted within 90 days after it ends", files included. Two things
 * end content, each with its own windows:
 *
 * | what ended                | rows go          | objects go (rows + 7 days) | all gone |
 * | a session was deleted     | delete + 30 days | delete + 37 days           | day 37   |
 * | a subscription ended      | end + 80 days    | end + 87 days              | day 87   |
 *
 * "Rows" are the v2 `session_log*` rows and the v1 `session_transcript_*` rows.
 * "Objects" are everything under `<project_id>/<session_id>/` in the
 * `session-attachments` bucket: uploads, offloaded log texts (P2.3) and the
 * orphans a skipped capture batch leaves (P2.7b). Objects go after their rows,
 * 7 days later, because Supabase backups do not cover Storage: a restore of the
 * database inside that gap still finds its objects.
 *
 * How an end is recorded today:
 * - a session delete stamps the ISO string `project_sessions.metadata.deletedAt`
 *   (`deleteSession`; the account deletion stamps it too). Nothing un-deletes.
 * - a subscription end is `credit_accounts.stripe_subscription_status` in
 *   `canceled | unpaid | incomplete_expired` (webhooks `revertToFree`). That table
 *   keeps no date, so each tick records the first sight of a dead status in
 *   `account_subscription_ends` and deletes the record when the status is live again.
 *   Accounts that cancelled before this shipped start their 80 days at the first tick.
 *
 * A session is never touched while it is in use:
 * - a session that is not deleted, and whose account has no dead subscription;
 * - a session of an ended account that was created, or ran a turn, after the end;
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
import { DEAD_SUBSCRIPTION_STATUSES } from '../billing/services/billing-state';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { sessionAttachmentStore } from './lib/session-attachments';

export const SESSION_DELETE_ROWS_DAYS = 30;
export const SUBSCRIPTION_END_ROWS_DAYS = 80;
export const OBJECTS_AFTER_ROWS_DAYS = 7;
export const PURGE_BATCH_SIZE = 200;

const DAY_MS = 86_400_000;
const deadStatuses = sql.join(
  [...DEAD_SUBSCRIPTION_STATUSES].map((status) => sql`${status}`),
  sql`, `,
);
// What `deleteSession` and the account deletion write: an ISO instant. Anything else is skipped,
// so one unreadable stamp cannot fail the query for every other session.
const ISO_INSTANT =
  '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]+)?Z$';

// A raw `sql` parameter is not a Date: the driver takes a string.
const instant = (at: Date) => sql`${at.toISOString()}::timestamptz`;

type Store = Pick<ReturnType<typeof sessionAttachmentStore>, 'removeSession'>;
type DueSession = { session_id: string; project_id: string; account_id: string; reason: string };
export type PurgeResult = { sessions: number; objects: number; failed: number };

/** Record each newly dead subscription once, and forget each one that is live again. */
async function syncSubscriptionEnds(now: Date): Promise<void> {
  await db.execute(sql`
    insert into kortix.account_subscription_ends (account_id, ended_at)
    select c.account_id, ${instant(now)}
    from kortix.credit_accounts c
    where c.stripe_subscription_status in (${deadStatuses})
      and exists (select 1 from kortix.accounts a where a.account_id = c.account_id)
    on conflict (account_id) do nothing`);
  await db.execute(sql`
    delete from kortix.account_subscription_ends e
    using kortix.credit_accounts c
    where c.account_id = e.account_id
      and coalesce(c.stripe_subscription_status, '') not in (${deadStatuses})`);
}

// ponytail: reads project_sessions whole each tick (no index on metadata.deletedAt). One
// hourly scan is cheap at today's size; index the stamp when a tick measures slow.
/** The sessions whose rows are due, oldest due first. */
async function dueSessions(now: Date, limit: number): Promise<DueSession[]> {
  const rows = await db.execute(sql`
    select s.session_id, s.project_id::text as project_id, s.account_id::text as account_id, x.reason
    from kortix.project_sessions s
    left join kortix.account_subscription_ends e on e.account_id = s.account_id
    cross join lateral (select
      case when jsonb_typeof(s.metadata -> 'deletedAt') = 'string' and s.metadata ->> 'deletedAt' ~ ${ISO_INSTANT}
        then (s.metadata ->> 'deletedAt')::timestamptz + make_interval(days => ${SESSION_DELETE_ROWS_DAYS}) end as deleted_due,
      case when e.account_id is not null
        and s.created_at <= e.ended_at
        and not exists (select 1 from kortix.session_turns t where t.session_id = s.session_id and t.started_at > e.ended_at)
        then e.ended_at + make_interval(days => ${SUBSCRIPTION_END_ROWS_DAYS}) end as ended_due) w
    cross join lateral (select
      least(w.deleted_due, w.ended_due) as due_at,
      case when w.deleted_due is not null and (w.ended_due is null or w.deleted_due <= w.ended_due)
        then 'session_deleted' else 'subscription_ended' end as reason) x
    where x.due_at <= ${instant(now)}
      and not exists (select 1 from kortix.session_content_purges p where p.session_id = s.session_id)
    order by x.due_at, s.session_id
    limit ${limit}`);
  return rows as unknown as DueSession[];
}

/** Every row of one session in both stores, then its done marker, in one transaction. */
async function purgeRows(row: DueSession, now: Date): Promise<void> {
  const id = row.session_id;
  await db.transaction(async (tx) => {
    await tx.delete(sessionLogMessages).where(eq(sessionLogMessages.sessionId, id));
    await tx.delete(sessionLogThreads).where(eq(sessionLogThreads.sessionId, id));
    await tx.delete(sessionLogBlobs).where(eq(sessionLogBlobs.sessionId, id));
    await tx.delete(sessionLogs).where(eq(sessionLogs.sessionId, id));
    await tx.delete(sessionTranscriptMessages).where(eq(sessionTranscriptMessages.sessionId, id));
    await tx.delete(sessionTranscriptMirrors).where(eq(sessionTranscriptMirrors.sessionId, id));
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
  const result: PurgeResult = { sessions: 0, objects: 0, failed: 0 };

  await syncSubscriptionEnds(now);
  for (const row of await dueSessions(now, batchSize)) {
    await purgeRows(row, now);
    result.sessions += 1;
    logger.debug('[session-purge] rows purged', { sessionId: row.session_id, reason: row.reason });
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

  if (result.sessions + result.objects + result.failed > 0) logger.info('[session-purge] tick', result);
  return result;
}
