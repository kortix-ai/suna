/** Provider-originated lifecycle writes for the auxiliary compute box. */
import { sessionEnvironments } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import { endComputeSession } from '../../billing/services/compute-metering';
import { db } from '../../shared/db';

async function reconcileEnvironmentByExternalId(
  externalId: string,
  outcome: 'stopped' | 'removed',
): Promise<boolean> {
  const [row] = await db
    .select({
      sessionId: sessionEnvironments.sessionId,
      environmentId: sessionEnvironments.environmentId,
      status: sessionEnvironments.status,
      metadata: sessionEnvironments.metadata,
    })
    .from(sessionEnvironments)
    .where(eq(sessionEnvironments.externalId, externalId))
    .limit(1);
  if (!row || row.status === 'stopped' || row.status === 'archived') return false;

  const meteredId =
    row.environmentId ?? (row.metadata as { environmentId?: unknown } | null)?.environmentId;
  if (typeof meteredId === 'string') await endComputeSession(meteredId).catch(() => {});

  const [updated] = await db
    .update(sessionEnvironments)
    .set({
      status: outcome === 'stopped' ? 'stopped' : 'error',
      ...(outcome === 'removed' ? { externalId: null, baseUrl: null } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sessionEnvironments.sessionId, row.sessionId),
        eq(sessionEnvironments.externalId, externalId),
        inArray(sessionEnvironments.status, ['active', 'provisioning', 'error']),
      ),
    )
    .returning({ sessionId: sessionEnvironments.sessionId });
  return !!updated;
}

export function reconcileEnvironmentStoppedByExternalId(externalId: string): Promise<boolean> {
  return reconcileEnvironmentByExternalId(externalId, 'stopped');
}

export function reconcileEnvironmentRemovedByExternalId(externalId: string): Promise<boolean> {
  return reconcileEnvironmentByExternalId(externalId, 'removed');
}
