import { randomInt, randomUUID } from 'node:crypto';
import {
  projectSessions,
  projectUserProviderConnections as bindings,
  sessionUserProviderConnections as sessionBindings,
  userProviderConnections as connections,
} from '@kortix/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { seal, unseal } from './crypto';
import { providerConnectionAdapter } from './adapters';

export const MAX_PROVIDER_CONNECTIONS = 10;
export interface ConnectionOptions {
  create?: boolean;
  connection_id?: string;
  label?: string;
}
export interface ConnectionSelection {
  connection_id?: string;
  pool?: boolean;
}
export class ProviderConnectionError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
  }
}

const owned = (userId: string, providerId: string) =>
  and(eq(connections.userId, userId), eq(connections.providerId, providerId));

export function connectionView(row: typeof connections.$inferSelect) {
  return {
    connection_id: row.connectionId,
    provider_id: row.providerId,
    auth_type: row.authType,
    label: row.label,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function listUserProviderConnections(userId: string) {
  return (
    await db
      .select()
      .from(connections)
      .where(eq(connections.userId, userId))
      .orderBy(asc(connections.createdAt), asc(connections.connectionId))
  ).map(connectionView);
}

export async function saveUserProviderConnection(
  userId: string,
  providerId: string,
  value: string,
  options: ConnectionOptions = {},
) {
  const adapter = providerConnectionAdapter(providerId);
  if (!adapter) throw new Error('Unsupported provider');
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`provider:${userId}:${providerId}`}, 0))`,
    );
    const rows = await tx.select().from(connections).where(owned(userId, providerId)).for('update');
    let row = options.connection_id
      ? rows.find((item) => item.connectionId === options.connection_id)
      : options.create
        ? undefined
        : rows.find((item) => item.slot === 'default');
    if (options.connection_id && !row)
      throw new ProviderConnectionError('Provider connection not found', 404);
    const identity = adapter.credentialIdentity?.(value);
    const duplicate = rows.find((item) => {
      const previous = unseal(userId, providerId, 'credential', item.valueEnc);
      return identity ? adapter.credentialIdentity?.(previous) === identity : previous === value;
    });
    if (duplicate && row && duplicate.connectionId !== row.connectionId) {
      throw new ProviderConnectionError(
        'This provider account is already connected. Select its saved connection.',
        409,
      );
    }
    row ??= duplicate;
    const valueEnc = seal(userId, providerId, 'credential', value);
    if (row) {
      const [updated] = await tx
        .update(connections)
        .set({
          valueEnc,
          updatedAt: new Date(),
          ...(options.label === undefined ? {} : { label: options.label }),
        })
        .where(eq(connections.connectionId, row.connectionId))
        .returning();
      return connectionView(updated!);
    }
    if (rows.length >= MAX_PROVIDER_CONNECTIONS) {
      throw new ProviderConnectionError(
        `A provider supports up to ${MAX_PROVIDER_CONNECTIONS} personal connections`,
        409,
      );
    }
    const [created] = await tx
      .insert(connections)
      .values({
        userId,
        providerId,
        authType: adapter.authType,
        valueEnc,
        slot: options.create ? randomUUID() : 'default',
        label: options.label ?? '',
      })
      .returning();
    return connectionView(created!);
  });
}

export async function deleteUserProviderConnection(
  userId: string,
  providerId: string,
  connectionId?: string,
) {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`provider:${userId}:${providerId}`}, 0))`,
    );
    if (connectionId) {
      const rows = await tx
        .select()
        .from(connections)
        .where(owned(userId, providerId))
        .for('update');
      if (!rows.some((row) => row.connectionId === connectionId)) return;
      const remaining = rows.find((row) => row.connectionId !== connectionId);
      if (remaining) {
        await tx
          .update(bindings)
          .set({ connectionId: remaining.connectionId })
          .where(
            and(
              eq(bindings.connectionId, connectionId),
              eq(bindings.userId, userId),
              eq(bindings.pool, true),
            ),
          );
      }
    }
    await tx
      .delete(connections)
      .where(
        and(
          owned(userId, providerId),
          connectionId ? eq(connections.connectionId, connectionId) : undefined,
        ),
      );
  });
}

export async function listProjectUserProviderConnections(projectId: string, userId: string) {
  return db
    .select({
      provider_id: bindings.providerId,
      connection_id: bindings.connectionId,
      pool: bindings.pool,
    })
    .from(bindings)
    .where(and(eq(bindings.projectId, projectId), eq(bindings.userId, userId)));
}

