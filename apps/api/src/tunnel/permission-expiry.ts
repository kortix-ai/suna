/**
 * Expire tunnel permissions past their `expires_at`, and audit each one.
 *
 * An expiry revokes a computer capability (filesystem, shell, desktop …) as
 * surely as a manual revoke does, so it is an access change. Computer
 * operations already audit in the connector namespace on the `computer_tunnel`
 * resource (migration 20260809010000000); the expiry uses the same one.
 *
 * Runs inside the `tunnel-cleanup` worker tick, so each row names the worker.
 */
import type { AuditEventInput } from '../shared/audit';

export interface ExpiredTunnelPermission {
  permissionId: string;
  tunnelId: string;
  accountId: string;
  capability: string;
  expiresAt: Date | null;
}

export interface TunnelPermissionExpiryDeps {
  /** Flip every `active` permission past `expires_at` to `expired`; return them. */
  expire: (now: Date) => Promise<ExpiredTunnelPermission[]>;
  record: (event: AuditEventInput) => Promise<unknown>;
}

async function defaultExpire(now: Date): Promise<ExpiredTunnelPermission[]> {
  const [{ tunnelPermissions }, { and, eq, lt }, { db }] = await Promise.all([
    import('@kortix/db'),
    import('drizzle-orm'),
    import('../shared/db'),
  ]);
  return db
    .update(tunnelPermissions)
    .set({ status: 'expired', updatedAt: now })
    .where(and(eq(tunnelPermissions.status, 'active'), lt(tunnelPermissions.expiresAt, now)))
    .returning({
      permissionId: tunnelPermissions.permissionId,
      tunnelId: tunnelPermissions.tunnelId,
      accountId: tunnelPermissions.accountId,
      capability: tunnelPermissions.capability,
      expiresAt: tunnelPermissions.expiresAt,
    });
}

async function defaultRecord(event: AuditEventInput): Promise<unknown> {
  const { recordAuditEvent } = await import('../shared/audit');
  return recordAuditEvent(event);
}

/** Returns how many permissions expired. An audit failure never undoes one. */
export async function expireTunnelPermissions(
  now: Date,
  deps: Partial<TunnelPermissionExpiryDeps> = {},
): Promise<number> {
  const expired = await (deps.expire ?? defaultExpire)(now);
  const record = deps.record ?? defaultRecord;
  for (const permission of expired) {
    try {
      await record({
        accountId: permission.accountId,
        action: 'connector.computer.permission.expired',
        resourceType: 'computer_tunnel',
        resourceId: permission.tunnelId,
        outcome: 'success',
        before: { status: 'active' },
        after: { status: 'expired' },
        metadata: {
          permission_id: permission.permissionId,
          capability: permission.capability,
          expires_at: permission.expiresAt ? permission.expiresAt.toISOString() : null,
        },
      });
    } catch (err) {
      console.warn('[TUNNEL] permission expiry audit failed:', permission.permissionId, err);
    }
  }
  return expired.length;
}
