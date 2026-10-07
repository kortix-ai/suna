/**
 * App deployment images — the provider templates server App deployments run
 * from (`deployment-worker.ts`). Two name shapes exist:
 *   - legacy `kortix-app-<deploymentId-no-dashes>`: one per deployment, minted
 *     by every build before shared images existed;
 *   - shared `kortix-appimg-<env>-<key>`: one per set of build inputs (below).
 *
 * Providers cap how many templates an org may hold: Platinum refuses builds
 * past its per-org template count (`org_template_quota_exceeded`, tiers
 * 10/50/500), and `snapshots/quota-gc.ts` reclaims Daytona only. A build that
 * hits the cap reclaims unused images once and retries once
 * (`buildWithImageQuotaGuard`); a second refusal fails the deployment with
 * `app_image_quota_exceeded` instead of three retries on a backoff.
 *
 * A legacy image is reclaimable only when its deployment can never serve again:
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
 *
 * Shared images (`kortix-appimg-<env>-<key>`, every build since they exist).
 * The name is a hash of everything that changes the image (`appImageName`):
 * environment, account, provider, artifact digest, source spec, Dockerfile,
 * runtime spec, machine, and the image part of the App runtime version.
 * Environment variables and secrets are runtime-only and stay out of it, so an
 * env-only redeploy, an unchanged redeploy and a retry reuse the image instead
 * of minting a template each. `kortix.app_images` holds one row per image from
 * its first build until the provider deletes it. The deployments that use an
 * image are the ones whose `provider_build_id` names it; usage is counted by
 * query (`appImageInUseSql`), never stored. Claim (`claimAppImage`) and release
 * (`releaseAppImage`) take the same advisory lock per image name, so a release
 * never deletes an image a deployment has just claimed.
 *
 * Known limit: a reused image is not probed at the provider first. An image
 * deleted outside Kortix fails the runtime create; delete the deployments that
 * use it and deploy again.
 */
import { createHash } from 'node:crypto';
import { appDeployments, appImages, appRuntimes, apps } from '@kortix/db';
import { and, eq, inArray, isNotNull, ne, notExists, or, sql, type SQL } from 'drizzle-orm';
import { pauseComputeSession } from '../billing/services/compute-metering';
import { config, type SandboxProviderName } from '../config';
import { logger } from '../lib/logger';
import { getProvider, type SandboxProvider } from '../platform/providers';
import { db } from '../shared/db';
import { mapWithConcurrency } from '../shared/map-with-concurrency';
import { getSandboxProvider } from '../snapshots/providers';
import { classifySnapshotError } from '../snapshots/error-classify';
import { SnapshotInUseError } from '../snapshots/providers/errors';
import {
  APP_DEPLOYMENT_PREFIX,
  APP_IMAGE_PREFIX,
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
  /** The image the deployment built or reused. A legacy deployment names its own. */
  providerBuildId?: string | null;
}

