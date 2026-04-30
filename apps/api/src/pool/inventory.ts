import { eq, and, or, asc, lt, sql, count } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { poolSandboxes } from '@kortix/db';
import { db } from '../shared/db';
import { getProvider, type ProviderName } from '../platform/providers';
import { config } from '../config';
import type { PoolSandbox, PoolResource, ClaimedSandbox, ClaimOpts } from './types';

export async function listActive(limit = 50): Promise<PoolSandbox[]> {
  return db
    .select()
    .from(poolSandboxes)
    .where(sql`${poolSandboxes.status} IN ('ready', 'provisioning')`)
    .orderBy(asc(poolSandboxes.createdAt))
    .limit(limit);
}

export async function countByStatus(): Promise<{ ready: number; provisioning: number }> {
  const rows = await db
    .select({ status: poolSandboxes.status, count: count() })
    .from(poolSandboxes)
    .where(sql`${poolSandboxes.status} IN ('ready', 'provisioning')`)
    .groupBy(poolSandboxes.status);

  const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
  return { ready: byStatus['ready'] ?? 0, provisioning: byStatus['provisioning'] ?? 0 };
}

export async function countForResource(resourceId: string): Promise<number> {
  const rows = await db
    .select({ id: poolSandboxes.id })
    .from(poolSandboxes)
    .where(and(eq(poolSandboxes.resourceId, resourceId), sql`${poolSandboxes.status} IN ('ready', 'provisioning')`));
  return rows.length;
}

async function findCandidate(opts?: ClaimOpts) {
  const ready = eq(poolSandboxes.status, 'ready' as any);

  if (opts?.serverType && opts?.location) {
    const [exact] = await db
      .select()
      .from(poolSandboxes)
      .where(and(ready, eq(poolSandboxes.serverType, opts.serverType), eq(poolSandboxes.location, opts.location)))
      .orderBy(asc(poolSandboxes.createdAt))
      .limit(1);
    if (exact) return exact;

    const [sameSize] = await db
      .select()
      .from(poolSandboxes)
      .where(and(ready, eq(poolSandboxes.serverType, opts.serverType)))
      .orderBy(asc(poolSandboxes.createdAt))
      .limit(1);
    if (sameSize) {
      console.log(`[POOL] No exact match for ${opts.serverType}/${opts.location}, falling back to ${sameSize.serverType}/${sameSize.location}`);
      return sameSize;
    }

    return null;
  }

  const conditions = [ready];
  if (opts?.serverType) conditions.push(eq(poolSandboxes.serverType, opts.serverType));
  if (opts?.location) conditions.push(eq(poolSandboxes.location, opts.location));

  const [candidate] = await db
    .select()
    .from(poolSandboxes)
    .where(and(...conditions))
    .orderBy(asc(poolSandboxes.createdAt))
    .limit(1);

  return candidate ?? null;
}

export async function grab(opts?: ClaimOpts): Promise<ClaimedSandbox | null> {
  const candidate = await findCandidate(opts);
  if (!candidate) return null;

  const [claimed] = await db
    .delete(poolSandboxes)
    .where(and(eq(poolSandboxes.id, candidate.id), eq(poolSandboxes.status, 'ready' as any)))
    .returning();

  if (!claimed) return null;

  console.log(`[POOL] Grabbed ${claimed.id} (${claimed.serverType}/${claimed.location})`);

  // Strip poolPlaceholderToken from metadata — it was used for env injection auth
  // and must not leak into the user sandbox record.
  const { poolPlaceholderToken: _, ...cleanMeta } = (claimed.metadata as Record<string, unknown>) ?? {};

  return {
    poolSandbox: claimed,
    externalId: claimed.externalId,
    baseUrl: claimed.baseUrl,
    metadata: {
      ...cleanMeta,
      claimedFromPool: true,
      claimedAt: new Date().toISOString(),
      poolServerType: claimed.serverType,
      poolLocation: claimed.location,
      provisioningStage: 'services_ready',
    },
  };
}

export async function provision(resource: PoolResource): Promise<void> {
  const providerName = resource.provider as ProviderName;
  const provider = getProvider(providerName);
  const placeholderToken = `pool_${randomBytes(16).toString('hex')}`;

  const result = await provider.create({
    accountId: 'pool',
    userId: 'pool',
    name: `pool-${resource.serverType}-${resource.location}`,
    envVars: { KORTIX_TOKEN: placeholderToken },
    serverType: resource.serverType,
    location: resource.location,
  });

  await db.insert(poolSandboxes).values({
    resourceId: resource.id,
    provider: providerName,
    externalId: result.externalId,
    baseUrl: result.baseUrl || '',
    serverType: resource.serverType,
    location: resource.location,
    status: 'provisioning',
    metadata: { ...result.metadata, poolPlaceholderToken: placeholderToken },
  });

  console.log(`[POOL] Provisioned ${result.externalId} (${resource.serverType}/${resource.location})`);
}

export async function markReady(id: string): Promise<void> {
  await db.update(poolSandboxes).set({ status: 'ready', readyAt: new Date() }).where(eq(poolSandboxes.id, id));
}

export async function markError(id: string): Promise<void> {
  await db.update(poolSandboxes).set({ status: 'error' }).where(eq(poolSandboxes.id, id));
}

export async function findByExternalId(externalId: string): Promise<PoolSandbox | null> {
  const [row] = await db.select().from(poolSandboxes).where(eq(poolSandboxes.externalId, externalId)).limit(1);
  return row ?? null;
}

export async function destroyOne(ps: PoolSandbox): Promise<void> {
  if (ps.externalId) {
    const provider = getProvider(ps.provider as ProviderName);
    try {
      await provider.remove(ps.externalId);
    } catch (err) {
      console.error(`[POOL] provider.remove() failed for ${ps.externalId}, keeping record for retry:`, err);
      await db.update(poolSandboxes).set({ status: 'error' }).where(eq(poolSandboxes.id, ps.id));
      return;
    }
  }
  await db.delete(poolSandboxes).where(eq(poolSandboxes.id, ps.id));
}

export async function findStale(): Promise<PoolSandbox[]> {
  const maxAgeHours = config.POOL_MAX_AGE_HOURS || 24;

  return db
    .select()
    .from(poolSandboxes)
    .where(
      or(
        eq(poolSandboxes.status, 'error'),
        and(
          eq(poolSandboxes.status, 'ready'),
          lt(poolSandboxes.createdAt, sql`NOW() - make_interval(hours => ${maxAgeHours})`),
        ),
        and(
          eq(poolSandboxes.status, 'provisioning'),
          lt(poolSandboxes.createdAt, sql`NOW() - INTERVAL '15 minutes'`),
        ),
      ),
    );
}

export async function findAll(): Promise<PoolSandbox[]> {
  return db.select().from(poolSandboxes);
}
