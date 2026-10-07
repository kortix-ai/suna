/**
 * Deployment retention: an App keeps its active deployment and the newest
 * `KORTIX_APPS_RETAINED_DEPLOYMENTS` other ready ones as rollback targets.
 *
 * Before this, every successful deploy stayed `ready` forever, and each one
 * pinned a stopped sandbox, a provider template (Platinum caps templates per
 * org at 10/50/500, and a build past the cap fails), its archive and every
 * build-log row. Retiring an older deployment marks it `deleted`, exactly as
 * the delete route does, and frees what it held:
 *
 *   - runtime and image: torn down here; `reclaimAppDeploymentImages` retries
 *     whatever a provider could not release yet;
 *   - static files: the manifest rows go, so `reclaimAppSiteBlobs` can free
 *     blobs no remaining deployment names;
 *   - build logs: the per-line `build_log` events go; lifecycle events stay,
 *     so the history still says what happened;
 *   - archives: `reclaimAppArtifacts` deletes an archive once no live
 *     deployment uses it.
 */

import { appArtifacts, appDeploymentEvents, appDeployments, appRuntimes, appSiteFiles, apps } from '@kortix/db';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { config } from '../config';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { getSupabase } from '../shared/supabase';
import { APP_ARTIFACT_BUCKET } from './artifacts';
import { releaseDeploymentImages, teardownAppRuntimes } from './images';

/** Which ready deployments to retire: all but the active one and the newest `keep` others. */
export function deploymentsToRetire(
  ready: Array<{ deploymentId: string; version: number }>,
  activeDeploymentId: string | null,
  keep: number,
): string[] {
  return [...ready]
    .sort((a, b) => b.version - a.version)
    .filter((deployment) => deployment.deploymentId !== activeDeploymentId)
    .slice(keep)
    .map((deployment) => deployment.deploymentId);
}

/** Free everything a set of `deleted` deployments still holds. Never throws for provider trouble. */
export async function releaseRetiredDeployments(deploymentIds: string[]): Promise<void> {
  if (deploymentIds.length === 0) return;
  await db.delete(appSiteFiles).where(inArray(appSiteFiles.deploymentId, deploymentIds));
  await db.delete(appDeploymentEvents).where(and(
    inArray(appDeploymentEvents.deploymentId, deploymentIds),
    eq(appDeploymentEvents.type, 'build_log'),
  ));
  const runtimes = await db
    .select({ runtimeId: appRuntimes.runtimeId, provider: appRuntimes.provider, externalId: appRuntimes.externalId })
    .from(appRuntimes)
    .where(and(inArray(appRuntimes.deploymentId, deploymentIds), ne(appRuntimes.status, 'deleted')));
  // Platinum refuses to delete an image while a sandbox pins it: runtimes first.
  await teardownAppRuntimes(runtimes);
  const images = await db
    .select({ deploymentId: appDeployments.deploymentId, hostingProvider: appDeployments.hostingProvider })
    .from(appDeployments)
    .where(inArray(appDeployments.deploymentId, deploymentIds));
  await releaseDeploymentImages(images);
}

/**
 * Retire an App's superseded ready deployments. Takes the App's deploy lock,
 * so it never races an activation, rollback or delete moving the live pointer.
 */
export async function retireSupersededDeployments(
  appId: string,
  keep = config.KORTIX_APPS_RETAINED_DEPLOYMENTS,
): Promise<string[]> {
  const retired = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${appId}))`);
    const [app] = await tx.select({ activeDeploymentId: apps.activeDeploymentId })
      .from(apps)
      .where(eq(apps.appId, appId))
      .for('update')
      .limit(1);
    if (!app) return [];
    const ready = await tx
      .select({ deploymentId: appDeployments.deploymentId, version: appDeployments.version })
      .from(appDeployments)
      .where(and(eq(appDeployments.appId, appId), eq(appDeployments.status, 'ready')))
      .orderBy(desc(appDeployments.version));
    const ids = deploymentsToRetire(ready, app.activeDeploymentId, keep);
    if (ids.length === 0) return [];
    const rows = await tx
      .update(appDeployments)
      .set({ status: 'deleted', updatedAt: new Date() })
      .where(and(inArray(appDeployments.deploymentId, ids), eq(appDeployments.status, 'ready')))
      .returning({ deploymentId: appDeployments.deploymentId });
    for (const row of rows) {
      await tx.insert(appDeploymentEvents).values({
        deploymentId: row.deploymentId,
        type: 'deployment_retired',
        message: `Retired: the App keeps its ${keep} newest earlier deployments for rollback`,
        data: { keep },
      });
    }
    return rows.map((row) => row.deploymentId);
  });
  await releaseRetiredDeployments(retired);
  return retired;
}

/**
 * Point an App at a ready deployment (rollback). Takes the same deploy lock
 * as retention, so the ready check reads after any retention that committed
 * first. Without the lock, the UPDATE waited on retention's row lock and then
 * checked the target with its old snapshot, and could move traffic to a
 * deployment retention had just retired. Returns null when the target is not
 * ready (anymore).
 */
export async function rollBackActiveDeployment(appId: string, deploymentId: string) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${appId}))`);
    const [target] = await tx.select({ deploymentId: appDeployments.deploymentId })
      .from(appDeployments)
      .where(and(
        eq(appDeployments.deploymentId, deploymentId),
        eq(appDeployments.appId, appId),
        eq(appDeployments.status, 'ready'),
      ))
      .limit(1);
    if (!target) return null;
    const [row] = await tx.update(apps)
      .set({ activeDeploymentId: deploymentId, desiredState: 'running', updatedAt: new Date() })
      .where(eq(apps.appId, appId))
      .returning();
    return row ?? null;
  });
}

