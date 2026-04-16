import { eq } from 'drizzle-orm';
import { sandboxes } from '@kortix/db';
import { db } from '../shared/db';
import { config } from '../config';
import { getProvider, type ProviderName, type SandboxProvider } from '../platform/providers';
import { JustAVPSProvider } from '../platform/providers/justavps';
import { setPhase, clearUpdateStatus } from './status';
import { isUpdateCancellationRequested } from './status';
import {
  readContainerConfig,
  writeContainerConfig,
  buildFromInspect,
  type ContainerConfig,
} from './container-config';
import {
  getCurrentImage,
  pullImage,
  checkDockerDaemon,
  checkDiskSpace,
  checkImageExistsOnHub,
  checkpointSqlite,
  ensureContainerRunning,
  stopAndStartContainer,
  verifyContainer,
} from './steps';

function imageForVersion(version: string): string {
  const current = config.SANDBOX_IMAGE;
  const colonIdx = current.lastIndexOf(':');
  const base = colonIdx > 0 ? current.slice(0, colonIdx) : current;
  return `${base}:${version}`;
}

async function resolveContainerConfig(
  endpoint: { url: string; headers: Record<string, string> },
): Promise<ContainerConfig> {
  const fromFile = await readContainerConfig(endpoint);
  if (fromFile) return fromFile;

  const fromInspect = await buildFromInspect(endpoint);
  if (fromInspect) {
    await writeContainerConfig(endpoint, fromInspect);
    console.log(`[UPDATE] Migrated legacy container to config file (${fromInspect.name})`);
    return fromInspect;
  }

  throw new Error('Cannot determine container config — no config file and no running container found');
}

function buildSafeBackupDescription(previousVersion: string | null, targetVersion: string): string {
  const from = previousVersion ? `v${previousVersion.replace(/^v/, '')}` : 'unknown';
  const to = `v${targetVersion.replace(/^v/, '')}`;
  return `Kortix pre-update backup ${from} -> ${to}`;
}

class UpdateCancelledError extends Error {
  constructor(message = 'Update cancelled before destructive changes started') {
    super(message);
    this.name = 'UpdateCancelledError';
  }
}

/**
 * Kick off a provider-side backup and wait for it to finish.
 *
 * While waiting we stay in the `backing_up` phase (0–10% progress). The
 * client reads that phase and shows a non-blocking indicator so the user
 * can keep using the machine until we transition to the destructive phases.
 */
async function runBackup(
  sandboxId: string,
  provider: SandboxProvider,
  externalId: string,
  previousVersion: string | null,
  targetVersion: string,
): Promise<void> {
  if (!(provider instanceof JustAVPSProvider)) return;

  const description = buildSafeBackupDescription(previousVersion, targetVersion);

  await setPhase(sandboxId, 'backing_up', 5, 'Requesting backup from provider…', {
    backupId: null,
    diagnostics: {
      stage: 'backup_request_started',
      machineId: externalId,
      backupDescription: description,
    },
  });

  if (await isUpdateCancellationRequested(sandboxId)) {
    throw new UpdateCancelledError();
  }

  const started = await provider.createBackup(externalId, description);
  const backupId = started.backup_id;
  await setPhase(sandboxId, 'backing_up', 5, 'Creating backup…', {
    backupId,
    diagnostics: {
      stage: 'backup_requested',
      machineId: externalId,
      backupId,
      providerStatus: started.status ?? 'unknown',
      backupDescription: description,
    },
  });
  console.log(`[UPDATE] Backup ${backupId} started for machine ${externalId}`);

  // Manual backups in JustAVPS are asynchronous and remain "creating" for a
  // while even when they are usable. Match the manual backup UX: once the
  // provider accepts the request and gives us a backup id, proceed.
  await setPhase(sandboxId, 'backing_up', 10, 'Backup requested successfully', {
    backupId,
    diagnostics: {
      stage: 'backup_request_accepted',
      machineId: externalId,
      backupId,
      providerStatus: started.status ?? 'creating',
      backupDescription: description,
    },
  });
}

