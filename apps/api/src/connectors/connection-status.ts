/**
 * The status writes of a connector connection (`connector_connections.status`).
 *
 * A revoke is sticky against stale writers. An offboarding, a person's
 * Disconnect, an unpaired computer, or a removed email install revokes the
 * account, and a write that STARTED before the revoke must not undo it: an
 * OAuth callback whose sign-in tab was still open, a device-flow poll, a
 * Composio finalize. Each transition is a compare-and-set
 * (`shared/status-transition.ts`):
 *
 *   - `connect`: a reconnect. Only its `person` authority (a click, a pasted
 *     credential, a paired machine) leaves `revoked` unconditionally; an
 *     `agent` authority (an agent session starting its own authorization)
 *     never does.
 *   - `complete`: an in-flight completion. It leaves `revoked` only when the
 *     revoke (`metadata.revokedAt`) is older than the flow (`startedAt`): a
 *     sign-in a person started on a revoked account still reconnects it.
 *   - `fail`: an authorization failed. A revoked account stays revoked.
 *   - `revoke`: records `metadata.revokedAt` and expires the account's pending
 *     OAuth sessions, so their callbacks find no session to complete.
 */

import { connectionOAuthSessions, connectorConnections } from '@kortix/db';
import { type SQL, and, eq, inArray, or, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';

import { db } from '../shared/db';
import { type StatusExecutor, transitionStatus, transitionStatusAll } from '../shared/status-transition';

type ConnectionRow = typeof connectorConnections.$inferSelect;
type ConnectionSet = PgUpdateSetSource<typeof connectorConnections>;
type ConnectionStatus = ConnectionRow['status'];

export const CONNECTION_TRANSITIONS = {
  connect: { from: ['active', 'error', 'revoked'], to: 'active' },
  complete: { from: ['active', 'error', 'revoked'], to: 'active' },
  fail: { from: ['active', 'error'], to: 'error' },
  revoke: { from: ['active', 'error', 'revoked'], to: 'revoked' },
} as const satisfies Record<string, { from: readonly ConnectionStatus[]; to: ConnectionStatus }>;

/**
 * `revoked` only when a recorded revoke predates `startedAt` (ISO strings sort
 * by time). A revoked row with no `revokedAt` (the 2026-09-17 migration stamped
 * only `updated_at`) cannot prove it predates the flow, so it stays revoked: a
 * missing stamp is not the epoch.
 */
function revokedBefore(startedAt: Date): SQL {
  return or(
    sql`${connectorConnections.status} <> 'revoked'`,
    sql`(
      ${connectorConnections.metadata}->>'revokedAt' IS NOT NULL
      AND ${connectorConnections.metadata}->>'revokedAt' < ${startedAt.toISOString()}
    )`,
  )!;
}

/**
 * A completion that started at `startedAt` marks the account active. False:
 * the account was revoked after the flow started (or is gone). A null
 * `startedAt` (the flow recorded no start) never leaves `revoked`.
 */
export async function completeConnection(
  connectionId: string,
  startedAt: Date | null,
  set: ConnectionSet = {},
  exec: StatusExecutor = db,
): Promise<boolean> {
  const moved = await transitionStatus(
    connectorConnections,
    connectorConnections.status,
    CONNECTION_TRANSITIONS.complete,
    {
      where: eq(connectorConnections.connectionId, connectionId),
      set: { ...set, metadata: set.metadata ?? sql`${connectorConnections.metadata} - 'revokedAt'`, updatedAt: new Date() },
      guard: startedAt ? revokedBefore(startedAt) : sql`${connectorConnections.status} <> 'revoked'`,
    },
    exec,
  );
  return moved.applied;
}

/**
 * WHO starts the (re)connect: `person` is a request only a person can make (a
 * click in Customize, a pasted credential, a paired machine); `agent` is
 * anything an agent session can reach on its own behalf.
 */
export type ConnectAuthority = 'person' | 'agent';

/**
 * An account connects from any status. Only a `person` may leave `revoked`: a
 * revoke is a person's decision, and an agent re-authorizing its own account
 * must not undo it (`agentMayTouchConnection`, projects/lib/connection-mutation.ts).
 * The guard makes that part of the UPDATE, so a concurrent revoke still wins.
 */
export async function connectConnection(
  connectionId: string,
  set: ConnectionSet = {},
  exec: StatusExecutor = db,
  authority: ConnectAuthority = 'agent',
): Promise<ConnectionRow | null> {
  const moved = await transitionStatus(
    connectorConnections,
    connectorConnections.status,
    CONNECTION_TRANSITIONS.connect,
    {
      where: eq(connectorConnections.connectionId, connectionId),
      set: { ...set, metadata: set.metadata ?? sql`${connectorConnections.metadata} - 'revokedAt'`, updatedAt: new Date() },
      ...(authority === 'person' ? {} : { guard: sql`${connectorConnections.status} <> 'revoked'` }),
    },
    exec,
  );
  if (!moved.applied && authority === 'agent') await expirePendingOAuthSessions(connectionId, exec);
  return moved.applied ? moved.row : null;
}

/**
 * An agent's start that found the account revoked expires the sessions waiting
 * on it: a revoke expires the sessions of a row it moved, but a start on a row
 * that is ALREADY revoked never moved it, so its poll would otherwise find a
 * pending session and store a token on an account a person turned off.
 */
async function expirePendingOAuthSessions(
  connectionId: string,
  exec: Pick<typeof db, 'update'>,
): Promise<void> {
  await exec
    .update(connectionOAuthSessions)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(and(eq(connectionOAuthSessions.connectionId, connectionId), eq(connectionOAuthSessions.status, 'pending')));
}

/** An authorization failed: `error`, unless the account is revoked. */
export async function failConnection(connectionId: string, exec: StatusExecutor = db): Promise<void> {
  await transitionStatus(
    connectorConnections,
    connectorConnections.status,
    CONNECTION_TRANSITIONS.fail,
    { where: eq(connectorConnections.connectionId, connectionId), set: { updatedAt: new Date() } },
    exec,
  );
}

/**
 * Revoke every account `where` selects. Records the revoke time, merges
 * `metadata` (a `revokedReason`), and expires their pending OAuth sessions.
 * Returns the revoked rows.
 */
export async function revokeConnections(
  where: SQL | undefined,
  options: { set?: ConnectionSet; metadata?: Record<string, unknown> } = {},
  exec: Pick<typeof db, 'update'> = db,
): Promise<ConnectionRow[]> {
  const merge = { ...(options.metadata ?? {}), revokedAt: new Date().toISOString() };
  const rows = await transitionStatusAll(
    connectorConnections,
    connectorConnections.status,
    CONNECTION_TRANSITIONS.revoke,
    {
      where,
      set: {
        ...options.set,
        metadata: sql`coalesce(${connectorConnections.metadata}, '{}'::jsonb) || ${JSON.stringify(merge)}::jsonb`,
        updatedAt: new Date(),
      },
    },
    exec,
  );
  if (rows.length > 0) {
    await exec
      .update(connectionOAuthSessions)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(
        and(
          inArray(
            connectionOAuthSessions.connectionId,
            rows.map((row) => row.connectionId),
          ),
          eq(connectionOAuthSessions.status, 'pending'),
        ),
      );
  }
  return rows;
}
