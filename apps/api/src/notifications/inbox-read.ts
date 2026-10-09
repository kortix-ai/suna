// Reading the notification inbox (KRTX-1742): the bell's page, its unread
// count, and marking rows read. One read rule serves the bell, the mobile
// inbox and the email digest (`filterVisibleNotificationRows`): a row shows
// only while its reader may still open what it names. A revoked share, a lost
// project role, a removed member, a deleted session or an MFA step-up the
// sign-in has not passed hides the row; it is never deleted here.
import { and, desc, eq, inArray, isNull, lt, type SQL, sql } from 'drizzle-orm';
import { accounts, notifications, projects } from '@kortix/db';
import type { NotificationKindName } from '@kortix/shared/notification-kinds';
import { mfaGateBlocks } from '../iam/authorize';
import { db } from '../shared/db';
import { loadSessionAccessRows, mayReadProjectTriggers, maySeeSessions, type SessionAccessRow } from './access';
import { inboxStore } from './inbox-store';
import { notificationUrl } from './push-payload';

/** The unread count covers at most this many newest unread rows; clients show 99+. */
export const INBOX_UNREAD_SCAN = 100;

/** One page reads at most this many batches of `limit` stored rows to fill itself with visible ones. */
export const INBOX_PAGE_SCAN_BATCHES = 5;

export interface InboxRowForFilter {
  notificationId: string;
  userId: string;
  accountId: string;
  projectId: string | null;
  sessionId: string | null;
  triggerSlug: string | null;
  kind: string;
}

export interface InboxReadContext {
  /** The caller's IAM token id; null for a browser sign-in. */
  iamTokenId?: string | null;
  /** The caller's assurance level; undefined in background jobs (digest). */
  mfaAal?: string | null;
  /** Background jobs (digest) skip the MFA step-up: an email is not a sign-in. */
  skipMfaGate?: boolean;
}

/** One inbox row as `GET /v1/notifications` returns it. */
export interface InboxNotification {
  id: string;
  kind: NotificationKindName;
  title: string;
  body: string;
  project_id: string | null;
  project_name: string | null;
  session_id: string | null;
  trigger_slug: string | null;
  actor_user_id: string | null;
  url: string;
  read: boolean;
  created_at: string;
}

export interface InboxPage {
  notifications: InboxNotification[];
  unread_count: number;
  /** Pass as `before` for the next page; null on the last page. */
  next_before: string | null;
}

export type InboxReadTarget = { ids: readonly string[] } | { all: true } | { sessionId: string };

const ROW = {
  notificationId: notifications.notificationId,
  userId: notifications.userId,
  accountId: notifications.accountId,
  projectId: notifications.projectId,
  sessionId: notifications.sessionId,
  triggerSlug: notifications.triggerSlug,
  kind: notifications.kind,
  title: notifications.title,
  body: notifications.body,
  actorUserId: notifications.actorUserId,
  readAt: notifications.readAt,
  createdAt: notifications.createdAt,
};
type StoredRow = Pick<typeof notifications.$inferSelect, keyof typeof ROW>;

/** Accounts whose MFA step-up this sign-in has not passed. */
async function mfaBlockedAccounts(accountIds: string[], ctx: InboxReadContext): Promise<Set<string>> {
  if (ctx.skipMfaGate || accountIds.length === 0) return new Set();
  const rows = await db
    .select({ accountId: accounts.accountId, mfaRequired: accounts.mfaRequired })
    .from(accounts)
    .where(inArray(accounts.accountId, accountIds));
  return new Set(
    rows
      .filter((row) => mfaGateBlocks({ accountMfaRequired: row.mfaRequired }, ctx.iamTokenId, ctx.mfaAal ?? undefined))
      .map((row) => row.accountId),
  );
}

/**
 * The rows `userId` may see, plus the session rows the check loaded (their
 * live titles). A row without a session is an automation row: its project's
 * triggers must be readable.
 */
async function visible<T extends InboxRowForFilter>(
  userId: string,
  rows: readonly T[],
  ctx: InboxReadContext,
): Promise<{ rows: T[]; sessions: Map<string, SessionAccessRow> }> {
  const sessions = new Map<string, SessionAccessRow>();
  if (!userId || rows.length === 0) return { rows: [], sessions };
  const blocked = await mfaBlockedAccounts([...new Set(rows.map((row) => row.accountId))], ctx);
  const open = rows.filter((row) => !blocked.has(row.accountId));

  const loaded = await loadSessionAccessRows(open.flatMap((row) => (row.sessionId ? [row.sessionId] : [])));
  const seen = await maySeeSessions(userId, [...loaded.values()]);
  for (const id of seen) sessions.set(id, loaded.get(id)!);

  const triggerProjects = new Map<string, Set<string>>();
  for (const row of open) {
    if (row.sessionId || !row.projectId) continue;
    const ids = triggerProjects.get(row.accountId) ?? new Set<string>();
    ids.add(row.projectId);
    triggerProjects.set(row.accountId, ids);
  }
  const readable = new Set<string>();
  await Promise.all([...triggerProjects].map(async ([accountId, ids]) => {
    for (const projectId of await mayReadProjectTriggers(userId, accountId, [...ids])) readable.add(`${accountId}:${projectId}`);
  }));

  const kept = open.filter((row) =>
    row.sessionId ? seen.has(row.sessionId) : row.projectId !== null && readable.has(`${row.accountId}:${row.projectId}`),
  );
  return { rows: kept, sessions };
}

/**
 * The rows `userId` may still see: the account's MFA step-up (unless skipped),
 * session rows through `maySeeSessions`, trigger rows through
 * `mayReadProjectTriggers`. Order preserved.
 */