/** Everything that changes a built App image. Runtime env and secrets are not in it. */
export interface AppImageInputs {
  /** `INTERNAL_KORTIX_ENV` plus the public API origin: environments share a provider org, not a database. */
  environment: string;
  accountId: string;
  provider: string;
  /**
   * The artifact archive's SHA-256, or a digest-pinned OCI reference. Null when
   * the content can change under the same reference (an OCI tag): the image is
   * then never shared, so a redeploy pulls the tag again.
   */
  artifactDigest: string | null;
  deploymentId: string;
  source: unknown;
  dockerfile: string;
  runtimeSpec: unknown;
  machine: { cpuCores: number; memoryGb: number; diskGb: number };
  /** `appRuntimeImageKey(APP_RUNTIME_VERSION)`: the supervisor digest layered into the image. */
  runtimeImageKey: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The shared provider image name for a set of build inputs. */
export function appImageName(inputs: AppImageInputs): string {
  const { deploymentId, artifactDigest, environment, ...rest } = inputs;
  const key = createHash('sha256').update(canonicalJson({
    v: 1,
    environment,
    ...rest,
    artifact: artifactDigest ?? { unshared: deploymentId },
  })).digest('hex');
  const env = environment.split(':', 1)[0]!.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'env';
  return `${APP_IMAGE_PREFIX}${env}-${key.slice(0, 24)}`;
}

/** The OCI reference when its content cannot change (`@sha256:` digest), otherwise null. */
export function pinnedOciReference(reference: string | null | undefined): string | null {
  return reference && /@sha256:[0-9a-f]{64}$/i.test(reference) ? reference : null;
}

/** Deployment states that hold an image only while their worker lease is live. */
const IN_PROGRESS_STATUSES = ['queued', 'validating', 'building', 'provisioning', 'checking'];

/**
 * True while any deployment still needs the image: a live App's deployment that
 * can still serve (in progress, or a ready rollback target), any deployment
 * still being driven under a live lease (an App deleted mid-build included),
 * or any deployment whose runtime still exists (a sandbox pins its template).
 */
export function appImageInUseSql(imageName: string | SQL): SQL {
  return sql`exists (
    select 1 from ${appDeployments} d
    join ${apps} a on a.app_id = d.app_id
    where d.provider_build_id = ${imageName}
      and (
        (a.deleted_at is null and d.status not in ('failed', 'cancelled', 'deleted'))
        or (d.status in (${sql.join(IN_PROGRESS_STATUSES.map((status) => sql`${status}`), sql`, `)})
            and d.lease_expires_at > now())
        or exists (
          select 1 from ${appRuntimes} r
          where r.deployment_id = d.deployment_id and r.status <> 'deleted'
        )
      )
  )`;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockAppImage(tx: Tx, imageName: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`app-image:${imageName}`}))`);
}

/**
 * - `reuse`: the image is built; the deployment now uses it.
 * - `build`: the deployment now owns the build of this image.
 * - `wait`: another deployment builds it under a live lease; ask again later.
 */
export type AppImageClaim = 'reuse' | 'build' | 'wait';

/**
 * Decide whether a deployment builds, reuses, or waits for an image, and
 * record the use (`provider_build_id`) in the same transaction. Fails when the
 * deployment lease moved to another worker.
 */
export async function claimAppImage(input: {
  imageName: string;
  provider: string;
  deploymentId: string;
  leaseOwner: string;
}): Promise<AppImageClaim> {
  return db.transaction(async (tx) => {
    await lockAppImage(tx, input.imageName);
    const [image] = await tx.select({ status: appImages.status })
      .from(appImages)
      .where(eq(appImages.imageName, input.imageName))
      .limit(1);
    let claim: AppImageClaim;
    if (image?.status === 'ready') {
      claim = 'reuse';
      await tx.update(appImages).set({ updatedAt: new Date() }).where(eq(appImages.imageName, input.imageName));
    } else if (image) {
      const [builder] = await tx.select({ deploymentId: appDeployments.deploymentId })
        .from(appDeployments)
        .where(and(
          eq(appDeployments.providerBuildId, input.imageName),
          eq(appDeployments.status, 'building'),
          ne(appDeployments.deploymentId, input.deploymentId),
          sql`${appDeployments.leaseExpiresAt} > now()`,
        ))
        .limit(1);
      claim = builder ? 'wait' : 'build';
    } else {
      claim = 'build';
      await tx.insert(appImages).values({ imageName: input.imageName, provider: input.provider, status: 'building' });
    }
    if (claim === 'wait') return claim;
    const rows = await tx.update(appDeployments)
      .set({ providerBuildId: input.imageName, updatedAt: new Date() })
      .where(and(
        eq(appDeployments.deploymentId, input.deploymentId),
        eq(appDeployments.leaseOwner, input.leaseOwner),
      ))
      .returning({ deploymentId: appDeployments.deploymentId });
    if (rows.length === 0) throw new Error(`lost deployment lease ${input.deploymentId}`);
    return claim;
  });
}

/** Record a finished build. Inserts the row if a release removed it mid-build. */
export async function markAppImageReady(imageName: string, provider: string, now = new Date()): Promise<void> {
  await db.insert(appImages)
    .values({ imageName, provider, status: 'ready', readyAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: appImages.imageName,
      set: { status: 'ready', readyAt: now, updatedAt: now },
    });
}

/**
 * Delete one shared image when no deployment uses it. Holds the image lock
 * across the provider delete, so a concurrent claim waits and then builds
 * afresh instead of reusing an image being deleted. Never throws.
 * `none`: another deployment still uses it, or its provider is not configured.
 */
export async function releaseAppImage(
  image: { imageName: string; provider: string },
  resolve: (provider: string) => AppImageProvider = getSandboxProvider,
): Promise<AppImageReleaseOutcome> {
  const adapter = imageProvider(image.provider, resolve);
  if (!adapter) return 'none';
  try {
    return await db.transaction(async (tx) => {
      await lockAppImage(tx, image.imageName);
      const [usage] = await tx.execute(sql`select ${appImageInUseSql(image.imageName)} as in_use`) as unknown as Array<{ in_use: boolean }>;
      if (usage?.in_use) return 'none' as const;
      await adapter.deleteSnapshot(image.imageName);
      await tx.delete(appImages).where(eq(appImages.imageName, image.imageName));
      return 'released' as const;
    });
  } catch (error) {
    if (!(error instanceof SnapshotInUseError)) {
      logger.warn('[apps] shared image release failed; maintenance retries it', {
        imageName: image.imageName,
        provider: image.provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return 'pending';
  }
}

/** The provider refused a build because the org holds its maximum number of templates. */
export class AppImageQuotaExceededError extends Error {
  readonly code = 'app_image_quota_exceeded';
  constructor(provider: string, providerMessage: string) {
    super(
      `The ${provider} template quota for this organization is full, and reclaiming unused App images freed no room. `
      + 'Delete unused Apps or deployments, or raise the provider template quota, then deploy again. '
      + `Provider: ${providerMessage.slice(0, 300)}`,
    );
    this.name = 'AppImageQuotaExceededError';
  }
}

/**
 * Run a build. When the provider refuses it for its template quota, reclaim
 * unused App images once and retry once. A second quota refusal throws
 * `AppImageQuotaExceededError`: retrying on a backoff only restates it.
 */
export async function buildWithImageQuotaGuard(input: {
  provider: string;
  build: () => Promise<void>;
  reclaim: () => Promise<unknown>;
  onReclaim?: (providerMessage: string) => Promise<void>;
}): Promise<void> {
  const isQuota = (error: unknown) => classifySnapshotError(error instanceof Error ? error.message : String(error)) === 'quota';
  try {
    await input.build();
    return;
  } catch (error) {
    if (!isQuota(error)) throw error;
    await input.onReclaim?.(error instanceof Error ? error.message : String(error));
  }
  await input.reclaim();
  try {
    await input.build();
  } catch (error) {
    if (isQuota(error)) {
      throw new AppImageQuotaExceededError(input.provider, error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
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

/**
 * Delete one deployment's image. A shared image goes only when no other
 * deployment uses it; while one does, this deployment's outcome is `none`.
 * Never throws.
 */
export async function releaseDeploymentImage(
  deployment: AppImageDeployment,
  resolve: (provider: string) => AppImageProvider = getSandboxProvider,
): Promise<AppImageReleaseOutcome> {
  if (!deployment.hostingProvider) return 'none';
  if (deployment.providerBuildId?.startsWith(APP_IMAGE_PREFIX)) {
    return releaseAppImage({ imageName: deployment.providerBuildId, provider: deployment.hostingProvider }, resolve);
  }
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
  // Deployments that share an image release it once.
  const seen = new Set<string>();
  const queue = deployments.filter((deployment) => {
    if (!deployment.hostingProvider) return false;
    const shared = deployment.providerBuildId?.startsWith(APP_IMAGE_PREFIX)
      ? `${deployment.hostingProvider}:${deployment.providerBuildId}`
      : null;
    if (!shared) return true;
    if (seen.has(shared)) return false;
    seen.add(shared);
    return true;
  });
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
  /** Shared images this environment tracks that no deployment uses. */
  loadUnusedImages(limit: number): Promise<Array<{ imageName: string; provider: string }>>;
  releaseImage(image: { imageName: string; provider: string }): Promise<AppImageReleaseOutcome>;
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
  async loadUnusedImages(limit) {
    return db
      .select({ imageName: appImages.imageName, provider: appImages.provider })
      .from(appImages)
      .where(sql`not ${appImageInUseSql(sql`${appImages.imageName}`)}`)
      .orderBy(appImages.updatedAt)
      .limit(limit);
  },
  releaseImage: (image) => releaseAppImage(image),
};

export interface AppImageReclaimResult {
  /** Configured providers whose image list was read. */
  providers: number;
  /** `kortix-app-` images found across those providers. */
  listed: number;
  /**
   * Images this environment may delete now: listed legacy images, plus the
   * shared images it tracks that no deployment uses (read up to maxPerPass + 1).
   */
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

  // Shared images: tracked in this database, so no provider listing is needed.
  try {
    const unused = await io.loadUnusedImages(maxPerPass + 1);
    result.reclaimable += unused.length;
    result.deferred += Math.max(0, unused.length - maxPerPass);
    for (const image of unused.slice(0, maxPerPass)) {
      const outcome = await io.releaseImage(image);
      if (outcome === 'released') result.released += 1;
      else if (outcome === 'pending') result.pending += 1;
    }
  } catch (error) {
    result.errors += 1;
    logger.warn('[apps] image reclaim: shared image lookup failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (result.released || result.pending || result.runtimesRemoved || result.errors) {
    logger.info('[apps] image reclaim', { ...result });
  }
  return result;
}
