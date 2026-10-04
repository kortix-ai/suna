/**
 * App deployment images — the provider template each deployment build mints
 * (`kortix-app-<deploymentId-no-dashes>`, `deployment-worker.ts`).
 *
 * Every deploy, and every automatic runtime rebuild (`enqueueCurrentAppRuntime`),
 * mints one. Providers cap how many an org may hold: Platinum refuses builds
 * past its per-org template count (`org_template_quota_exceeded`, tiers
 * 10/50/500), and `services/snapshots/quota-gc.ts` reclaims Daytona only. Before this
 * module nothing deleted an App image, so deleting an App freed its runtimes and
 * left every image behind against the quota.
 *
 * An image is reclaimable only when its deployment can never serve again:
 *   - its App is deleted, or
 *   - the deployment is `failed`, `cancelled`, or `deleted`,
 * and no runtime of that deployment still exists (Platinum refuses to delete a
 * template while a sandbox pins its rootfs). A superseded `ready` deployment is
 * a rollback target and keeps its image until its owner deletes it.
 *
 * Two callers:
 *   1. The App and deployment delete routes release images in the same request.
 *   2. `reclaimAppDeploymentImages`, run by project maintenance, retries what a
 *      request could not finish (a sandbox still tearing down, a provider
 *      outage) and reclaims images orphaned before this module existed.
 *
 * Cross-environment safety: dev, staging, and prod can share one provider org
 * but never one database. The sweep deletes an image only when THIS database
 * holds its deployment row in a reclaimable state. An image whose deployment id
 * is unknown here belongs to another environment and is never touched.
 */
import { appDeployments, appRuntimes, apps } from '@kortix/db';
import { and, eq, inArray, isNotNull, ne, notExists, or, sql } from 'drizzle-orm';
import { pauseComputeSession } from '../billing/services/compute-metering';
import { config, type SandboxProviderName } from '../../lib/config';
import { logger } from '../../lib/logger';
import { getProvider, type SandboxProvider } from '../platform/providers';
import { db } from '../../lib/db';
import { mapWithConcurrency } from '../../lib/map-with-concurrency';
import { getSandboxProvider } from '../snapshots/providers';
import { SnapshotInUseError } from '../snapshots/providers/errors';
import {
  APP_DEPLOYMENT_PREFIX,
  appDeploymentSnapshotName,
  deploymentIdFromAppSnapshotName,
} from '../snapshots/quota-gc-select';

/** Deployment states that can never serve traffic again. */
export const RECLAIMABLE_DEPLOYMENT_STATUSES = ['failed', 'cancelled', 'deleted'] as const;

/** Images deleted per maintenance pass, per provider. Bounds one pass's cost. */
export const APP_IMAGE_RECLAIM_MAX_PER_PASS = 25;

/** Concurrent provider deletes inside one App delete request. */
const RELEASE_CONCURRENCY = 4;

/**
 * - `released`: the provider no longer holds the image (deleted now, or absent).
 * - `pending`: the provider kept it (a sandbox still pins it, or the call
 *   failed). Project maintenance retries it.
 * - `none`: the deployment never reached a provider build, or its provider is
 *   not configured here, so there is no image this deployment can reach.
 */
export type AppImageReleaseOutcome = 'released' | 'pending' | 'none';

export interface AppImageReleaseSummary {
  released: number;
  pending: number;
}

/** The provider calls this module makes. `snapshots/providers` implements them. */
export interface AppImageProvider {
  isConfigured(): boolean;
  listSnapshots(): Promise<Array<{ name: string }>>;
  deleteSnapshot(snapshotName: string): Promise<void>;
}

export interface AppImageDeployment {
  deploymentId: string;
  hostingProvider: string | null;
}

function imageProvider(
  provider: string,
  resolve: (provider: string) => AppImageProvider,
): AppImageProvider | null {
  try {
    const adapter = resolve(provider);
    return adapter.isConfigured() ? adapter : null;
  } catch {
    return null;
  }
}

