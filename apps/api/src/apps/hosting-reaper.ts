import { appDeployments, appRuntimes, apps } from '@kortix/db';
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { config } from '../config';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { AppHostingService } from './hosting-service';

const LIVE_RUNTIME_STATUSES = ['provisioning', 'starting', 'running', 'stopping'] as const;
const RECENT_RUNTIME_KEEP_MS = 15 * 60_000;
const ROLLBACK_IMAGES_PER_APP = 10;

interface ProtectedHostingResources {
  deploymentIds: Set<string>;
  externalIds: Set<string>;
}

type ReconcileInput = Parameters<AppHostingService['reconcileManagedArtifacts']>[0];
type ReconcileResult = Awaited<ReturnType<AppHostingService['reconcileManagedArtifacts']>>;

interface HostingReaperDependencies {
  enabled: boolean;
  loadProtected: (now: Date) => Promise<ProtectedHostingResources>;
  reconcile: (input: ReconcileInput) => Promise<ReconcileResult>;
  graceMs: number;
  maxDeletes: number;
}

async function loadProtectedHostingResources(now: Date): Promise<ProtectedHostingResources> {
  const recentCutoff = new Date(now.getTime() - RECENT_RUNTIME_KEEP_MS);
  const [runtimeRows, retainedDeploymentRows] = await Promise.all([
    db.select({
      deploymentId: appRuntimes.deploymentId,
      externalId: appRuntimes.externalId,
    })
      .from(appRuntimes)
      .innerJoin(appDeployments, eq(appDeployments.deploymentId, appRuntimes.deploymentId))
      .innerJoin(apps, eq(apps.appId, appDeployments.appId))
      .where(and(
        eq(appRuntimes.hostingType, 'managed_container'),
        eq(appRuntimes.provider, 'aws_lightsail'),
        isNull(apps.deletedAt),
        or(
          eq(apps.activeDeploymentId, appRuntimes.deploymentId),
          inArray(appRuntimes.status, [...LIVE_RUNTIME_STATUSES]),
          gt(appRuntimes.updatedAt, recentCutoff),
        ),
      )),
    db.execute(sql`
      SELECT deployment_id
      FROM kortix.app_deployments deployment
      JOIN kortix.apps app ON app.app_id = deployment.app_id
      WHERE app.deleted_at IS NULL
        AND deployment.hosting_type = 'managed_container'
        AND deployment.hosting_provider = 'aws_lightsail'
        AND deployment.status IN ('queued', 'validating', 'building', 'provisioning', 'checking')
      UNION
      SELECT deployment_id
      FROM (
        SELECT
          deployment.deployment_id,
          row_number() OVER (PARTITION BY deployment.app_id ORDER BY deployment.version DESC) AS rollback_rank
        FROM kortix.app_deployments deployment
        JOIN kortix.apps app ON app.app_id = deployment.app_id
        WHERE app.deleted_at IS NULL
          AND deployment.hosting_type = 'managed_container'
          AND deployment.hosting_provider = 'aws_lightsail'
          AND deployment.status = 'ready'
      ) retained
      WHERE rollback_rank <= ${ROLLBACK_IMAGES_PER_APP}
    `),
  ]);
  const deploymentIds = new Set(runtimeRows.map((row) => row.deploymentId));
  for (const row of retainedDeploymentRows as unknown as Array<{ deployment_id: string }>) {
    deploymentIds.add(row.deployment_id);
  }
  return {
    deploymentIds,
    externalIds: new Set(runtimeRows.map((row) => row.externalId)),
  };
}

function productionDependencies(): HostingReaperDependencies {
  const hosting = new AppHostingService();
  return {
    enabled: config.KORTIX_APPS_LIGHTSAIL_ENABLED && config.KORTIX_APPS_HOSTING_REAPER_ENABLED,
    loadProtected: loadProtectedHostingResources,
    reconcile: (input) => hosting.reconcileManagedArtifacts(input),
    graceMs: config.KORTIX_APPS_HOSTING_REAPER_GRACE_MS,
    maxDeletes: config.KORTIX_APPS_HOSTING_REAPER_MAX_DELETES,
  };
}

let running = false;
const state = globalThis as unknown as {
  __kortixAppsHostingReaperTimer?: ReturnType<typeof setInterval> | null;
};

/**
 * Reconcile provider-side resources only after the complete DB protection set
 * loads. A DB failure rejects before any provider list or delete call.
 */
export async function runAppHostingReaper(
  now = new Date(),
  dependencies: HostingReaperDependencies = productionDependencies(),
): Promise<ReconcileResult> {
  if (!dependencies.enabled || running) return null;
  running = true;
  try {
    const protectedResources = await dependencies.loadProtected(now);
    return dependencies.reconcile({
      protectedDeploymentIds: protectedResources.deploymentIds,
      protectedExternalIds: protectedResources.externalIds,
      now,
      graceMs: dependencies.graceMs,
      maxDeletes: dependencies.maxDeletes,
    });
  } finally {
    running = false;
  }
}

export function startAppHostingReaper(): void {
  stopAppHostingReaper();
  if (!config.KORTIX_APPS_LIGHTSAIL_ENABLED || !config.KORTIX_APPS_HOSTING_REAPER_ENABLED) return;
  const run = () => {
    void runAppHostingReaper().then((result) => {
      if (result && (
        result.contextsDeleted
        || result.imagesDeleted
        || result.servicesDeleted
        || result.errors
      )) logger.info('[apps] managed hosting reconciliation', result);
    }).catch((error) => logger.error('[apps] managed hosting reconciliation failed closed', {
      error: error instanceof Error ? error.message : String(error),
    }));
  };
  run();
  const interval = Math.max(60_000, config.KORTIX_APPS_HOSTING_REAPER_INTERVAL_MS);
  state.__kortixAppsHostingReaperTimer = setInterval(run, interval);
}

export function stopAppHostingReaper(): void {
  if (!state.__kortixAppsHostingReaperTimer) return;
  clearInterval(state.__kortixAppsHostingReaperTimer);
  state.__kortixAppsHostingReaperTimer = null;
}