export async function executeUpdate(sandboxId: string, targetVersion: string): Promise<void> {
  const [row] = await db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.sandboxId, sandboxId))
    .limit(1);

  if (!row) throw new Error('Sandbox not found');
  if (!row.externalId) throw new Error('Sandbox has no external ID');

  const provider = getProvider(row.provider as ProviderName);
  const endpoint = await provider.resolveEndpoint(row.externalId);
  const targetImage = imageForVersion(targetVersion);

  try {
    // ── Pre-flight: verify machine + Docker + disk + image ──
    await setPhase(sandboxId, 'preflight', 2, 'Checking machine...', {
      targetVersion,
      error: null,
      startedAt: new Date().toISOString(),
    });

    let containerConfig: ContainerConfig;
    try {
      containerConfig = await resolveContainerConfig(endpoint);
    } catch (err) {
      throw new Error(`Machine unreachable or no container found. Is the machine online? (${err instanceof Error ? err.message : err})`);
    }
    const previousVersion = containerConfig.image.split(':').pop() ?? null;

    // Check Docker daemon is responsive
    const dockerCheck = await checkDockerDaemon(endpoint);
    if (!dockerCheck.success) throw new Error(dockerCheck.stderr);

    const containerReady = await ensureContainerRunning(endpoint, containerConfig);
    if (!containerReady.success) {
      throw new Error(`Sandbox container is missing and auto-recovery failed: ${containerReady.stderr || containerReady.stdout || 'unknown error'}`);
    }
    if (containerReady.stdout === 'recovered') {
      console.log(`[UPDATE] Recovered missing sandbox container ${containerConfig.name} before update`);
    }

    // Check disk space (need ~6GB for the image)
    const diskCheck = await checkDiskSpace(endpoint);
    if (!diskCheck.success) throw new Error(diskCheck.stderr);
    console.log(`[UPDATE] Pre-flight OK: ${dockerCheck.stdout}, disk: ${diskCheck.stdout}`);

    // Verify image exists on Docker Hub before wasting time pulling
    const hubCheck = await checkImageExistsOnHub(targetImage);
    if (!hubCheck.success) throw new Error(hubCheck.stderr);

    // ── Backup (non-destructive; UI stays unblocked during this phase) ──
    await setPhase(sandboxId, 'backing_up', 5, 'Creating backup…', {
      previousVersion,
      currentVersion: previousVersion,
      backupId: null,
    });
    await runBackup(sandboxId, provider, row.externalId, previousVersion, targetVersion);

    // ── Pull ──
    await setPhase(sandboxId, 'pulling', 15, `Pulling ${targetImage}...`);
    const pullResult = await pullImage(endpoint, targetImage);
    if (!pullResult.success) {
      const elapsed = Math.round((pullResult.durationMs || 0) / 1000);
      throw new Error(`Pull failed after ${elapsed}s: ${pullResult.stderr}`);
    }
    const pullElapsed = Math.round((pullResult.durationMs || 0) / 1000);
    console.log(`[UPDATE] Pull completed in ${pullElapsed}s (${pullResult.stdout})`);

    // ── Checkpoint ──
    await setPhase(sandboxId, 'stopping', 40, 'Saving state...');
    let checkpointResult = await checkpointSqlite(endpoint, containerConfig.name);
    if (!checkpointResult.success && /No such container/i.test(`${checkpointResult.stderr}\n${checkpointResult.stdout}`)) {
      console.warn(`[UPDATE] Container ${containerConfig.name} disappeared before checkpoint, attempting recovery...`);
      const recovered = await ensureContainerRunning(endpoint, containerConfig);
      if (!recovered.success) {
        throw new Error(`State sync failed before update and container recovery failed: ${recovered.stderr || recovered.stdout || 'unknown error'}`);
      }
      checkpointResult = await checkpointSqlite(endpoint, containerConfig.name);
    }
    if (!checkpointResult.success) {
      throw new Error(`State sync failed before update: ${checkpointResult.stderr || checkpointResult.stdout || 'unknown error'}`);
    }

    // ── Stop & restart ──
    await setPhase(sandboxId, 'restarting', 55, 'Restarting with new image...');
    const updatedConfig: ContainerConfig = { ...containerConfig, image: targetImage };
    const restartResult = await stopAndStartContainer(endpoint, updatedConfig);
    if (!restartResult.success) {
      console.warn(`[UPDATE] Restart warning (may be expected 502): ${restartResult.stderr}`);
    }

    // ── Verify ──
    await setPhase(sandboxId, 'verifying', 80, 'Verifying new container...');
    const verifyResult = await verifyContainer(endpoint, targetImage, updatedConfig.name);
    if (!verifyResult.success) {
      throw new Error(`Container failed to start with ${targetImage}. ${verifyResult.stderr}`);
    }

    // ── Persist config only after verified ──
    await writeContainerConfig(endpoint, updatedConfig);

    // ── Re-inject env so updated sandboxes get latest platform vars (e.g. YOLO) ──
    const serviceKey = (row.config as Record<string, unknown>)?.serviceKey as string || '';
    if (serviceKey) {
      try {
        const { inject } = await import('../pool/env-injector');
        await inject({ baseUrl: row.baseUrl, metadata: row.metadata ?? {}, externalId: row.externalId! }, serviceKey);
      } catch (envErr) {
        console.warn(`[UPDATE] Env re-injection failed (non-fatal):`, envErr);
      }
    }

    // ── Complete ──
    await setPhase(sandboxId, 'complete', 100, `Updated to v${targetVersion}`, {
      currentVersion: targetVersion,
    });

    console.log(`[UPDATE] Sandbox ${sandboxId} updated to ${targetImage} (pull: ${pullElapsed}s)`);

    setTimeout(async () => {
      try { await clearUpdateStatus(sandboxId, targetVersion); } catch {}
    }, 30_000);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const isCancelled = err instanceof UpdateCancelledError;
    await setPhase(
      sandboxId,
      'failed',
      0,
      isCancelled ? errorMsg : `Update failed: ${errorMsg}`,
      {
        error: errorMsg,
        cancelRequested: false,
        diagnostics: {
          stage: 'update_failed',
          reason: errorMsg,
        },
      },
    );
    console.error(`[UPDATE] Sandbox ${sandboxId} update failed:`, errorMsg);
    throw err;
  }
}
