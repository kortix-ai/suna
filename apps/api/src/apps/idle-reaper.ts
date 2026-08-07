import { appDeployments, appRuntimes, apps } from '@kortix/db';
import { and, eq, isNull, lt, lte, or } from 'drizzle-orm';
import { pauseComputeSession } from '../billing/services/compute-metering';
import { type SandboxProviderName } from '../config';
import { logger } from '../lib/logger';
import { getProvider } from '../platform/providers';
import { db } from '../shared/db';

let running = false;
const state = globalThis as unknown as {
  __kortixAppsIdleTimer?: ReturnType<typeof setInterval> | null;
};

export async function runAppIdleReaper(now = new Date()): Promise<{ candidates: number; stopped: number; errors: number }> {
  if (running) return { candidates: 0, stopped: 0, errors: 0 };
  running = true;
  try {
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
        await getProvider(claimed.provider as SandboxProviderName).stop(claimed.externalId);
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

export function startAppIdleReaper(): void {
  if (process.env.KORTIX_APPS_IDLE_REAPER_ENABLED === 'false') return;
  stopAppIdleReaper();
  const interval = Math.max(5_000, Number(process.env.KORTIX_APPS_IDLE_REAPER_INTERVAL_MS) || 30_000);
  state.__kortixAppsIdleTimer = setInterval(() => {
    void runAppIdleReaper().catch((error) => logger.error('[apps] idle reaper failed', {
      error: error instanceof Error ? error.message : String(error),
    }));
  }, interval);
}

export function stopAppIdleReaper(): void {
  if (state.__kortixAppsIdleTimer) {
    clearInterval(state.__kortixAppsIdleTimer);
    state.__kortixAppsIdleTimer = null;
  }
}
