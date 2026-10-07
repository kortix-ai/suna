import { appDeployments, appRuntimes, apps } from '@kortix/db';
import { and, eq, isNull, lt, lte, or } from 'drizzle-orm';
import { pauseComputeSession } from '../billing/services/compute-metering';
import { type SandboxProviderName } from '../config';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { AppHostingProvider } from './hosting';

let running = false;

/**
 * A reaper that died between claiming a runtime (`stopping`) and finishing the
 * stop (a deploy, a leader flap) leaves the row `stopping`. Nothing reads that
 * state, so the box kept running and billing. Past this age the row is handed
 * back to `running`; the next selection stops it again, and `hosting.stop` is
 * idempotent.
 */
export const STALE_STOPPING_MS = 3 * 60_000;

export async function runAppIdleReaper(now = new Date()): Promise<{ candidates: number; stopped: number; errors: number }> {
  if (running) return { candidates: 0, stopped: 0, errors: 0 };
  running = true;
  try {
    await db
      .update(appRuntimes)
      .set({ status: 'running', updatedAt: now })
      .where(and(
        eq(appRuntimes.status, 'stopping'),
        lt(appRuntimes.updatedAt, new Date(now.getTime() - STALE_STOPPING_MS)),
      ));
    const rows = await db
      .select({ runtime: appRuntimes, app: apps })
      .from(appRuntimes)
      .innerJoin(appDeployments, eq(appRuntimes.deploymentId, appDeployments.deploymentId))
      .innerJoin(apps, eq(appDeployments.appId, apps.appId))
      .where(and(
        eq(appRuntimes.status, 'running'),
        lte(appRuntimes.idleDeadlineAt, now),
        or(isNull(appRuntimes.activityLeaseUntil), lt(appRuntimes.activityLeaseUntil, now)),
        eq(apps.desiredState, 'running'),
        isNull(apps.deletedAt),
      ))
      .limit(50);
    let stopped = 0;
    let errors = 0;
    const hosting = new AppHostingProvider();
    for (const { runtime } of rows) {
      try {
        const [claimed] = await db
          .update(appRuntimes)
          .set({ status: 'stopping', updatedAt: now })
          .where(and(
            eq(appRuntimes.runtimeId, runtime.runtimeId),
            eq(appRuntimes.status, 'running'),
            lte(appRuntimes.idleDeadlineAt, now),
            or(isNull(appRuntimes.activityLeaseUntil), lt(appRuntimes.activityLeaseUntil, now)),
          ))
          .returning();
        if (!claimed) continue;
        await hosting.stop(claimed.provider as SandboxProviderName, claimed.externalId);
        const stoppedAt = new Date();
        await db.update(appRuntimes).set({
          status: 'stopped',
          stoppedAt,
          activityLeaseUntil: null,
          updatedAt: stoppedAt,
        }).where(eq(appRuntimes.runtimeId, claimed.runtimeId));
        await pauseComputeSession(claimed.runtimeId, stoppedAt);
        stopped += 1;
      } catch (error) {
        errors += 1;
        await db.update(appRuntimes).set({ status: 'running', updatedAt: new Date() })
          .where(and(eq(appRuntimes.runtimeId, runtime.runtimeId), eq(appRuntimes.status, 'stopping')))
          .catch(() => {});
        logger.error('[apps] idle stop failed', {
          runtimeId: runtime.runtimeId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { candidates: rows.length, stopped, errors };
  } finally {
    running = false;
  }
}

export { startAppIdleReaper, stopAppIdleReaper } from '../workers/app-idle-reaper-worker';