/** Delete one deployment's image. Never throws. */
export async function releaseDeploymentImage(
  deployment: AppImageDeployment,
  resolve: (provider: string) => AppImageProvider = getSandboxProvider,
): Promise<AppImageReleaseOutcome> {
  if (!deployment.hostingProvider) return 'none';
  const adapter = imageProvider(deployment.hostingProvider, resolve);
  if (!adapter) {
    logger.warn('[apps] image release skipped: provider is not configured', {
      deploymentId: deployment.deploymentId,
      provider: deployment.hostingProvider,
    });
    return 'none';
  }
  const snapshotName = appDeploymentSnapshotName(deployment.deploymentId);
  try {
    await adapter.deleteSnapshot(snapshotName);
    return 'released';
  } catch (error) {
    if (!(error instanceof SnapshotInUseError)) {
      logger.warn('[apps] image release failed; maintenance retries it', {
        deploymentId: deployment.deploymentId,
        provider: deployment.hostingProvider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return 'pending';
  }
}

/** Release every image of a set of deployments, a few at a time. Never throws. */
export async function releaseDeploymentImages(
  deployments: AppImageDeployment[],
  resolve: (provider: string) => AppImageProvider = getSandboxProvider,
): Promise<AppImageReleaseSummary> {
  const summary: AppImageReleaseSummary = { released: 0, pending: 0 };
  const queue = deployments.filter((deployment) => deployment.hostingProvider);
  await mapWithConcurrency(queue, RELEASE_CONCURRENCY, async (next) => {
    const outcome = await releaseDeploymentImage(next, resolve);
    if (outcome === 'released') summary.released += 1;
    else if (outcome === 'pending') summary.pending += 1;
  });
  return summary;
}

export interface AppRuntimeTeardownTarget {
  runtimeId: string;
  provider: string;
  externalId: string;
}

/**
 * Remove one App runtime sandbox and prove it is gone. A provider that answers
 * the delete with an error (Platinum 404s an already-deleted sandbox) is asked
 * for its status; only `removed` counts. Returns whether the runtime is gone.
 */
export async function removeAppRuntime(
  runtime: AppRuntimeTeardownTarget,
  resolve: (provider: string) => SandboxProvider = (provider) => getProvider(provider as SandboxProviderName),
): Promise<boolean> {
  let provider: SandboxProvider;
  try {
    provider = resolve(runtime.provider);
  } catch {
    // A retired or disabled provider: its sandbox is unreachable from here and
    // nothing this environment can do will remove it. Treat it as gone so the
    // runtime row stops holding its deployment's image hostage.
    return true;
  }
  try {
    await provider.remove(runtime.externalId);
    return true;
  } catch (error) {
    const status = await provider.getStatus(runtime.externalId).catch(() => 'unknown' as const);
    if (status === 'removed') return true;
    logger.warn('[apps] runtime removal failed; maintenance retries it', {
      runtimeId: runtime.runtimeId,
      provider: runtime.provider,
      status,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Mark removed runtimes `deleted` and close their compute meter. */
export async function markAppRuntimesDeleted(runtimeIds: string[], now = new Date()): Promise<void> {
  if (runtimeIds.length === 0) return;
  await db.update(appRuntimes)
    .set({
      status: 'deleted',
      stoppedAt: sql`coalesce(${appRuntimes.stoppedAt}, ${now.toISOString()}::timestamptz)`,
      activityLeaseUntil: null,
      idleDeadlineAt: null,
      wakeLeaseOwner: null,
      wakeLeaseUntil: null,
      updatedAt: now,
    })
    .where(inArray(appRuntimes.runtimeId, runtimeIds));
  for (const runtimeId of runtimeIds) {
    await pauseComputeSession(runtimeId, now).catch((error) => {
      logger.error('[apps] compute meter close failed for a deleted runtime', {
        runtimeId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

/**
 * Remove every listed runtime, then mark the ones proven gone `deleted`. The
 * compute meter closes for every runtime, removed or not: the owner asked for
 * it to stop, and a provider we cannot reach is not the owner's bill.
 */
export async function teardownAppRuntimes(
  runtimes: AppRuntimeTeardownTarget[],
  remove: (runtime: AppRuntimeTeardownTarget) => Promise<boolean> = removeAppRuntime,
): Promise<{ removed: number; failed: number }> {
  const removed: string[] = [];
  const failed: string[] = [];
  for (const runtime of runtimes) {
    if (await remove(runtime)) removed.push(runtime.runtimeId);
    else failed.push(runtime.runtimeId);
  }
  await markAppRuntimesDeleted(removed);
  for (const runtimeId of failed) {
    await pauseComputeSession(runtimeId).catch((error) => {
      logger.error('[apps] compute meter close failed for an unremoved runtime', {
        runtimeId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return { removed: removed.length, failed: failed.length };
}

const reclaimableDeployment = or(
  isNotNull(apps.deletedAt),
  inArray(appDeployments.status, [...RECLAIMABLE_DEPLOYMENT_STATUSES]),
);

export interface AppImageReclaimIo {
  /** Configured providers whose images this environment may manage. */
  providers(): Array<{ name: string; adapter: AppImageProvider }>;
  /** Runtimes of reclaimable deployments that are not yet `deleted`. */
  loadLingeringRuntimes(limit: number): Promise<AppRuntimeTeardownTarget[]>;
  teardownRuntimes(runtimes: AppRuntimeTeardownTarget[]): Promise<{ removed: number; failed: number }>;
  /**
   * Of the given deployment ids, the ones THIS database holds as reclaimable
   * with no remaining runtime. Unknown ids (another environment) never return.
   */
  loadReclaimableDeploymentIds(deploymentIds: string[]): Promise<Set<string>>;
}

/** The production IO. Exported so the integration test runs its real SQL. */
export const appImageReclaimIo: AppImageReclaimIo = {
  providers() {
    return config.ALLOWED_SANDBOX_PROVIDERS.flatMap((name) => {
      const adapter = imageProvider(name, getSandboxProvider);
      return adapter ? [{ name, adapter }] : [];
    });
  },
  async loadLingeringRuntimes(limit) {
    return db
      .select({
        runtimeId: appRuntimes.runtimeId,
        provider: appRuntimes.provider,
        externalId: appRuntimes.externalId,
      })
      .from(appRuntimes)
      .innerJoin(appDeployments, eq(appRuntimes.deploymentId, appDeployments.deploymentId))
      .innerJoin(apps, eq(appDeployments.appId, apps.appId))
      .where(and(ne(appRuntimes.status, 'deleted'), reclaimableDeployment))
      .limit(limit);
  },
  teardownRuntimes: (runtimes) => teardownAppRuntimes(runtimes),
  async loadReclaimableDeploymentIds(deploymentIds) {
    const found = new Set<string>();
    for (let offset = 0; offset < deploymentIds.length; offset += 500) {
      const chunk = deploymentIds.slice(offset, offset + 500);
      const rows = await db
        .select({ deploymentId: appDeployments.deploymentId })
        .from(appDeployments)
        .innerJoin(apps, eq(appDeployments.appId, apps.appId))
        .where(and(
          inArray(appDeployments.deploymentId, chunk),
          reclaimableDeployment,
          notExists(
            db.select({ runtimeId: appRuntimes.runtimeId })
              .from(appRuntimes)
              .where(and(
                eq(appRuntimes.deploymentId, appDeployments.deploymentId),
                ne(appRuntimes.status, 'deleted'),
              )),
          ),
        ));
      for (const row of rows) found.add(row.deploymentId);
    }
    return found;
  },
};

export interface AppImageReclaimResult {
  /** Configured providers whose image list was read. */
  providers: number;
  /** `kortix-app-` images found across those providers. */
  listed: number;
  /** Of those, the images this environment may delete now. */
  reclaimable: number;
  released: number;
  /** Reclaimable images the provider kept (still pinned). Retried next pass. */
  pending: number;
  /** Reclaimable images beyond this pass's cap. Retried next pass. */
  deferred: number;
  runtimesRemoved: number;
  /** Provider listings or runtime removals that failed. */
  errors: number;
}

export const EMPTY_APP_IMAGE_RECLAIM_RESULT: AppImageReclaimResult = Object.freeze({
  providers: 0,
  listed: 0,
  reclaimable: 0,
  released: 0,
  pending: 0,
  deferred: 0,
  runtimesRemoved: 0,
  errors: 0,
});

/**
 * One maintenance pass: remove runtimes that still pin reclaimable images, then
 * delete those images. Bounded per pass; a failed provider listing skips that
 * provider only. Never throws.
 */
export async function reclaimAppDeploymentImages(
  opts: { maxPerPass?: number } = {},
  io: AppImageReclaimIo = appImageReclaimIo,
): Promise<AppImageReclaimResult> {
  const maxPerPass = opts.maxPerPass ?? APP_IMAGE_RECLAIM_MAX_PER_PASS;
  const result: AppImageReclaimResult = { ...EMPTY_APP_IMAGE_RECLAIM_RESULT };

  try {
    const lingering = await io.loadLingeringRuntimes(maxPerPass);
    if (lingering.length > 0) {
      const teardown = await io.teardownRuntimes(lingering);
      result.runtimesRemoved = teardown.removed;
      result.errors += teardown.failed;
    }
  } catch (error) {
    result.errors += 1;
    logger.warn('[apps] image reclaim: runtime teardown failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  for (const { name, adapter } of io.providers()) {
    let images: string[];
    try {
      images = (await adapter.listSnapshots())
        .map((snapshot) => snapshot.name)
        .filter((imageName) => imageName.startsWith(APP_DEPLOYMENT_PREFIX));
    } catch (error) {
      result.errors += 1;
      logger.warn('[apps] image reclaim: provider listing failed; provider skipped', {
        provider: name,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    result.providers += 1;
    result.listed += images.length;

    const byDeployment = new Map<string, string>();
    for (const imageName of images) {
      const deploymentId = deploymentIdFromAppSnapshotName(imageName);
      if (deploymentId) byDeployment.set(deploymentId, imageName);
    }
    if (byDeployment.size === 0) continue;

    let reclaimable: string[];
    try {
      reclaimable = [...await io.loadReclaimableDeploymentIds([...byDeployment.keys()])];
    } catch (error) {
      // Never act on a partial view: an unreadable database deletes nothing.
      result.errors += 1;
      logger.warn('[apps] image reclaim: deployment lookup failed; provider skipped', {
        provider: name,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    result.reclaimable += reclaimable.length;
    result.deferred += Math.max(0, reclaimable.length - maxPerPass);

    for (const deploymentId of reclaimable.slice(0, maxPerPass)) {
      const outcome = await releaseDeploymentImage(
        { deploymentId, hostingProvider: name },
        () => adapter,
      );
      if (outcome === 'released') result.released += 1;
      else result.pending += 1;
    }
  }

  if (result.released || result.pending || result.runtimesRemoved || result.errors) {
    logger.info('[apps] image reclaim', { ...result });
  }
  return result;
}