export async function filterVisibleNotificationRows<T extends InboxRowForFilter>(
  userId: string,
  rows: readonly T[],
  ctx: InboxReadContext = {},
): Promise<T[]> {
  return (await visible(userId, rows, ctx)).rows;
}

function newestUnread(userId: string): Promise<StoredRow[]> {
  return db
    .select(ROW)
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .orderBy(desc(notifications.notificationId))
    .limit(INBOX_UNREAD_SCAN);
}

/** Visible unread rows among the newest {@link INBOX_UNREAD_SCAN} unread ones. */
export async function unreadCount(userId: string, ctx: InboxReadContext = {}): Promise<number> {
  return (await visible(userId, await newestUnread(userId), ctx)).rows.length;
}

/** `metadata.custom_name ?? metadata.name`: the title the session shows now. */
function liveTitle(session: SessionAccessRow | undefined): string | null {
  const meta = (session?.metadata ?? {}) as Record<string, unknown>;
  const title = [meta.custom_name, meta.name].find((value): value is string => typeof value === 'string' && value.trim() !== '');
  return title?.trim() ?? null;
}

async function projectNames(projectIds: string[]): Promise<Map<string, string>> {
  if (projectIds.length === 0) return new Map();
  const rows = await db
    .select({ projectId: projects.projectId, name: projects.name })
    .from(projects)
    .where(inArray(projects.projectId, projectIds));
  return new Map(rows.map((row) => [row.projectId, row.name]));
}

/**
 * One page, newest first. `before` is a notification id (uuid_v7, so id order
 * is time order). Hidden rows are left out: the page reads older batches until
 * it holds `limit` visible rows, up to {@link INBOX_PAGE_SCAN_BATCHES}
 * batches, so a page can still hold fewer than `limit` rows while
 * `next_before` points further back. `next_before` is the last row read.
 */
export async function listInbox(
  userId: string,
  opts: { limit: number; before?: string | null },
  ctx: InboxReadContext = {},
): Promise<InboxPage> {
  const listed: StoredRow[] = [];
  const sessions = new Map<string, SessionAccessRow>();
  let unreadShown = 0;
  let cursor = opts.before ?? null;
  let exhausted = false;
  for (let batchNo = 0; batchNo < INBOX_PAGE_SCAN_BATCHES && listed.length < opts.limit; batchNo += 1) {
    // The first batch shares its access check with the unread rows: they
    // overlap, and each check reads IAM.
    const [batch, unread] = await Promise.all([
      db
        .select(ROW)
        .from(notifications)
        .where(and(eq(notifications.userId, userId), cursor ? lt(notifications.notificationId, cursor) : undefined))
        .orderBy(desc(notifications.notificationId))
        .limit(opts.limit),
      batchNo === 0 ? newestUnread(userId) : [],
    ]);
    const union = new Map<string, StoredRow>();
    for (const row of [...batch, ...unread]) union.set(row.notificationId, row);
    const checked = await visible(userId, [...union.values()], ctx);
    for (const [id, session] of checked.sessions) sessions.set(id, session);
    const shown = new Set(checked.rows.map((row) => row.notificationId));
    if (batchNo === 0) unreadShown = unread.filter((row) => shown.has(row.notificationId)).length;
    let readAll = true;
    for (const row of batch) {
      if (listed.length === opts.limit) {
        readAll = false;
        break;
      }
      cursor = row.notificationId;
      if (shown.has(row.notificationId)) listed.push(row);
    }
    if (readAll && batch.length < opts.limit) {
      exhausted = true;
      break;
    }
  }
  const names = await projectNames([...new Set(listed.flatMap((row) => (row.projectId ? [row.projectId] : [])))]);
  return {
    notifications: listed.map((row) => ({
      id: row.notificationId,
      // The table's CHECK constraint holds `kind` to the known kinds.
      kind: row.kind as NotificationKindName,
      title: (row.sessionId ? liveTitle(sessions.get(row.sessionId)) : null) ?? row.title,
      body: row.body,
      project_id: row.projectId,
      project_name: row.projectId ? names.get(row.projectId) ?? null : null,
      session_id: row.sessionId,
      trigger_slug: row.triggerSlug,
      actor_user_id: row.actorUserId,
      url: notificationUrl({
        notificationId: row.notificationId,
        projectId: row.projectId,
        sessionId: row.sessionId,
        triggerSlug: row.triggerSlug,
      }),
      read: row.readAt !== null,
      created_at: row.createdAt.toISOString(),
    })),
    unread_count: unreadShown,
    next_before: exhausted ? null : cursor,
  };
}

/** Mark the caller's unread rows read; `where` narrows them. Returns the count. */
async function markWhere(userId: string, where?: SQL): Promise<number> {
  const updated = await db
    .update(notifications)
    .set({ readAt: sql`now()` })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt), where))
    .returning({ id: notifications.notificationId });
  return updated.length;
}

/** The caller opened the session: its rows for them are read. */
export function markSessionNotificationsRead(userId: string, sessionId: string): Promise<number> {
  return markWhere(userId, eq(notifications.sessionId, sessionId));
}

/**
 * Mark rows read. Every variant is scoped to the caller's own rows: an id of
 * another user's row changes nothing.
 */
export async function markInboxRead(
  userId: string,
  target: InboxReadTarget,
  ctx: InboxReadContext = {},
): Promise<{ updated: number; unread_count: number }> {
  const updated =
    'ids' in target
      ? await inboxStore().markRead(userId, target.ids)
      : 'sessionId' in target
        ? await markSessionNotificationsRead(userId, target.sessionId)
        : await markWhere(userId);
  return { updated, unread_count: await unreadCount(userId, ctx) };
}
