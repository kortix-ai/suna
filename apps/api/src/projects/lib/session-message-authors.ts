import { sessionLifecycleCommands, accountMemberships } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { resolveUserIdentities } from './access';

/** One scoped read of the authenticated prompt ledger. Never infer an author from the session owner. */
export async function sessionMessageAuthors(sessionId: string, accountId: string): Promise<Record<string, string>> {
  const rows = await db.select({
    userId: sessionLifecycleCommands.actorUserId,
    payload: sessionLifecycleCommands.payload,
    result: sessionLifecycleCommands.result,
  }).from(sessionLifecycleCommands).innerJoin(accountMemberships, and(
    eq(accountMemberships.userId, sessionLifecycleCommands.actorUserId),
    eq(accountMemberships.accountId, accountId),
  )).where(and(
    eq(sessionLifecycleCommands.sessionId, sessionId),
    eq(sessionLifecycleCommands.commandType, 'continue_session'),
    sql`${sessionLifecycleCommands.source} IN ('ui', 'slack')`,
    sql`${sessionLifecycleCommands.payload}->>'wireMessageId' IS NOT NULL`,
  ));
  const identities = await resolveUserIdentities(rows.map((row) => row.userId).filter((id): id is string => !!id));
  const authors: Record<string, string> = {};
  for (const row of rows) {
    const identity = row.userId ? identities.get(row.userId) : null;
    const name = identity?.exists && identity.displayName?.trim();
    if (!name) continue;
    const payload = row.payload as Record<string, unknown>;
    const result = row.result as Record<string, unknown>;
    for (const id of [payload.wireMessageId, payload.redeliveredMessageId, result.forwarded_message_id,
      ...(Array.isArray(payload.redeliveredMessageIds) ? payload.redeliveredMessageIds : [])]) {
      if (typeof id === 'string' && id) authors[id] = name;
    }
  }
  return authors;
}
