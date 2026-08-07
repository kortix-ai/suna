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
import { and, asc, eq, inArray, isNull, lt, lte, or } from 'drizzle-orm';
import { pauseComputeSession, startComputeSession } from '../billing/services/compute-metering';
import { config, type SandboxProviderName } from '../config';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { listResolvedProjectSecrets } from '../projects/secrets';
import { downloadAppArtifact, extractAppArchive } from './artifacts';
import { resolveAppRuntimeEnvironment } from './environment';
import { AppHostingProvider } from './hosting';
import { normalizeAppBuild, type AppSourceSpec } from './spec';
import { assertAppBudgetAvailable } from './budget';

export const APP_RUNTIME_VERSION = '1';
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

class PermanentAppDeploymentError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'PermanentAppDeploymentError';
  }
}

function retryDelayMs(attempt: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, attempt - 1));
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
  runtimeId: string;
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
    await tx
      .update(appRuntimes)
      .set({ status: 'running', startedAt: now, updatedAt: now })
      .where(eq(appRuntimes.runtimeId, input.runtimeId));
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
  let runtimeId: string | null = null;
  let runtimeExternalId: string | null = null;
  let runtimeProvider: SandboxProviderName | null = null;
  let temporaryRoot: string | null = null;
  try {
    const context = await deploymentContext(claimed.deploymentId);
    const provider = selectedProvider(context.deployment.hostingProvider);
    runtimeProvider = provider;
    await setDeploymentStatus(claimed.deploymentId, owner, 'validating', {
      hostingProvider: provider,
      error: null,
      errorCode: null,
    });
    await event(claimed.deploymentId, 'validation_started', 'Validating App artifact');

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
      temporaryRoot = await mkdtemp(join(tmpdir(), 'kortix-app-deployment-'));
      const archivePath = join(temporaryRoot, 'source.tar.gz');
      const downloaded = await downloadAppArtifact(context.artifact.objectPath, archivePath);
      if (context.artifact.sha256 && downloaded.sha256 !== context.artifact.sha256) {
        throw new PermanentAppDeploymentError('Artifact SHA-256 does not match finalization', 'digest_mismatch');
      }
      if (context.artifact.sizeBytes && downloaded.sizeBytes !== context.artifact.sizeBytes) {
        throw new PermanentAppDeploymentError('Artifact size does not match finalization', 'size_mismatch');
      }
      sourceDir = join(temporaryRoot, 'source');
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
      context.artifact.createdBy ?? context.app.createdBy,
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

    await assertAppBudgetAvailable(context.app.appId, Number(context.app.monthlyBudgetUsd));

    const snapshotName = `kortix-app-${claimed.deploymentId.replaceAll('-', '')}`;
    await setDeploymentStatus(claimed.deploymentId, owner, 'building', {
      sourceKind: normalized.sourceKind,
      runtimeSpec: normalized.runtimeSpec,
      buildSpec: { source, normalized: normalized.buildSpec },
      providerBuildId: snapshotName,
    });
    await event(claimed.deploymentId, 'build_started', `Building ${snapshotName}`, {
      data: { provider },
    });
    await hosting.buildImage({
      provider,
      snapshotName,
      slug: context.app.slug,
      sourceDir: normalized.sourceDir,
      dockerfile: normalized.dockerfile,
      runtimeSpec: normalized.runtimeSpec,
      machine: {
        cpuCores: context.app.cpuCores,
        memoryGb: context.app.memoryGb,
        diskGb: context.app.diskGb,
      },
      logTap: {
        onLine: (line) => {
          void event(claimed.deploymentId, 'build_log', line.slice(0, 4_000), { level: 'debug' });
        },
      },
    });
    await event(claimed.deploymentId, 'build_ready', 'App image is ready', { data: { provider } });

    await setDeploymentStatus(claimed.deploymentId, owner, 'provisioning');
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
      runtimeId = existingRuntime.runtimeId;
      runtimeExternalId = existingRuntime.externalId;
      runtimeProvider = existingRuntime.provider as SandboxProviderName;
      await hosting.start(runtimeProvider, runtimeExternalId);
    } else {
      runtimeId = randomUUID();
      const handle = await hosting.createRuntime({
        provider,
        runtimeId,
        accountId: context.app.accountId,
        userId: context.app.createdBy ?? context.artifact.createdBy ?? context.app.accountId,
        name: `app-${context.app.routeKey}-v${context.deployment.version}`,
        snapshotName,
        machine: {
          cpuCores: context.app.cpuCores,
          memoryGb: context.app.memoryGb,
          diskGb: context.app.diskGb,
        },
        autoStopMinutes: Math.max(2, Math.ceil(context.app.idleTimeoutSeconds / 60)),
        envVars: runtimeEnvironment.env,
      });
      runtimeExternalId = handle.externalId;
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
      await startComputeSession({
        sandboxId: runtimeId,
        accountId: context.app.accountId,
        actorUserId: context.app.createdBy,
        provider,
        spec: {
          cpuCores: context.app.cpuCores,
          memoryGb: context.app.memoryGb,
          diskGb: context.app.diskGb,
          gpuCount: 0,
        },
        workloadType: 'app',
        appRuntimeId: runtimeId,
        metadata: { deploymentId: claimed.deploymentId, appId: context.app.appId },
      });
      await event(claimed.deploymentId, 'runtime_created', 'App runtime created', {
        runtimeId,
        data: { provider, externalId: handle.externalId },
      });
    }

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
    await stopPreviousRuntime(hosting, previous).catch((error) => {
      logger.error('[apps] previous runtime stop failed', {
        deploymentId: previous,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    const permanent = error instanceof PermanentAppDeploymentError;
    const message = error instanceof Error ? error.message : String(error);
    const attempt = claimed.attemptCount;
    if (runtimeId) {
      await db
        .update(appRuntimes)
        .set({ status: 'error', stoppedAt: new Date(), updatedAt: new Date() })
        .where(eq(appRuntimes.runtimeId, runtimeId))
        .catch(() => {});
      await pauseComputeSession(runtimeId).catch(() => {});
    }
    if (runtimeProvider && runtimeExternalId) {
      await hosting.remove(runtimeProvider, runtimeExternalId).catch(() => {});
    }
    const terminal = permanent || attempt >= MAX_ATTEMPTS;
    await db
      .update(appDeployments)
      .set({
        status: terminal ? 'failed' : 'queued',
        errorCode: permanent ? error.code : 'deployment_failed',
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
    }).catch(() => {});
    if (terminal) return;
  } finally {
    clearInterval(heartbeat);
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
  }
}

const workerState = globalThis as unknown as {
  __kortixAppsWorkerTimer?: ReturnType<typeof setInterval> | null;
};
let workerRunning = false;

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
  }
}

export function startAppDeploymentWorker(): void {
  if (process.env.KORTIX_APPS_WORKER_ENABLED === 'false') return;
  stopAppDeploymentWorker();
  const interval = Math.max(1_000, Number(process.env.KORTIX_APPS_WORKER_INTERVAL_MS) || 5_000);
  void runAppDeploymentTick().catch((error) =>
    logger.error('[apps] deployment worker initial tick failed', {
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  workerState.__kortixAppsWorkerTimer = setInterval(() => {
    void runAppDeploymentTick().catch((error) =>
      logger.error('[apps] deployment worker tick failed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }, interval);
}

export function stopAppDeploymentWorker(): void {
  if (workerState.__kortixAppsWorkerTimer) {
    clearInterval(workerState.__kortixAppsWorkerTimer);
    workerState.__kortixAppsWorkerTimer = null;
  }
}
