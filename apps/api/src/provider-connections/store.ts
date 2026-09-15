import { projectUserProviderConnections as bindings, userProviderConnections as connections } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { seal, unseal } from './crypto';
import { providerConnectionAdapter } from './adapters';

export function connectionView(row: typeof connections.$inferSelect) {
  return { connection_id: row.connectionId, provider_id: row.providerId, auth_type: row.authType,
    created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString() };
}

export async function listUserProviderConnections(userId: string) {
  return (await db.select().from(connections).where(eq(connections.userId, userId))).map(connectionView);
}

export async function saveUserProviderConnection(userId: string, providerId: string, value: string) {
  const adapter = providerConnectionAdapter(providerId);
  if (!adapter) throw new Error('Unsupported provider');
  const valueEnc = seal(userId, providerId, 'credential', value);
  const [row] = await db.insert(connections).values({ userId, providerId, authType: adapter.authType, valueEnc })
    .onConflictDoUpdate({ target: [connections.userId, connections.providerId],
      set: { valueEnc, updatedAt: new Date() } }).returning();
  return connectionView(row!);
}

export async function deleteUserProviderConnection(userId: string, providerId: string) {
  await db.delete(connections).where(and(eq(connections.userId, userId), eq(connections.providerId, providerId)));
}

export async function listProjectUserProviderConnections(projectId: string, userId: string) {
  return db.select({ provider_id: bindings.providerId, connection_id: bindings.connectionId })
    .from(bindings).where(and(eq(bindings.projectId, projectId), eq(bindings.userId, userId)));
}

export async function bindUserProviderConnection(projectId: string, userId: string, providerId: string, enabled: boolean) {
  if (!enabled) {
    await db.delete(bindings).where(and(eq(bindings.projectId, projectId), eq(bindings.userId, userId), eq(bindings.providerId, providerId)));
    return true;
  }
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(connections)
      .where(and(eq(connections.userId, userId), eq(connections.providerId, providerId))).for('update');
    if (!row) return false;
    await tx.insert(bindings).values({ projectId, userId, providerId, connectionId: row.connectionId })
      .onConflictDoNothing();
    return true;
  });
}

/** Read only a connection explicitly granted to this principal in this project. */
export async function resolveUserProviderConnection(projectId: string, userId: string, providerId: string) {
  const [row] = await db.select({ connection: connections }).from(bindings)
    .innerJoin(connections, eq(bindings.connectionId, connections.connectionId))
    .where(and(eq(bindings.projectId, projectId), eq(bindings.userId, userId), eq(bindings.providerId, providerId)));
  if (!row) return null;
  return { ...row.connection, value: unseal(userId, providerId, 'credential', row.connection.valueEnc) };
}

/** Compare-and-swap prevents an in-flight refresh from overwriting a reconnect. */
export async function updateUserProviderConnection(row: typeof connections.$inferSelect, value: string) {
  const [updated] = await db.update(connections)
    .set({ valueEnc: seal(row.userId, row.providerId, 'credential', value), updatedAt: new Date() })
    .where(and(eq(connections.connectionId, row.connectionId), eq(connections.valueEnc, row.valueEnc)))
    .returning({ id: connections.connectionId });
  return !!updated;
}

/** Serialize refreshes across API replicas; disconnect waits for an active refresh. */
export async function withUserProviderConnectionLock<T>(
  connectionId: string,
  callback: (row: (typeof connections.$inferSelect & { value: string }) | null,
    persist: (value: string) => Promise<void>) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(connections).where(eq(connections.connectionId, connectionId)).for('update');
    const resolved = row ? { ...row, value: unseal(row.userId, row.providerId, 'credential', row.valueEnc) } : null;
    return callback(resolved, async (value) => {
      if (!row) throw new Error('Provider connection was removed');
      await tx.update(connections).set({ valueEnc: seal(row.userId, row.providerId, 'credential', value), updatedAt: new Date() })
        .where(eq(connections.connectionId, row.connectionId));
    });
  });
}
