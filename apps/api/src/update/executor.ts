import { eq } from 'drizzle-orm';
import { sandboxes } from '@kortix/db';
import { db } from '../shared/db';
import { config } from '../config';
import { getProvider, type ProviderName } from '../platform/providers';
import { setPhase, clearUpdateStatus } from './status';
import {
  readContainerConfig,
  writeContainerConfig,
  buildFromInspect,
  buildDockerRunCommand,
  type ContainerConfig,
} from './container-config';
import {
  getCurrentImage,
  pullImage,
  checkDockerDaemon,
  checkDiskSpace,
  checkImageExistsOnHub,
  checkpointSqlite,
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

async function tryBackup(provider: string, externalId: string): Promise<void> {
  if (provider !== 'justavps') return;
  try {
    const { justavpsFetch } = await import('../platform/providers/justavps');
    await justavpsFetch(`/machines/${externalId}/backups`, { method: 'POST' });
    console.log(`[UPDATE] Backup created for machine ${externalId}`);
  } catch (err) {
    console.warn(`[UPDATE] Backup failed (non-fatal):`, err instanceof Error ? err.message : err);
  }
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

    // Check disk space (need ~6GB for the image)
    const diskCheck = await checkDiskSpace(endpoint);
    if (!diskCheck.success) throw new Error(diskCheck.stderr);
    console.log(`[UPDATE] Pre-flight OK: ${dockerCheck.stdout}, disk: ${diskCheck.stdout}`);

    // Verify image exists on Docker Hub before wasting time pulling
    const hubCheck = await checkImageExistsOnHub(targetImage);
    if (!hubCheck.success) throw new Error(hubCheck.stderr);

    // ── Backup ──
    await setPhase(sandboxId, 'backing_up', 5, 'Creating backup...', {
      previousVersion,
      currentVersion: previousVersion,
    });
    await tryBackup(row.provider, row.externalId);

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
    const checkpointResult = await checkpointSqlite(endpoint, containerConfig.name);
    if (!checkpointResult.success) {
      throw new Error(`State sync failed before update: ${checkpointResult.stderr || checkpointResult.stdout || 'unknown error'}`);
    }

    // ── Stop & restart ──
    await setPhase(sandboxId, 'restarting', 55, 'Restarting with new image...');
    const updatedConfig: ContainerConfig = { ...containerConfig, image: targetImage };
    const runCmd = buildDockerRunCommand(updatedConfig);
    const restartResult = await stopAndStartContainer(endpoint, containerConfig.name, runCmd);
    if (!restartResult.success) {
      console.warn(`[UPDATE] Restart warning (may be expected 502): ${restartResult.stderr}`);
    }

    // ── Verify ──
    await setPhase(sandboxId, 'verifying', 80, 'Verifying new container...');
    const verifyResult = await verifyContainer(endpoint, targetImage, updatedConfig.name);
    if (!verifyResult.success) {
      throw new Error(`Container failed to start with ${targetImage}. Expected image not running after restart. ${verifyResult.stderr}`);
    }

    // ── Persist config only after verified ──
    await writeContainerConfig(endpoint, updatedConfig);

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
    await setPhase(sandboxId, 'failed', 0, `Update failed: ${errorMsg}`, { error: errorMsg });
    console.error(`[UPDATE] Sandbox ${sandboxId} update failed:`, errorMsg);
    throw err;
  }
}
