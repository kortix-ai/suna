import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appArtifacts,
  appDeploymentEvents,
  appDeployments,
  appRuntimes,
  apps,
} from '@kortix/db';
import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { pauseComputeSession, startComputeSession } from '../billing/services/compute-metering';
import { config, SANDBOX_VERSION, type SandboxProviderName } from '../config';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { runWorkerTick } from '../shared/audit-scope';
import { auditDeploymentOutcome, type DeploymentAuditRef } from './deployment-audit';
import { listResolvedProjectSecrets } from '../projects/secrets';
import { downloadAppArtifact, extractAppArchive } from './artifacts';
import { resolveAppRuntimeEnvironment } from './environment';
import { APP_VIEWER_SECRET_ENV, appViewerSecret } from './viewer';
import { createBuildLog } from './build-log';
import { AppHostingProvider } from './hosting';
import { normalizeAppBuild, type AppSourceSpec } from './spec';
import { publishStaticSite, staticHostingEnabled } from './static-site';
import { retireSupersededDeployments } from './retention';
import { AppBudgetExceededError, alwaysOnBudgetWarning } from './budget';
import { AppAccountUnfundedError, AppLimitError, assertAppComputeAllowed } from './limits';
import { appRuntimeArtifactDigest } from './runtime-artifacts';
import { appDeploymentFailureDisposition } from './deployment-failures';
import { appDeploymentSnapshotName } from '../snapshots/quota-gc-select';
import { exponentialBackoffMs } from '../shared/backoff';

export const APP_RUNTIME_VERSION =
  process.env.KORTIX_APP_RUNTIME_VERSION
  || `${SANDBOX_VERSION}:appd-${appRuntimeArtifactDigest().slice(0, 16)}`;
const LEASE_MS = 2 * 60_000;
const HEARTBEAT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const LIVE_DEPLOYMENT_STATUSES = [
  'queued',
  'validating',
  'building',
  'provisioning',
  'checking',
] as const;

type ClaimedDeployment = typeof appDeployments.$inferSelect;

/**
 * The part of a runtime version that changes the App image: the supervisor
 * digest (`appd-<digest>`, which covers appd and caddy). The `SANDBOX_VERSION`
 * prefix changes on every API release and changes nothing in the image, so it
 * never triggers a refresh. A change to what `stageAppBuildContext` layers
 * into the image must change this key too.
 */
export function appRuntimeImageKey(runtimeVersion: string | null): string {
  if (!runtimeVersion) return '';
  const at = runtimeVersion.indexOf('appd-');
  return at >= 0 ? runtimeVersion.slice(at) : runtimeVersion;
}

/**
 * Failures a rebuild of the same artifact on the same image key repeats
 * exactly. Any other failure (provider, quota, timeout, a budget or
 * concurrency refusal) may pass on a later try.
 */
const DETERMINISTIC_REFRESH_FAILURES = new Set([
  'invalid_site', 'invalid_spec', 'invalid_environment', 'artifact_missing', 'artifact_not_uploaded',
  'artifact_kind', 'digest_mismatch', 'size_mismatch', 'dockerfile_build_failed',
  'runtime_artifact_missing', 'source_access_failed',
]);
/** A refresh that failed for a reason that may pass is retried at most once per hour. */
export const REFRESH_RETRY_AFTER_MS = 60 * 60_000;

/**
 * Queue one immutable rebuild when a cold runtime uses an older App supervisor.
 * The current deployment keeps serving while the replacement builds. The normal
 * activation transaction moves traffic only after the replacement is ready.
 *
 * A refresh that failed is not queued again for the same artifact and image
 * key: never after a deterministic failure, and not within
 * `REFRESH_RETRY_AFTER_MS` after any other. Before this, every cold start and
 * every keep-alive pass queued another doomed build.
 */
