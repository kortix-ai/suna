import * as resources from './resources';
import * as inventory from './inventory';
import * as envInjector from './env-injector';
import * as stats from './stats';
import { start as startAutoReplenish, stop as stopAutoReplenish } from './auto-replenish';
import type { CreateResult, PoolStatus, ClaimedSandbox, ClaimOpts, ResourceInput, PoolResource } from './types';
import { logger } from '../lib/logger';

export type { PoolResource, PoolSandbox, ClaimedSandbox, ClaimOpts, ResourceInput, PoolStatus, CreateResult } from './types';
export { resources, inventory, envInjector, stats };
export { startAutoReplenish, stopAutoReplenish };

export async function status(): Promise<PoolStatus> {
  const [allResources, counts] = await Promise.all([
    resources.list(),
    inventory.countByStatus(),
  ]);
  return { resources: allResources, ...counts };
}

export async function grab(opts?: ClaimOpts): Promise<ClaimedSandbox | null> {
  const start = Date.now();
  const result = await inventory.grab(opts);
  if (result) stats.recordClaimed(Date.now() - start);
  return result;
}

export async function injectEnv(claimed: ClaimedSandbox, serviceKey: string): Promise<void> {
  return envInjector.inject(claimed.poolSandbox, serviceKey);
}

export async function replenish(): Promise<{ created: number }> {
  const enabled = await resources.listEnabled();
  if (enabled.length === 0) return { created: 0 };

  let totalCreated = 0;

  for (const resource of enabled) {
    const current = await inventory.countForResource(resource.id);
    const deficit = resource.desiredCount - current;
    if (deficit <= 0) continue;

    for (let i = 0; i < deficit; i++) {
      try {
        await inventory.provision(resource);
        totalCreated++;
      } catch (err) {
        logger.error(`[POOL] Provision failed (${resource.serverType}/${resource.location})`, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  if (totalCreated > 0) {
    stats.recordCreated(totalCreated);
    logger.info(`[POOL] Replenished: ${totalCreated} created`);
  }
  stats.recordReplenish();
  return { created: totalCreated };
}

export async function forceCreate(count: number, resourceId?: string): Promise<CreateResult> {
  let targets: PoolResource[];
  if (resourceId) {
    const r = await resources.findById(resourceId);
    if (!r) throw new Error('Resource not found');
    targets = [r];
  } else {
    targets = await resources.listEnabled();
  }

  if (targets.length === 0) return { created: 0, failed: 0, errors: ['No enabled resources'] };

  let created = 0;
  let failed = 0;
  const errors: string[] = [];
  const perTarget = Math.ceil(count / targets.length);

  for (const resource of targets) {
    for (let i = 0; i < perTarget && (created + failed) < count; i++) {
      try {
        await inventory.provision(resource);
        created++;
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${resource.serverType}/${resource.location}: ${msg}`);
        logger.error('[POOL] Force-create error', { error: msg });
      }
    }
  }

  return { created, failed, errors };
}

export async function cleanup(): Promise<{ cleaned: number }> {
  const stale = await inventory.findStale();
  let cleaned = 0;

  for (const ps of stale) {
    try {
      await inventory.destroyOne(ps);
      cleaned++;
    } catch (err) {
      logger.error(`[POOL] Cleanup failed for ${ps.id}`, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (cleaned > 0) {
    stats.recordExpired(cleaned);
    logger.info(`[POOL] Cleaned ${cleaned} stale sandboxes`);
  }
  stats.recordCleanup();
  return { cleaned };
}

export async function drain(): Promise<{ drained: number }> {
  const all = await inventory.findAll();
  let drained = 0;

  for (const ps of all) {
    try {
      await inventory.destroyOne(ps);
      drained++;
    } catch (err) {
      logger.error(`[POOL] Drain failed for ${ps.id}`, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { drained };
}

export async function handleWebhook(externalId: string, stage?: string, webhookStatus?: string): Promise<boolean> {
  const ps = await inventory.findByExternalId(externalId);
  if (!ps) return false;

  if (webhookStatus === 'ready') {
    await inventory.markReady(ps.id);
    logger.info(`[POOL] ${ps.id} → ready`);
  } else if (webhookStatus === 'error') {
    await inventory.markError(ps.id);
    logger.info(`[POOL] ${ps.id} → error`);
  }

  return true;
}
