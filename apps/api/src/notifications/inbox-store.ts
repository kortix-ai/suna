// Writes to the notification inbox (`kortix.notifications`, KRTX-1742).
// One row per recipient per event. A `dedupe_key` makes a write idempotent per
// recipient: a second insert with the same key writes nothing.
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { notifications, type Database } from '@kortix/db';
import type { NotificationKindName } from '@kortix/shared/notification-kinds';
import { db as defaultDb } from '../shared/db';

export const INBOX_TITLE_MAX_CHARS = 200;
export const INBOX_BODY_MAX_CHARS = 300;

export interface InboxRowInput {
  userId: string;
  accountId: string;
  projectId?: string | null;
  sessionId?: string | null;
  triggerSlug?: string | null;
  kind: NotificationKindName;
  title: string;
  body?: string;
  actorUserId?: string | null;
  dedupeKey?: string | null;
  /** Set only when this kind gets a digest email for this user. */
  emailDueAt?: Date | null;
}

/** Collapse whitespace and cut to `max` characters (code points). */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  if (chars.length <= max) return flat;
  return `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

export interface InboxStore {
  /** The new row's id, or null when the recipient already has a row with this dedupe key. */
  insert(row: InboxRowInput): Promise<string | null>;
  /** Mark rows read for their owner only. Returns the number of rows changed. */
  markRead(userId: string, ids: readonly string[]): Promise<number>;
  /** Stamp `emailed_at` on rows (the immediate email was attempted). */
  markEmailed(ids: readonly string[]): Promise<void>;
}

export function createInboxStore(database: Database = defaultDb): InboxStore {
  return {
    async insert(row) {
      const [inserted] = await database
        .insert(notifications)
        .values({
          userId: row.userId,
          accountId: row.accountId,
          projectId: row.projectId ?? null,
          sessionId: row.sessionId ?? null,
          triggerSlug: row.triggerSlug ?? null,
          kind: row.kind,
          title: clip(row.title, INBOX_TITLE_MAX_CHARS) || 'Kortix',
          body: clip(row.body ?? '', INBOX_BODY_MAX_CHARS),
          actorUserId: row.actorUserId ?? null,
          dedupeKey: row.dedupeKey ?? null,
          emailDueAt: row.emailDueAt ?? null,
        })
        .onConflictDoNothing({ target: [notifications.userId, notifications.dedupeKey] })
        .returning({ id: notifications.notificationId });
      return inserted?.id ?? null;
    },

    async markRead(userId, ids) {
      if (ids.length === 0) return 0;
      const updated = await database
        .update(notifications)
        .set({ readAt: sql`now()` })
        .where(and(eq(notifications.userId, userId), inArray(notifications.notificationId, [...ids]), isNull(notifications.readAt)))
        .returning({ id: notifications.notificationId });
      return updated.length;
    },

    async markEmailed(ids) {
      if (ids.length === 0) return;
      await database
        .update(notifications)
        .set({ emailedAt: sql`now()` })
        .where(inArray(notifications.notificationId, [...ids]));
    },
  };
}

let defaultStore: InboxStore | null = null;

export function inboxStore(): InboxStore {
  defaultStore ??= createInboxStore();
  return defaultStore;
}
