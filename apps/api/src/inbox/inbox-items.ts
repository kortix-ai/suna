import { inboxItems } from '@kortix/db';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../shared/db';

type InboxItemRow = typeof inboxItems.$inferSelect;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export function serializeInboxItem(row: InboxItemRow) {
  return {
    id: row.id,
    project_id: row.projectId,
    session_id: row.sessionId,
    kind: row.kind,
    title: row.title,
    source: row.source,
    metadata: row.metadata ?? {},
    read: row.readAt != null,
    read_at: row.readAt ? row.readAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
  };
}

export async function listInboxForUser(
  projectId: string,
  userId: string,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<InboxItemRow[]> {
  const conds = [eq(inboxItems.projectId, projectId), eq(inboxItems.userId, userId)];
  if (opts.unreadOnly) conds.push(isNull(inboxItems.readAt));
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  return db
    .select()
    .from(inboxItems)
    .where(and(...conds))
    .orderBy(desc(inboxItems.createdAt))
    .limit(limit);
}

export async function countUnreadForUser(projectId: string, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.projectId, projectId),
        eq(inboxItems.userId, userId),
        isNull(inboxItems.readAt),
      ),
    );
  return row?.n ?? 0;
}

export async function markInboxRead(
  projectId: string,
  userId: string,
  selection: { itemIds?: string[]; sessionId?: string; all?: boolean },
): Promise<number> {
  const conds = [
    eq(inboxItems.projectId, projectId),
    eq(inboxItems.userId, userId),
    isNull(inboxItems.readAt),
  ];
  if (selection.itemIds && selection.itemIds.length > 0) {
    conds.push(inArray(inboxItems.id, selection.itemIds));
  } else if (selection.sessionId) {
    conds.push(eq(inboxItems.sessionId, selection.sessionId));
  } else if (!selection.all) {
    return 0;
  }
  const updated = await db
    .update(inboxItems)
    .set({ readAt: new Date() })
    .where(and(...conds))
    .returning({ id: inboxItems.id });
  return updated.length;
}