export async function enqueueCurrentAppRuntime(
  app: typeof apps.$inferSelect,
  deployment: typeof appDeployments.$inferSelect,
  now = new Date(),
): Promise<boolean> {
  // A static App still running in a sandbox moves to static hosting the same
  // way a stale supervisor is replaced: one queued redeploy of the same
  // artifact, activated only once it is ready.
  const toStatic = staticHostingEnabled() && deployment.sourceKind === 'static' && deployment.hostingType === 'sandbox';
  const imageKey = appRuntimeImageKey(APP_RUNTIME_VERSION);
  if (appRuntimeImageKey(deployment.runtimeVersion) === imageKey && !toStatic) return false;
  const inserted = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${app.appId}))`);
    const [existing] = await tx.select({ deploymentId: appDeployments.deploymentId })
      .from(appDeployments)
      .where(and(
        eq(appDeployments.appId, app.appId),
        eq(appDeployments.runtimeVersion, APP_RUNTIME_VERSION),
        inArray(appDeployments.status, ['queued', 'validating', 'building', 'provisioning', 'checking']),
      ))
      .limit(1);
    if (existing) return false;
    const [lastRefresh] = await tx.select({
      status: appDeployments.status,
      errorCode: appDeployments.errorCode,
      failedAt: appDeployments.failedAt,
      runtimeVersion: appDeployments.runtimeVersion,
    })
      .from(appDeployments)
      .where(and(
        eq(appDeployments.appId, app.appId),
        eq(appDeployments.artifactId, deployment.artifactId),
        eq(appDeployments.actorType, 'system'),
      ))
      .orderBy(desc(appDeployments.version))
      .limit(1);
    if (
      lastRefresh?.status === 'failed' &&
      appRuntimeImageKey(lastRefresh.runtimeVersion) === imageKey &&
      (DETERMINISTIC_REFRESH_FAILURES.has(lastRefresh.errorCode ?? '') ||
        !lastRefresh.failedAt ||
        now.getTime() - lastRefresh.failedAt.getTime() < REFRESH_RETRY_AFTER_MS)
    ) return false;
    const [latest] = await tx.select({ version: appDeployments.version })
      .from(appDeployments)
      .where(eq(appDeployments.appId, app.appId))
      .orderBy(desc(appDeployments.version))
      .limit(1);
    await tx.insert(appDeployments).values({
      appId: app.appId,
      artifactId: deployment.artifactId,
      version: (latest?.version ?? 0) + 1,
      status: 'queued',
      sourceKind: deployment.sourceKind,
      hostingType: deployment.hostingType,
      hostingProvider: deployment.hostingProvider,
      runtimeSpec: {},
      buildSpec: deployment.buildSpec,
      runtimeVersion: APP_RUNTIME_VERSION,
      createdBy: deployment.createdBy,
      sourceSessionId: null,
      actorType: 'system',
    });
    return true;
  });
  if (inserted) triggerAppDeploymentWorker();
  return inserted;
}

class PermanentAppDeploymentError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'PermanentAppDeploymentError';
  }
}

/**
 * A worker that dies mid-drive (OOM, SIGKILL) never reaches `recordDeploymentFailure`,
 * so the cap there cannot count that attempt. The claim counts it instead: once the
 * lease lapses the row is claimed again with `attemptCount` past the cap, and the
 * drive fails it for good rather than building a fourth time.
 */
export function attemptsExhausted(attemptCount: number): boolean {
  return attemptCount > MAX_ATTEMPTS;
}

function retryDelayMs(attempt: number): number {
  return exponentialBackoffMs({ attempt, baseMs: 2_000, capMs: 60_000 });
}

async function event(
  deploymentId: string,
  type: string,
  message: string,
  input: {
    runtimeId?: string;
    level?: 'debug' | 'info' | 'warn' | 'error';
    data?: Record<string, unknown>;
  } = {},
): Promise<void> {
  await db.insert(appDeploymentEvents).values({
    deploymentId,
    runtimeId: input.runtimeId,
    level: input.level ?? 'info',
    type,
    message,
    data: input.data ?? {},
  });
}

/**
 * `KORTIX_APPS_WORKER_ENABLED=static`: drive only static deployments, which
 * need no sandbox provider. For an operator who hosts static Apps without one,
 * and for the local test profile, whose providers are unreachable on purpose.
 */
function staticOnlyWorker(): boolean {
  return config.KORTIX_APPS_WORKER_ENABLED === 'static';
}

export async function claimAppDeployment(
  owner: string,
  now = new Date(),
): Promise<ClaimedDeployment | null> {
  const [candidate] = await db
    .select()
    .from(appDeployments)
    .where(
      and(
        inArray(appDeployments.status, [...LIVE_DEPLOYMENT_STATUSES]),
        staticOnlyWorker() ? eq(appDeployments.sourceKind, 'static') : undefined,
        or(isNull(appDeployments.nextAttemptAt), lte(appDeployments.nextAttemptAt, now)),
        or(isNull(appDeployments.leaseExpiresAt), lt(appDeployments.leaseExpiresAt, now)),
      ),
    )
    .orderBy(asc(appDeployments.createdAt))
    .limit(1);
  if (!candidate) return null;

  const [claimed] = await db
    .update(appDeployments)
    .set({
      leaseOwner: owner,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      attemptCount: candidate.attemptCount + 1,
      startedAt: candidate.startedAt ?? now,
      updatedAt: now,
    })
    .where(
      and(
        eq(appDeployments.deploymentId, candidate.deploymentId),
        inArray(appDeployments.status, [...LIVE_DEPLOYMENT_STATUSES]),
        or(isNull(appDeployments.leaseExpiresAt), lt(appDeployments.leaseExpiresAt, now)),
      ),
    )
    .returning();
  return claimed ?? null;
}

async function renewLease(deploymentId: string, owner: string): Promise<void> {
  const rows = await db
    .update(appDeployments)
    .set({ leaseExpiresAt: new Date(Date.now() + LEASE_MS), updatedAt: new Date() })
    .where(
      and(
        eq(appDeployments.deploymentId, deploymentId),
        eq(appDeployments.leaseOwner, owner),
        inArray(appDeployments.status, [...LIVE_DEPLOYMENT_STATUSES]),
      ),
    )
    .returning({ deploymentId: appDeployments.deploymentId });
  if (rows.length === 0) throw new Error(`lost deployment lease ${deploymentId}`);
}

async function setDeploymentStatus(
  deploymentId: string,
  owner: string,
  status: ClaimedDeployment['status'],
  patch: Partial<typeof appDeployments.$inferInsert> = {},
): Promise<void> {
  const rows = await db
    .update(appDeployments)
    .set({ status, updatedAt: new Date(), ...patch })
    .where(
      and(
        eq(appDeployments.deploymentId, deploymentId),
        eq(appDeployments.leaseOwner, owner),
      ),
    )
    .returning({ deploymentId: appDeployments.deploymentId });
  if (rows.length === 0) throw new Error(`lost deployment lease ${deploymentId}`);
}

function selectedProvider(value: string | null): SandboxProviderName {
  const provider = (value ?? config.getDefaultProvider()) as SandboxProviderName;
  if (!config.ALLOWED_SANDBOX_PROVIDERS.includes(provider)) {
    throw new PermanentAppDeploymentError(`Hosting provider ${provider} is disabled`, 'provider_disabled');
  }
  return provider;
}

async function deploymentContext(deploymentId: string) {
  const [deployment] = await db
    .select()
    .from(appDeployments)
    .where(eq(appDeployments.deploymentId, deploymentId))
    .limit(1);
  if (!deployment) throw new PermanentAppDeploymentError('Deployment no longer exists', 'not_found');
  const [app] = await db.select().from(apps).where(eq(apps.appId, deployment.appId)).limit(1);
  if (!app || app.deletedAt) throw new PermanentAppDeploymentError('App no longer exists', 'not_found');
  const [artifact] = await db
    .select()
    .from(appArtifacts)
    .where(eq(appArtifacts.artifactId, deployment.artifactId))
    .limit(1);
  if (!artifact) throw new PermanentAppDeploymentError('Artifact no longer exists', 'artifact_missing');
  return { deployment, app, artifact };
}

async function activateDeployment(input: {
  appId: string;
  deploymentId: string;
  /** Null for a static deployment: it has no runtime. */
  runtimeId: string | null;
  owner: string;
}): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ activeDeploymentId: apps.activeDeploymentId })
      .from(apps)
      .where(eq(apps.appId, input.appId))
      .limit(1);
    const previous = current?.activeDeploymentId ?? null;
    const now = new Date();
    const updated = await tx
      .update(appDeployments)
      .set({
        status: 'ready',
        readyAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(appDeployments.deploymentId, input.deploymentId),
          eq(appDeployments.leaseOwner, input.owner),
          eq(appDeployments.status, 'checking'),
        ),
      )
      .returning({ deploymentId: appDeployments.deploymentId });
    if (updated.length === 0) throw new Error(`lost deployment lease ${input.deploymentId}`);
    if (input.runtimeId) {
      await tx
        .update(appRuntimes)
        .set({ status: 'running', startedAt: now, updatedAt: now })
        .where(eq(appRuntimes.runtimeId, input.runtimeId));
    }
    await tx
      .update(apps)
      .set({ activeDeploymentId: input.deploymentId, desiredState: 'running', updatedAt: now })
      .where(eq(apps.appId, input.appId));
    return previous;
  });
}

async function stopPreviousRuntime(
  hosting: AppHostingProvider,
  previousDeploymentId: string | null,
): Promise<void> {
  if (!previousDeploymentId) return;
  const [runtime] = await db
    .select()
    .from(appRuntimes)
    .where(
      and(
        eq(appRuntimes.deploymentId, previousDeploymentId),
        inArray(appRuntimes.status, ['provisioning', 'starting', 'running']),
      ),
    )
    .limit(1);
  if (!runtime) return;
  await hosting.stop(runtime.provider as SandboxProviderName, runtime.externalId);
  const now = new Date();
  await db
    .update(appRuntimes)
    .set({ status: 'stopped', stoppedAt: now, updatedAt: now })
    .where(eq(appRuntimes.runtimeId, runtime.runtimeId));
  await pauseComputeSession(runtime.runtimeId, now);
}

/** The audit reference for a deployment whose context never loaded. */
async function deploymentAuditRefFor(claimed: ClaimedDeployment): Promise<DeploymentAuditRef | null> {
  try {
    const [app] = await db
      .select({ accountId: apps.accountId, projectId: apps.projectId })
      .from(apps)
      .where(eq(apps.appId, claimed.appId))
      .limit(1);
    if (!app) return null;
    return {
      appId: claimed.appId,
      deploymentId: claimed.deploymentId,
      accountId: app.accountId,
      projectId: app.projectId,
      createdBy: claimed.createdBy,
    };
  } catch {
    return null;
  }
}

/**
 * What a drive created before a throw. The failure path and the `finally`
 * read it, so every step records a resource the moment it exists.
 */
interface DeploymentDriveState {
  runtimeId: string | null;
  runtimeExternalId: string | null;
  runtimeProvider: SandboxProviderName | null;
  temporaryRoot: string | null;
  auditRef: DeploymentAuditRef | null;
}

type DeploymentContext = Awaited<ReturnType<typeof deploymentContext>>;
type RequestedMachine = { cpuCores: number; memoryGb: number; diskGb: number };

export async function driveAppDeployment(
  claimed: ClaimedDeployment,
  owner: string,
  hosting = new AppHostingProvider(),
): Promise<void> {
  const heartbeat = setInterval(() => {
    void renewLease(claimed.deploymentId, owner).catch((error) => {
      logger.error('[apps] deployment lease heartbeat failed', {
        deploymentId: claimed.deploymentId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, HEARTBEAT_MS);
  const state: DeploymentDriveState = {
    runtimeId: null,
    runtimeExternalId: null,
    runtimeProvider: null,
    temporaryRoot: null,
    auditRef: null,
  };
  try {
    if (attemptsExhausted(claimed.attemptCount)) {
      // The dead attempt may have left a live runtime; the failure path below
      // closes its compute window and removes it.
      const [orphan] = await db
        .select()
        .from(appRuntimes)
        .where(
          and(
            eq(appRuntimes.deploymentId, claimed.deploymentId),
            inArray(appRuntimes.status, ['provisioning', 'starting', 'running']),
          ),
        )
        .limit(1);
      if (orphan) {
        state.runtimeId = orphan.runtimeId;
        state.runtimeExternalId = orphan.externalId;
        state.runtimeProvider = orphan.provider as SandboxProviderName;
      }
      throw new PermanentAppDeploymentError(
        `The deployment worker stopped ${MAX_ATTEMPTS} times while driving this deployment`,
        'attempts_exhausted',
      );
    }
    const context = await deploymentContext(claimed.deploymentId);
    const auditRef: DeploymentAuditRef = {
      appId: context.app.appId,
      deploymentId: claimed.deploymentId,
      accountId: context.app.accountId,
      projectId: context.app.projectId,
      createdBy: claimed.createdBy,
    };
    state.auditRef = auditRef;
    if (staticHostingEnabled() && (context.deployment.buildSpec as { source?: { kind?: string } }).source?.kind === 'static') {
      await driveStaticDeployment({ claimed, owner, hosting, context, auditRef, state });
      return;
    }
    const provider = selectedProvider(context.deployment.hostingProvider);
    state.runtimeProvider = provider;
    await setDeploymentStatus(claimed.deploymentId, owner, 'validating', {
      hostingProvider: provider,
      error: null,
      errorCode: null,
    });
    await event(claimed.deploymentId, 'validation_started', 'Validating App artifact');

    const sourceDir = await prepareDeploymentSource(context, state);
    const { rawBuildSpec, source, normalized, runtimeEnvironment } = await resolveDeploymentBuild(context, sourceDir);
    await assertDeploymentComputeAllowed(context);
    const { snapshotName, requestedMachine } = await buildDeploymentImage({
      claimed,
      owner,
      hosting,
      context,
      provider,
      rawBuildSpec,
      source,
      normalized,
    });

    // A build takes minutes; the App can be deleted meanwhile. Never start a
    // runtime (and its compute meter) for a deleted App. Its image is
    // reclaimed by project maintenance (`reclaimAppDeploymentImages`).
    const [stillLive] = await db.select({ appId: apps.appId }).from(apps)
      .where(and(eq(apps.appId, context.app.appId), isNull(apps.deletedAt)))
      .limit(1);
    if (!stillLive) throw new PermanentAppDeploymentError('App was deleted during the build', 'not_found');

    await setDeploymentStatus(claimed.deploymentId, owner, 'provisioning');
    const { runtimeId, runtimeExternalId, runtimeProvider } = await provisionDeploymentRuntime({
      claimed,
      hosting,
      context,
      provider,
      snapshotName,
      requestedMachine,
      runtimeEnvironment,
      state,
    });

    await setDeploymentStatus(claimed.deploymentId, owner, 'checking');
    await hosting.waitUntilReady(runtimeProvider, runtimeExternalId, runtimeId);
    const previous = await activateDeployment({
      appId: context.app.appId,
      deploymentId: claimed.deploymentId,
      runtimeId,
      owner,
    });
    await event(claimed.deploymentId, 'deployment_activated', 'Deployment is serving traffic', {
      runtimeId,
      data: { previousDeploymentId: previous },
    });
    const budgetWarning = alwaysOnBudgetWarning(
      { ...context.app, ...hosting.effectiveMachine(runtimeProvider, requestedMachine) },
      runtimeProvider,
    );
    if (budgetWarning) {
      await event(claimed.deploymentId, budgetWarning.code, budgetWarning.message, {
        runtimeId,
        level: 'warn',
        data: { estimated_monthly_usd: budgetWarning.estimated_monthly_usd, monthly_budget_usd: budgetWarning.monthly_budget_usd },
      });
    }
    await auditDeploymentOutcome(auditRef, { outcome: 'activated', previousDeploymentId: previous });
    await stopPreviousRuntime(hosting, previous).catch((error) => {
      logger.error('[apps] previous runtime stop failed', {
        deploymentId: previous,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    await retireSupersededDeployments(context.app.appId).catch((error) => {
      logger.error('[apps] deployment retention failed', {
        appId: context.app.appId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    await recordDeploymentFailure({ claimed, owner, hosting, state, error });
  } finally {
    clearInterval(heartbeat);
    if (state.temporaryRoot) await rm(state.temporaryRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * A static deployment: validate and unpack the archive, publish its files to
 * content-addressed storage, then activate. No image, no runtime, no compute.
 */
async function driveStaticDeployment(input: {
  claimed: ClaimedDeployment;
  owner: string;
  hosting: AppHostingProvider;
  context: DeploymentContext;
  auditRef: DeploymentAuditRef;
  state: DeploymentDriveState;
}): Promise<void> {
  const { claimed, owner, hosting, context, auditRef, state } = input;
  await setDeploymentStatus(claimed.deploymentId, owner, 'validating', {
    hostingType: 'static',
    hostingProvider: null,
    error: null,
    errorCode: null,
  });
  await event(claimed.deploymentId, 'validation_started', 'Validating App artifact');
  const sourceDir = await prepareDeploymentSource(context, state);
  const { rawBuildSpec, source, normalized, runtimeEnvironment } = await resolveDeploymentBuild(context, sourceDir);
  if (Object.keys(runtimeEnvironment.env).length > 0) {
    await event(
      claimed.deploymentId,
      'environment_ignored',
      'A static App runs no server: its environment variables and secrets are not used',
      { level: 'warn' },
    );
  }
  await setDeploymentStatus(claimed.deploymentId, owner, 'building', {
    sourceKind: normalized.sourceKind,
    runtimeSpec: normalized.runtimeSpec,
    buildSpec: { ...rawBuildSpec, source, normalized: normalized.buildSpec },
    providerBuildId: null,
  });
  await event(claimed.deploymentId, 'site_publish_started', 'Publishing static files');
  const root = String((normalized.buildSpec as { root?: string }).root ?? '.');
  let published;
  try {
    published = await publishStaticSite({
      deploymentId: claimed.deploymentId,
      accountId: context.app.accountId,
      sourceDir: sourceDir!,
      root,
    });
  } catch (error) {
    // A file or layout problem in the artifact never fixes itself on retry.
    const message = error instanceof Error ? error.message : String(error);
    if (/static root|holds no files|at most|exceeds/.test(message)) {
      throw new PermanentAppDeploymentError(message, 'invalid_site');
    }
    throw error;
  }
  await event(
    claimed.deploymentId,
    'site_published',
    `Published ${published.files} files (${published.uploadedBlobs} new, ${published.reusedBlobs} unchanged)` +
      (published.skippedFiles ? `; left out ${published.skippedFiles} entries (.git, .env*, .DS_Store)` : ''),
    { data: { ...published } },
  );
  const [stillLive] = await db.select({ appId: apps.appId }).from(apps)
    .where(and(eq(apps.appId, context.app.appId), isNull(apps.deletedAt)))
    .limit(1);
  if (!stillLive) throw new PermanentAppDeploymentError('App was deleted during the build', 'not_found');
  await setDeploymentStatus(claimed.deploymentId, owner, 'checking');
  const previous = await activateDeployment({
    appId: context.app.appId,
    deploymentId: claimed.deploymentId,
    runtimeId: null,
    owner,
  });
  await event(claimed.deploymentId, 'deployment_activated', 'Deployment is serving traffic', {
    data: { previousDeploymentId: previous, hosting: 'static' },
  });
  await auditDeploymentOutcome(auditRef, { outcome: 'activated', previousDeploymentId: previous });
  await stopPreviousRuntime(hosting, previous).catch((error) => {
    logger.error('[apps] previous runtime stop failed', {
      deploymentId: previous,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  await retireSupersededDeployments(context.app.appId).catch((error) => {
    logger.error('[apps] deployment retention failed', {
      appId: context.app.appId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/** Download, verify and unpack an archive artifact. Returns its source directory (none for an OCI image). */
async function prepareDeploymentSource(
  context: DeploymentContext,
  state: DeploymentDriveState,
): Promise<string | undefined> {
  let sourceDir: string | undefined;
  if (context.artifact.kind === 'archive') {
    if (context.artifact.status !== 'uploaded' && context.artifact.status !== 'ready') {
      throw new PermanentAppDeploymentError(
        `Artifact is ${context.artifact.status}, expected uploaded`,
        'artifact_not_uploaded',
      );
    }
    if (!context.artifact.objectPath) {
      throw new PermanentAppDeploymentError('Archive artifact has no object path', 'artifact_missing');
    }
    state.temporaryRoot = await mkdtemp(join(tmpdir(), 'kortix-app-deployment-'));
    const archivePath = join(state.temporaryRoot, 'source.tar.gz');
    const downloaded = await downloadAppArtifact(context.artifact.objectPath, archivePath);
    if (context.artifact.sha256 && downloaded.sha256 !== context.artifact.sha256) {
      throw new PermanentAppDeploymentError('Artifact SHA-256 does not match finalization', 'digest_mismatch');
    }
    if (context.artifact.sizeBytes && downloaded.sizeBytes !== context.artifact.sizeBytes) {
      throw new PermanentAppDeploymentError('Artifact size does not match finalization', 'size_mismatch');
    }
    sourceDir = join(state.temporaryRoot, 'source');
    const inspection = await extractAppArchive(archivePath, sourceDir);
    await db
      .update(appArtifacts)
      .set({
        status: 'ready',
        sha256: downloaded.sha256,
        sizeBytes: downloaded.sizeBytes,
        metadata: { ...(context.artifact.metadata as object), inspection },
        updatedAt: new Date(),
      })
      .where(eq(appArtifacts.artifactId, context.artifact.artifactId));
  } else if (context.artifact.kind !== 'oci_image') {
    throw new PermanentAppDeploymentError(`Unsupported artifact kind ${context.artifact.kind}`, 'artifact_kind');
  }
  return sourceDir;
}

/** Normalize the build spec against the source and resolve the runtime environment. */
async function resolveDeploymentBuild(context: DeploymentContext, sourceDir: string | undefined) {
  const rawBuildSpec = context.deployment.buildSpec as Record<string, unknown>;
  const source = rawBuildSpec.source as AppSourceSpec | undefined;
  if (!source || typeof source !== 'object') {
    throw new PermanentAppDeploymentError('Deployment source specification is missing', 'invalid_spec');
  }
  let normalized;
  try {
    normalized = await normalizeAppBuild(source, sourceDir);
  } catch (error) {
    throw new PermanentAppDeploymentError(
      error instanceof Error ? error.message : String(error),
      'invalid_spec',
    );
  }

  const availableSecrets = await listResolvedProjectSecrets(
    context.app.projectId,
    context.deployment.createdBy,
  );
  let runtimeEnvironment;
  try {
    runtimeEnvironment = resolveAppRuntimeEnvironment({
      environment: (rawBuildSpec.environment ?? {}) as Record<string, string>,
      secrets: (rawBuildSpec.secrets ?? {}) as Record<string, string>,
      availableSecrets,
    });
  } catch (error) {
    throw new PermanentAppDeploymentError(
      error instanceof Error ? error.message : String(error),
      'invalid_environment',
    );
  }
  return { rawBuildSpec, source, normalized, runtimeEnvironment };
}

async function assertDeploymentComputeAllowed(context: DeploymentContext): Promise<void> {
  // Entitlement, concurrency and budget, before a build burns provider time.
  // A refusal here is permanent: the operator must fund the account, stop an
  // App, or raise the budget and then deploy again. Retrying three times on a
  // 30s backoff would only restate the same answer.
  try {
    await assertAppComputeAllowed(context.app);
  } catch (error) {
    if (error instanceof AppBudgetExceededError) {
      throw new PermanentAppDeploymentError(error.message, 'app_budget_exceeded');
    }
    if (error instanceof AppAccountUnfundedError) {
      throw new PermanentAppDeploymentError(error.message, 'account_unfunded');
    }
    if (error instanceof AppLimitError) {
      throw new PermanentAppDeploymentError(error.message, error.code);
    }
    throw error;
  }
}

async function buildDeploymentImage(input: {
  claimed: ClaimedDeployment;
  owner: string;
  hosting: AppHostingProvider;
  context: DeploymentContext;
  provider: SandboxProviderName;
  rawBuildSpec: Record<string, unknown>;
  source: AppSourceSpec;
  normalized: Awaited<ReturnType<typeof normalizeAppBuild>>;
}): Promise<{ snapshotName: string; requestedMachine: RequestedMachine }> {
  const { claimed, owner, hosting, context, provider, rawBuildSpec, source, normalized } = input;
  const snapshotName = appDeploymentSnapshotName(claimed.deploymentId);
  await setDeploymentStatus(claimed.deploymentId, owner, 'building', {
    sourceKind: normalized.sourceKind,
    runtimeSpec: normalized.runtimeSpec,
    buildSpec: { ...rawBuildSpec, source, normalized: normalized.buildSpec },
    providerBuildId: snapshotName,
  });
  await event(claimed.deploymentId, 'build_started', `Building ${snapshotName}`, {
    data: { provider },
  });
  const requestedMachine = {
    cpuCores: context.app.cpuCores,
    memoryGb: context.app.memoryGb,
    diskGb: context.app.diskGb,
  };
  const buildLog = createBuildLog(claimed.deploymentId);
  try {
    await hosting.buildImage({
      provider,
      snapshotName,
      slug: context.app.slug,
      sourceDir: normalized.sourceDir,
      dockerfile: normalized.dockerfile,
      runtimeSpec: normalized.runtimeSpec,
      machine: requestedMachine,
      logTap: { onLine: (line) => buildLog.line(line) },
    });
  } finally {
    // A failed build's last lines are the ones that say why: write them either way.
    await buildLog.close();
  }
  await event(claimed.deploymentId, 'build_ready', 'App image is ready', { data: { provider } });
  return { snapshotName, requestedMachine };
}

/** Restart the deployment's live runtime, or create one and open its compute window. */
async function provisionDeploymentRuntime(input: {
  claimed: ClaimedDeployment;
  hosting: AppHostingProvider;
  context: DeploymentContext;
  provider: SandboxProviderName;
  snapshotName: string;
  requestedMachine: RequestedMachine;
  runtimeEnvironment: ReturnType<typeof resolveAppRuntimeEnvironment>;
  state: DeploymentDriveState;
}): Promise<{ runtimeId: string; runtimeExternalId: string; runtimeProvider: SandboxProviderName }> {
  const { claimed, hosting, context, provider, snapshotName, requestedMachine, runtimeEnvironment, state } = input;
  const [existingRuntime] = await db
    .select()
    .from(appRuntimes)
    .where(
      and(
        eq(appRuntimes.deploymentId, claimed.deploymentId),
        inArray(appRuntimes.status, ['provisioning', 'starting', 'running']),
      ),
    )
    .limit(1);
  if (existingRuntime) {
    state.runtimeId = existingRuntime.runtimeId;
    state.runtimeExternalId = existingRuntime.externalId;
    state.runtimeProvider = existingRuntime.provider as SandboxProviderName;
    await hosting.start(state.runtimeProvider, state.runtimeExternalId);
    return {
      runtimeId: state.runtimeId,
      runtimeExternalId: state.runtimeExternalId,
      runtimeProvider: state.runtimeProvider,
    };
  }
  const runtimeId = randomUUID();
  state.runtimeId = runtimeId;
  const handle = await hosting.createRuntime({
    provider,
    runtimeId,
    accountId: context.app.accountId,
    userId: context.deployment.createdBy,
    name: `app-${context.app.routeKey}-v${context.deployment.version}`,
    snapshotName,
    machine: requestedMachine,
    alwaysOn: context.app.alwaysOn,
    // The App verifies `x-kortix-app-viewer` with this. Derived per App, so
    // it is not the platform secret and rotating the platform secret rotates
    // every App's. `KORTIX_*` is reserved from user-supplied env, so this
    // cannot be shadowed by a manifest value.
    envVars: {
      ...runtimeEnvironment.env,
      [APP_VIEWER_SECRET_ENV]: appViewerSecret(context.app.appId),
    },
  });
  state.runtimeExternalId = handle.externalId;
  const now = new Date();
  await db.insert(appRuntimes).values({
    runtimeId,
    deploymentId: claimed.deploymentId,
    accountId: context.app.accountId,
    provider,
    externalId: handle.externalId,
    status: 'starting',
    controlTokenHash: handle.controlTokenHash,
    idleDeadlineAt: new Date(now.getTime() + context.app.idleTimeoutSeconds * 1000),
    startedAt: now,
    metadata: {
      ...handle.metadata,
      secretIdentifiers: runtimeEnvironment.secretIdentifiers,
      environmentKeys: Object.keys(runtimeEnvironment.env).sort(),
    },
  });
  // Meter what the provider actually allocates. E2B has no disk parameter,
  // so charging this App's disk_gb there would bill storage nobody
  // provisioned. Tell the operator when the two differ instead of silently
  // accepting a specification the provider ignored.
  const effectiveMachine = hosting.effectiveMachine(provider, requestedMachine);
  if (
    effectiveMachine.cpuCores !== requestedMachine.cpuCores
    || effectiveMachine.memoryGb !== requestedMachine.memoryGb
    || effectiveMachine.diskGb !== requestedMachine.diskGb
  ) {
    await event(
      claimed.deploymentId,
      'machine_provider_adjusted',
      `${provider} does not enforce the full machine specification; billing meters what it allocates`,
      {
        runtimeId,
        level: 'warn',
        data: { requested: requestedMachine, effective: effectiveMachine },
      },
    );
  }
  await startComputeSession({
    sandboxId: runtimeId,
    accountId: context.app.accountId,
    actorUserId: context.deployment.createdBy,
    provider,
    spec: { ...effectiveMachine, gpuCount: 0 },
    workloadType: 'app',
    appRuntimeId: runtimeId,
    metadata: { deploymentId: claimed.deploymentId, appId: context.app.appId },
  });
  await event(claimed.deploymentId, 'runtime_created', 'App runtime created', {
    runtimeId,
    data: { provider, externalId: handle.externalId },
  });
  return { runtimeId, runtimeExternalId: handle.externalId, runtimeProvider: provider };
}

/** Release what the drive created, then requeue the deployment or fail it for good. */
async function recordDeploymentFailure(input: {
  claimed: ClaimedDeployment;
  owner: string;
  hosting: AppHostingProvider;
  state: DeploymentDriveState;
  error: unknown;
}): Promise<void> {
  const { claimed, owner, hosting, state, error } = input;
  const { runtimeId, runtimeExternalId, runtimeProvider, auditRef } = state;
  const message = error instanceof Error ? error.message : String(error);
  const disposition = appDeploymentFailureDisposition(message);
  const permanent = error instanceof PermanentAppDeploymentError || disposition.permanent;
  const errorCode = error instanceof PermanentAppDeploymentError
    ? error.code
    : disposition.code;
  const attempt = claimed.attemptCount;
  // Each cleanup step is independent; a failed one must not hide the next,
  // but it must be visible: an open compute window keeps billing, and a row
  // left 'starting' hides the runtime from the compute-invariant sweep.
  const cleanupFailed = (step: string) => (cleanupError: unknown) => {
    logger.error('[apps] failed-deploy cleanup step failed', {
      step,
      deploymentId: claimed.deploymentId,
      runtimeId,
      error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    });
  };
  if (runtimeId) {
    await db
      .update(appRuntimes)
      .set({ status: 'error', stoppedAt: new Date(), updatedAt: new Date() })
      .where(eq(appRuntimes.runtimeId, runtimeId))
      .catch(cleanupFailed('mark_runtime_error'));
    await pauseComputeSession(runtimeId).catch(cleanupFailed('close_compute_window'));
  }
  if (runtimeProvider && runtimeExternalId) {
    await hosting.remove(runtimeProvider, runtimeExternalId).catch(cleanupFailed('remove_runtime'));
  }
  const terminal = permanent || attempt >= MAX_ATTEMPTS;
  await db
    .update(appDeployments)
    .set({
      status: terminal ? 'failed' : 'queued',
      errorCode,
      error: message.slice(0, 8_000),
      failedAt: terminal ? new Date() : null,
      nextAttemptAt: terminal ? null : new Date(Date.now() + retryDelayMs(attempt)),
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(appDeployments.deploymentId, claimed.deploymentId),
        eq(appDeployments.leaseOwner, owner),
      ),
    );
  await event(claimed.deploymentId, terminal ? 'deployment_failed' : 'deployment_retry', message, {
    level: 'error',
    runtimeId: runtimeId ?? undefined,
    data: { attempt, terminal },
  }).catch(cleanupFailed('record_event'));
  if (terminal) {
    // A retry is not an outcome; only the terminal failure is audited.
    const ref = auditRef ?? (await deploymentAuditRefFor(claimed));
    if (ref) await auditDeploymentOutcome(ref, { outcome: 'failed', errorCode, attempt });
    return;
  }
}

let workerRunning = false;
let workerKickScheduled = false;
let workerRerunRequested = false;

function reportWorkerError(error: unknown): void {
  logger.error('[apps] deployment worker tick failed', {
    error: error instanceof Error ? error.message : String(error),
  });
}

function scheduleTriggeredTick(): void {
  if (workerRunning || workerKickScheduled) return;
  workerKickScheduled = true;
  queueMicrotask(() => {
    workerKickScheduled = false;
    workerRerunRequested = false;
    // A fresh worker context: the kick usually comes from a deploy request,
    // and the deployments this tick drives were queued by other principals.
    void runWorkerTick('app-deployments', runAppDeploymentTick).catch(reportWorkerError);
  });
}

/** Queue a deployment tick without waiting for the periodic worker interval. */
export function triggerAppDeploymentWorker(): void {
  if (process.env.KORTIX_APPS_WORKER_ENABLED === 'false') return;
  workerRerunRequested = true;
  scheduleTriggeredTick();
}

export async function runAppDeploymentTick(): Promise<{ processed: number }> {
  if (workerRunning) return { processed: 0 };
  workerRunning = true;
  const owner = `${config.INTERNAL_KORTIX_ENV}:${process.pid}:${randomUUID()}`;
  let processed = 0;
  try {
    const batch = Math.max(1, Math.min(10, Number(process.env.KORTIX_APPS_WORKER_BATCH) || 2));
    for (let index = 0; index < batch; index++) {
      const claimed = await claimAppDeployment(owner);
      if (!claimed) break;
      await driveAppDeployment(claimed, owner);
      processed += 1;
    }
    return { processed };
  } finally {
    workerRunning = false;
    if (workerRerunRequested) scheduleTriggeredTick();
  }
}

export { startAppDeploymentWorker, stopAppDeploymentWorker } from '../workers/app-deployment-worker';