export async function bindUserProviderConnection(
  projectId: string,
  userId: string,
  providerId: string,
  enabled: boolean,
  selection: ConnectionSelection = {},
) {
  if (!enabled) {
    await db
      .delete(bindings)
      .where(
        and(
          eq(bindings.projectId, projectId),
          eq(bindings.userId, userId),
          eq(bindings.providerId, providerId),
        ),
      );
    return true;
  }
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(connections)
      .where(owned(userId, providerId))
      .orderBy(asc(connections.createdAt), asc(connections.connectionId))
      .for('share');
    const row = selection.connection_id
      ? rows.find((item) => item.connectionId === selection.connection_id)
      : (rows.find((item) => item.slot === 'default') ?? rows[0]);
    if (!row) return false;
    await tx
      .insert(bindings)
      .values({
        projectId,
        userId,
        providerId,
        connectionId: row.connectionId,
        pool: selection.pool ?? false,
      })
      .onConflictDoUpdate({
        target: [bindings.projectId, bindings.userId, bindings.providerId],
        set: { connectionId: row.connectionId, pool: selection.pool ?? false },
      });
    return true;
  });
}

/** Pool membership is always the authenticated user's own provider connections. */
export async function resolveUserProviderConnection(
  projectId: string,
  userId: string,
  providerId: string,
  sessionId?: string | null,
) {
  return db.transaction(async (tx) => {
    const [binding] = await tx
      .select()
      .from(bindings)
      .where(
        and(
          eq(bindings.projectId, projectId),
          eq(bindings.userId, userId),
          eq(bindings.providerId, providerId),
        ),
      );
    if (!binding) return null;
    const rows = await tx
      .select()
      .from(connections)
      .where(
        and(
          owned(userId, providerId),
          binding.pool ? undefined : eq(connections.connectionId, binding.connectionId),
        ),
      );
    if (!rows.length) return null;
    let row = rows[0]!;
    if (binding.pool) {
      const sessionWhere = sessionId
        ? and(
            eq(sessionBindings.sessionId, sessionId),
            eq(sessionBindings.userId, userId),
            eq(sessionBindings.providerId, providerId),
          )
        : undefined;
      if (sessionId) {
        const [session] = await tx
          .select({ id: projectSessions.sessionId })
          .from(projectSessions)
          .where(
            and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)),
          );
        if (!session) throw new ProviderConnectionError('Session not found in this project', 404);
        const [existing] = await tx.select().from(sessionBindings).where(sessionWhere);
        const selected = rows.find((item) => item.connectionId === existing?.connectionId);
        if (selected)
          return {
            ...selected,
            value: unseal(userId, providerId, 'credential', selected.valueEnc),
          };
      }
      row = rows[randomInt(rows.length)]!;
      if (sessionId) {
        await tx
          .insert(sessionBindings)
          .values({ sessionId, userId, providerId, connectionId: row.connectionId })
          .onConflictDoNothing();
        const [selected] = await tx
          .select({ connection: connections })
          .from(sessionBindings)
          .innerJoin(connections, eq(sessionBindings.connectionId, connections.connectionId))
          .where(sessionWhere);
        if (!selected) return null;
        row = selected.connection;
      }
    }
    return { ...row, value: unseal(userId, providerId, 'credential', row.valueEnc) };
  });
}

/** Compare-and-swap prevents an in-flight refresh from overwriting a reconnect. */
export async function updateUserProviderConnection(
  row: typeof connections.$inferSelect,
  value: string,
) {
  const [updated] = await db
    .update(connections)
    .set({ valueEnc: seal(row.userId, row.providerId, 'credential', value), updatedAt: new Date() })
    .where(
      and(eq(connections.connectionId, row.connectionId), eq(connections.valueEnc, row.valueEnc)),
    )
    .returning({ id: connections.connectionId });
  return !!updated;
}

/** Serialize refreshes across API replicas; disconnect waits for an active refresh. */
export async function withUserProviderConnectionLock<T>(
  connectionId: string,
  callback: (
    row: (typeof connections.$inferSelect & { value: string }) | null,
    persist: (value: string) => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(connections)
      .where(eq(connections.connectionId, connectionId))
      .for('update');
    const resolved = row
      ? { ...row, value: unseal(row.userId, row.providerId, 'credential', row.valueEnc) }
      : null;
    return callback(resolved, async (value) => {
      if (!row) throw new Error('Provider connection was removed');
      await tx
        .update(connections)
        .set({
          valueEnc: seal(row.userId, row.providerId, 'credential', value),
          updatedAt: new Date(),
        })
        .where(eq(connections.connectionId, row.connectionId));
    });
  });
}
