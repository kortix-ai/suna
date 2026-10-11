import { connectorConnections, projectTriggerEventSubscriptions as subs } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db';

export type EventSubscriptionRow = typeof subs.$inferSelect;
export type EventSubscriptionStatus = 'active' | 'needs_connection' | 'error';
export type EventSubscriptionInput = Omit<
  typeof subs.$inferInsert,
  'createdAt' | 'updatedAt' | 'lastEventAt'
>;

const byKey = (projectId: string, slug: string) =>
  and(eq(subs.projectId, projectId), eq(subs.slug, slug));
const byExternal = (provider: string, externalId: string) =>
  and(eq(subs.provider, provider), eq(subs.externalId, externalId));

export async function listByProject(projectId: string): Promise<EventSubscriptionRow[]> {
  return db.select().from(subs).where(eq(subs.projectId, projectId));
}

export async function get(projectId: string, slug: string): Promise<EventSubscriptionRow | null> {
  const [row] = await db.select().from(subs).where(byKey(projectId, slug)).limit(1);
  return row ?? null;
}

export async function upsert(row: EventSubscriptionInput): Promise<void> {
  const { projectId: _p, slug: _s, ...fields } = row;
  await db
    .insert(subs)
    .values(row)
    .onConflictDoUpdate({
      target: [subs.projectId, subs.slug],
      set: { ...fields, updatedAt: new Date() },
    });
}

export async function markStatus(
  projectId: string,
  slug: string,
  status: EventSubscriptionStatus,
  error: string | null,
): Promise<void> {
  await db
    .update(subs)
    .set({ status, lastError: error, updatedAt: new Date() })
    .where(byKey(projectId, slug));
}

export async function deleteRow(projectId: string, slug: string): Promise<void> {
  await db.delete(subs).where(byKey(projectId, slug));
}

export async function rowsByExternalId(
  provider: string,
  externalId: string,
): Promise<EventSubscriptionRow[]> {
  return db.select().from(subs).where(byExternal(provider, externalId));
}

/** Rows sharing one provider instance: the provider id is unsubscribed only at zero. */
export async function countByExternalId(provider: string, externalId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(subs)
    .where(byExternal(provider, externalId));
  return row?.n ?? 0;
}

export async function markErrorByExternalId(
  provider: string,
  externalId: string,
  error: string,
): Promise<void> {
  await db
    .update(subs)
    .set({ status: 'error', lastError: error, updatedAt: new Date() })
    .where(byExternal(provider, externalId));
}

export async function markErrorByConnectedAccount(
  provider: string,
  connectedAccountId: string,
  error: string,
): Promise<void> {
  await db
    .update(subs)
    .set({ status: 'error', lastError: error, updatedAt: new Date() })
    .where(
      and(
        eq(subs.provider, provider),
        sql`${subs.connectionId} in (
          select ${connectorConnections.connectionId} from ${connectorConnections}
          where ${connectorConnections.metadata} ->> 'connected_account_id' = ${connectedAccountId}
        )`,
      ),
    );
}

export async function touchLastEvent(projectId: string, slug: string): Promise<void> {
  await db.update(subs).set({ lastEventAt: new Date() }).where(byKey(projectId, slug));
}

/**
 * Runs `fn` while holding a per-project transaction-scoped advisory lock.
 * Returns false (and skips `fn`) when another replica holds it; the next
 * reconcile converges. Transaction-scoped, not session-scoped: the prod
 * pooler does not pin a backend across statements (see shared/leader-election.ts).
 */
export async function withProjectEventLock(
  projectId: string,
  fn: () => Promise<void>,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const res = await tx.execute(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${`trigger-events:${projectId}`}, 0)) as ok`,
    );
    const ok = (res as unknown as Array<{ ok: boolean }>)[0]?.ok === true;
    if (ok) await fn();
    return ok;
  });
}
