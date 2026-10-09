// The notification worker's jobs (KRTX-1742):
//
// Digest. A row gets `email_due_at` at insert (15 min out) only when its kind
// is emailed in a digest for that user. Each tick, per user with due unread
// rows and no digest in the last 60 min: claim ALL their due rows in one
// UPDATE (the claim stamps `emailed_at`, so no row is ever scanned again),
// drop rows the user may no longer see and questions already answered, and
// send ONE email listing 10 plus "and N more". Dropped rows stay stamped.
//
// Retention. Rows older than 90 days are deleted, 1,000 per statement.
import { and, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { notifications, sessionPendingQuestions } from '@kortix/db';
import { IMMEDIATE_EMAIL_KINDS, NEVER_DIGESTED_KINDS, isNotificationKind } from '@kortix/shared/notification-kinds';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { qualifiedColumn } from '../shared/sql-qualified-column';
import { isNotificationEmailAvailable, sendNotificationDigestEmail, type NotificationEmailOutcome } from './email-delivery';
import { filterVisibleNotificationRows, type InboxRowForFilter } from './inbox-read';
import type { NotificationEmailItem } from './notification-email';
import { notificationUrl } from './push-payload';

export const DIGEST_COOLDOWN_MINUTES = 60;
export const DIGEST_LISTED_ROWS = 10;
// ponytail: 50 users per 60 s tick bounds one tick's sends; a larger backlog
// drains over the next ticks. Raise it, or send concurrently, if digests lag.
export const DIGEST_USERS_PER_TICK = 50;
export const RETENTION_DAYS = 90;
export const RETENTION_BATCH = 1_000;
const RETENTION_BATCHES_PER_TICK = 10;

export interface DigestRow extends InboxRowForFilter {
  title: string;
  body: string;
  createdAt: Date;
}

export interface DigestDeps {
  emailAvailable(): boolean;
  /** The rows `userId` may still see (the inbox read rule, no MFA step-up: an email is not a sign-in). */
  filterVisible(userId: string, rows: DigestRow[]): Promise<DigestRow[]>;
  sendDigest(input: { userId: string; items: NotificationEmailItem[]; more: number }): Promise<NotificationEmailOutcome>;
}

export interface DigestTickResult {
  users: number;
  sent: number;
  claimed: number;
  dropped: number;
}

const liveDigestDeps: DigestDeps = {
  emailAvailable: isNotificationEmailAvailable,
  filterVisible: (userId, rows) => filterVisibleNotificationRows(userId, rows, { skipMfaGate: true }),
  sendDigest: sendNotificationDigestEmail,
};

const due = () => and(
  lte(notifications.emailDueAt, sql`now()`),
  isNull(notifications.emailedAt),
  isNull(notifications.readAt),
);

/** Users with due unread rows whose last digest is older than the cooldown. */
async function usersWithDueRows(): Promise<string[]> {
  const outerUser = qualifiedColumn(notifications.userId);
  const rows = await db
    .selectDistinct({ userId: notifications.userId })
    .from(notifications)
    .where(and(
      due(),
      // ponytail: a claim whose rows were all dropped also starts the cooldown
      // (dropped rows are stamped). Costs at most one 60 min delay, never a
      // duplicate; a digest log table would make it exact.
      sql`NOT EXISTS (
        SELECT 1 FROM kortix.notifications d
        WHERE d.user_id = ${outerUser}
          AND d.email_due_at IS NOT NULL
          AND d.emailed_at > now() - make_interval(mins => ${DIGEST_COOLDOWN_MINUTES}))`,
    ))
    .limit(DIGEST_USERS_PER_TICK);
  return rows.map((row) => row.userId);
}

async function claimDueRows(userId: string): Promise<DigestRow[]> {
  return db
    .update(notifications)
    .set({ emailedAt: sql`now()` })
    .where(and(eq(notifications.userId, userId), due()))
    .returning({
      notificationId: notifications.notificationId,
      userId: notifications.userId,
      accountId: notifications.accountId,
      projectId: notifications.projectId,
      sessionId: notifications.sessionId,
      triggerSlug: notifications.triggerSlug,
      kind: notifications.kind,
      title: notifications.title,
      body: notifications.body,
      createdAt: notifications.createdAt,
    });
}

/** Sessions whose question was answered (or cleared) and that ask nothing now. */
async function answeredQuestionSessions(rows: readonly DigestRow[]): Promise<Set<string>> {
  const sessionIds = [...new Set(rows.filter((r) => r.kind === 'question' && r.sessionId).map((r) => r.sessionId!))];
  if (sessionIds.length === 0) return new Set();
  const states = await db
    .select({
      sessionId: sessionPendingQuestions.sessionId,
      open: sql<boolean>`bool_or(${sessionPendingQuestions.answeredAt} IS NULL)`,
    })
    .from(sessionPendingQuestions)
    .where(inArray(sessionPendingQuestions.sessionId, sessionIds))
    .groupBy(sessionPendingQuestions.sessionId);
  return new Set(states.filter((s) => !s.open).map((s) => s.sessionId));
}

/** Permission asks go stale before a digest; automation kinds are emailed at once. */
function isDigestKind(kind: string): boolean {
  return isNotificationKind(kind) && !NEVER_DIGESTED_KINDS.includes(kind) && !IMMEDIATE_EMAIL_KINDS.includes(kind);
}

async function digestFor(userId: string, deps: DigestDeps, result: DigestTickResult): Promise<void> {
  const claimed = await claimDueRows(userId);
  result.claimed += claimed.length;
  if (claimed.length === 0) return;
  const answered = await answeredQuestionSessions(claimed);
  const visible = await deps.filterVisible(userId, claimed);
  const listed = visible
    .filter((row) => isDigestKind(row.kind) && !(row.kind === 'question' && row.sessionId && answered.has(row.sessionId)))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  result.dropped += claimed.length - listed.length;
  if (listed.length === 0) return;
  const items = listed.slice(0, DIGEST_LISTED_ROWS).map((row) => ({
    kind: row.kind as NotificationEmailItem['kind'],
    title: row.title,
    body: row.body,
    url: notificationUrl(row),
  }));
  const outcome = await deps.sendDigest({ userId, items, more: listed.length - items.length });
  if (outcome === 'sent') result.sent += 1;
}

/** One digest pass. A no-op when the deployment cannot send email. Never throws per user. */
export async function runNotificationDigestTick(overrides: Partial<DigestDeps> = {}): Promise<DigestTickResult> {
  const deps = { ...liveDigestDeps, ...overrides };
  const result: DigestTickResult = { users: 0, sent: 0, claimed: 0, dropped: 0 };
  if (!deps.emailAvailable()) return result;
  // A row read before its digest was due will never be emailed: take it out of
  // the due index so the scan above stays small.
  await db
    .update(notifications)
    .set({ emailDueAt: null })
    .where(and(lte(notifications.emailDueAt, sql`now()`), isNull(notifications.emailedAt), isNotNull(notifications.readAt)));
  const users = await usersWithDueRows();
  result.users = users.length;
  for (const userId of users) {
    try {
      await digestFor(userId, deps, result);
    } catch (error) {
      logger.warn('[notify] digest failed', { userId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

/** Delete inbox rows older than 90 days, at most 10,000 per call. Returns the deleted count. */
export async function sweepExpiredNotifications(): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < RETENTION_BATCHES_PER_TICK; batch += 1) {
    const expired = db
      .select({ id: notifications.notificationId })
      .from(notifications)
      .where(sql`${notifications.createdAt} < now() - make_interval(days => ${RETENTION_DAYS})`)
      .limit(RETENTION_BATCH);
    const deleted = await db
      .delete(notifications)
      .where(inArray(notifications.notificationId, expired))
      .returning({ id: notifications.notificationId });
    total += deleted.length;
    if (deleted.length < RETENTION_BATCH) break;
  }
  return total;
}