const SWEEP_APPS = 50;
const ARTIFACT_GRACE = '24 hours';
const ARTIFACT_BATCH = 100;

/**
 * Maintenance: apply retention to every App that has more ready deployments
 * than it keeps (catches up Apps deployed before retention existed), drop the
 * static files of every dead deployment (a deleted App's included), and
 * delete unused archives.
 */
export async function sweepAppRetention(keep = config.KORTIX_APPS_RETAINED_DEPLOYMENTS): Promise<{
  apps: number;
  retired: number;
  siteFilesReleased: number;
  artifacts: number;
}> {
  const over = await db
    .select({ appId: appDeployments.appId })
    .from(appDeployments)
    .innerJoin(apps, eq(apps.appId, appDeployments.appId))
    .where(and(eq(appDeployments.status, 'ready'), sql`${apps.deletedAt} is null`))
    .groupBy(appDeployments.appId)
    .having(sql`count(*) > ${keep + 1}`)
    .limit(SWEEP_APPS);
  let retired = 0;
  for (const { appId } of over) {
    retired += (await retireSupersededDeployments(appId, keep).catch((error) => {
      logger.error('[apps] retention sweep failed for an App', { appId, error: String(error) });
      return [];
    })).length;
  }

  const deadFiles = await db.execute(sql`
    delete from ${appSiteFiles}
    where ${appSiteFiles.deploymentId} in (
      select d.deployment_id from ${appDeployments} d
      join ${apps} a on a.app_id = d.app_id
      where a.deleted_at is not null or d.status in ('deleted', 'failed', 'cancelled')
      limit 50
    )`);

  const artifacts = await reclaimAppArtifacts();
  return {
    apps: over.length,
    retired,
    siteFilesReleased: Number((deadFiles as unknown as { count?: number }).count ?? 0),
    artifacts,
  };
}

/**
 * Delete archives no live deployment uses. A live deployment (queued through
 * ready, the active one included: a runtime refresh rebuilds from its archive)
 * protects its archive; the grace only protects a fresh upload not yet deployed.
 */
export async function reclaimAppArtifacts(): Promise<number> {
  const unused = await db
    .select({ artifactId: appArtifacts.artifactId, objectPath: appArtifacts.objectPath })
    .from(appArtifacts)
    .where(sql`${appArtifacts.kind} = 'archive'
      and ${appArtifacts.status} in ('uploading', 'uploaded', 'ready', 'rejected')
      and ${appArtifacts.updatedAt} < now() - ${ARTIFACT_GRACE}::interval
      and not exists (
        select 1 from ${appDeployments} d join ${apps} a on a.app_id = d.app_id
        where d.artifact_id = ${appArtifacts.artifactId}
          and a.deleted_at is null
          and d.status not in ('deleted', 'failed', 'cancelled')
      )`)
    .limit(ARTIFACT_BATCH);
  if (unused.length === 0) return 0;
  const paths = unused.map((artifact) => artifact.objectPath).filter((path): path is string => !!path);
  if (paths.length > 0) {
    const { error } = await getSupabase().storage.from(APP_ARTIFACT_BUCKET).remove(paths);
    if (error) {
      logger.warn('[apps] artifact object removal failed; the next sweep retries', { error: error.message });
      return 0;
    }
  }
  await db
    .update(appArtifacts)
    .set({ status: 'deleted', updatedAt: new Date() })
    .where(inArray(appArtifacts.artifactId, unused.map((artifact) => artifact.artifactId)));
  return unused.length;
}
