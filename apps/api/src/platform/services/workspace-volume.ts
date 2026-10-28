/**
 * /workspace on a Platinum volume: the project's `workspace_volume` flag, the
 * storage half of stateless sandboxes.
 *
 * One volume per session, `kws-<session_id>`, mounted at /workspace when the box
 * is created, so the mount exists before kortixd starts. kortixd fills the empty
 * volume on the first boot with its usual Git or S3 transports and adopts the
 * checkout on every later boot (KORTIX_WORKSPACE_VOLUME=1,
 * services/workspace-provider). The box is disposable: one stopped for
 * KORTIX_SANDBOX_IDLE_DELETE_MINUTES is removed (reaping/idle-volume-retire.ts)
 * and the next open boots a fresh box on the same volume. The conversation
 * comes back from the session log (projects/lib/session-sandbox-env-build.ts).
 *
 * The flag is read once, at POST /sessions (`startWorkspaceVolume`). The
 * session row is inserted with the record `metadata.workspace_volume`, and from
 * then on only the record decides: every box of the session mounts the volume,
 * whatever the flag or the kill switch say later.
 *
 * Platinum volumes belong to the control plane that created them: a us-east
 * volume is invisible to the global origin, which answers 404 for it, and 204
 * for a `missing_ok` delete that deletes nothing (measured on dev, 2026-10-16).
 * So the record names the region, and every call about the volume and every
 * box of the session goes to that region.
 *
 * The volume lives as long as the session's content: a deleted session keeps
 * it through the trash window, and the retention purge deletes it with the
 * session's files (session-log-purge.ts), as does account erasure
 * (billing/services/account-erasure-stores.ts).
 */
import { projectSessions } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { config } from '../../config';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { platinumJson, platinumRegionControlPlane } from '../../shared/platinum';
import type { CreateSandboxOpts } from '../providers/contract';
import { WORKSPACE_VOLUME_UNREACHABLE_MESSAGE } from './sandbox-provisioning-error';

export const WORKSPACE_VOLUME_MOUNT = '/workspace';
/** Tells kortixd /workspace is a volume (never cleared, reported on /kortix/health). */
export const WORKSPACE_VOLUME_ENV = 'KORTIX_WORKSPACE_VOLUME';
/** project_sessions.metadata: the session's volume. Written by the session insert, never changed. Server-managed. */
export const WORKSPACE_VOLUME_SESSION_KEY = 'workspace_volume';

export interface WorkspaceVolume {
  name: string;
  /** The Platinum region it lives in, as `location` on a create; null = the home region. */
  location: string | null;
}

const REGION_KEY = /^[a-z]{2,8}-[a-z]{2,12}$/;
/** An open that POST /sessions started and no session row recorded by then is deleted. */
const UNRECORDED_OPEN_TTL_MS = 120_000;

export function workspaceVolumeName(sessionId: string): string {
  return `kws-${sessionId}`;
}

/** Operator switch: KORTIX_WORKSPACE_VOLUMES=off gives no new session a volume. */
function workspaceVolumesKillSwitchOff(): boolean {
  return /^(0|off|false|no)$/.test((config.KORTIX_WORKSPACE_VOLUMES ?? '').trim().toLowerCase());
}

/** The session's recorded volume, when the record names its own volume and a valid region. */
export function recordedWorkspaceVolume(sessionId: string, metadata: unknown): WorkspaceVolume | null {
  const v = (metadata as Record<string, unknown> | null | undefined)?.[WORKSPACE_VOLUME_SESSION_KEY] as
    | { name?: unknown; location?: unknown }
    | undefined;
  if (!v || v.name !== workspaceVolumeName(sessionId)) return null;
  const location = v.location ?? null;
  if (location !== null && !(typeof location === 'string' && REGION_KEY.test(location))) return null;
  return { name: v.name, location };
}

/** The control plane that owns the volume: the region's own, or the global origin for home. */
function volumeOrigin(volume: WorkspaceVolume): string | undefined {
  if (!volume.location) return undefined;
  const origin = platinumRegionControlPlane(volume.location);
  if (!origin) throw new Error(`[workspace] No Platinum control plane is known for region ${volume.location}.`);
  return origin;
}

// replica-local: opens POST /sessions started, read once by the same process's
// provisioning (resolveWorkspaceVolume), dropped after UNRECORDED_OPEN_TTL_MS.
// ponytail: an API restart inside that window leaves an unrecorded volume behind;
// add a `kws-*` orphan sweep if Platinum's volume list shows any.
const earlyOpens = new Map<string, Promise<void>>();

/**
 * The create-time decision, the only read of the flag: the volume a new
 * session gets, or null. It also starts opening the volume, so the open runs
 * alongside the rest of POST /sessions instead of before the box create. The
 * caller records the result in the session row it inserts.
 */
export function startWorkspaceVolume(input: {
  sessionId: string;
  projectMetadata: unknown;
  /** Where the session's boxes run (the project's `us_region`); undefined = home. */
  location: string | undefined;
}): WorkspaceVolume | null {
  const { sessionId } = input;
  if (!config.PLATINUM_API_KEY || workspaceVolumesKillSwitchOff() || !resolveFeatureFlag(input.projectMetadata, 'workspace_volume')) {
    return null;
  }
  const volume: WorkspaceVolume = { name: workspaceVolumeName(sessionId), location: input.location ?? null };
  const open = openWorkspaceVolume(sessionId, volume);
  open.catch(() => {});
  earlyOpens.set(sessionId, open);
  setTimeout(() => {
    if (earlyOpens.delete(sessionId)) void dropUnrecordedVolume(sessionId, volume);
  }, UNRECORDED_OPEN_TTL_MS).unref?.();
  return volume;
}

/** The create failed after the open started, or the session runs off Platinum: nothing else would delete this volume. */
async function dropUnrecordedVolume(sessionId: string, volume: WorkspaceVolume): Promise<void> {
  try {
    if (await sessionWorkspaceVolume(sessionId)) return;
    await deleteWorkspaceVolume(volume);
    logger.info(`[workspace] deleted unrecorded volume ${volume.name}`, { sessionId, region: volume.location ?? 'home' });
  } catch (err) {
    logger.warn(`[workspace] unrecorded volume ${volume.name} was not deleted`, {
      sessionId,
      region: volume.location ?? 'home',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function sessionWorkspaceVolume(sessionId: string): Promise<WorkspaceVolume | null> {
  const [row] = await db
    .select({ metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  return recordedWorkspaceVolume(sessionId, row?.metadata);
}

/**
 * The opened volume a new box of this session mounts at /workspace, or null
 * for a box-disk session. Only the record decides. Fails the boot when the
 * volume cannot be opened: a session never falls back to the box disk, which
 * would not have its files.
 */
export async function resolveWorkspaceVolume(sessionId: string): Promise<WorkspaceVolume | null> {
  const volume = await sessionWorkspaceVolume(sessionId);
  if (!volume) return null;
  const early = earlyOpens.get(sessionId);
  earlyOpens.delete(sessionId);
  await (early ? early.catch(() => openWorkspaceVolume(sessionId, volume)) : openWorkspaceVolume(sessionId, volume));
  return volume;
}

/**
 * The box create for a session with a volume: a private mount at /workspace
 * (one writer), no whole-box backup (the state is on the volume), the volume's
 * region with no home-region fallback (the box could not mount it there),
 * KORTIX_WORKSPACE_VOLUME=1 for kortixd, and no one-time branch restore: that
 * restore clears a checkout whose adoption marker does not match, and on a
 * volume the checkout is the session's only copy (kortixd refuses it too).
 */
export function applyWorkspaceVolume(create: CreateSandboxOpts, volume: WorkspaceVolume): void {
  create.volumes = { ...create.volumes, [WORKSPACE_VOLUME_MOUNT]: { volume: volume.name, share: 'private' } };
  create.volumesRequired = true;
  create.location = volume.location ?? undefined;
  if (volume.location) create.locationRequired = true;
  const { KORTIX_SESSION_BRANCH_RESTORE: _restore, ...env } = create.envVars ?? {};
  create.envVars = { ...env, [WORKSPACE_VOLUME_ENV]: '1' };
}

/** Open-or-create in its region, `git` sync (a single-writer working copy). Three tries over ~6 s. */
async function openWorkspaceVolume(sessionId: string, volume: WorkspaceVolume): Promise<void> {
  const origin = volumeOrigin(volume);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const body = await platinumJson<{ region?: string }>(
        `/v1/volumes/${encodeURIComponent(volume.name)}`,
        // Always explicit: Platinum's code default is `drive` (live sync, keep-both).
        { method: 'PUT', body: JSON.stringify({ sync_mode: 'git' }), signal: AbortSignal.timeout(15_000) },
        origin,
      );
      if (volume.location && body.region && body.region !== volume.location) {
        throw new Error(`volume ${volume.name} answered from ${body.region}, not ${volume.location}`);
      }
      return;
    } catch (err) {
      lastErr = err;
      // The PlatinumHttpError fields, read structurally.
      const status = Number((err as { status?: unknown } | null)?.status) || 0;
      if (status >= 400 && status < 500) break;
      if (attempt < 3) await Bun.sleep(attempt * 2_000);
    }
  }
  const quota = (lastErr as { code?: unknown } | null)?.code === 'quota_exceeded';
  logger.warn(`[workspace] volume ${volume.name} did not open`, {
    sessionId,
    region: volume.location ?? 'home',
    error: lastErr instanceof Error ? lastErr.message : String(lastErr),
  });
  throw new Error(
    quota
      ? '[workspace] This session’s workspace volume could not be created: the workspace reached its storage volume limit. Delete old sessions, or ask Kortix for more.'
      : WORKSPACE_VOLUME_UNREACHABLE_MESSAGE,
  );
}

/**
 * Delete a volume. Platinum refuses with `volume_busy` while any box, running
 * or stopped, mounts it, and briefly after a sandbox DELETE answers, so that is
 * waited out for ~10 s. Throws on any other failure so the caller retries.
 */
async function deleteWorkspaceVolume(volume: WorkspaceVolume): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await platinumJson(
        `/v1/volumes/${encodeURIComponent(volume.name)}?missing_ok=true`,
        { method: 'DELETE', signal: AbortSignal.timeout(15_000) },
        volumeOrigin(volume),
      );
      return;
    } catch (err) {
      if (attempt >= 5 || (err as { code?: unknown } | null)?.code !== 'volume_busy') throw err;
      await Bun.sleep(2_000);
    }
  }
}

/**
 * Why a stopped box of this session must stay, or null when its volume holds
 * everything the box wrote and the box may go. Platinum's volume health
 * (`GET /v1/volumes/:v/health`) reads the mounts, merge queue, open commits and
 * blocks not yet in object storage; only `ok` lets the box go. A volume
 * Platinum cannot judge (no valid record, not found, no answer) keeps the box:
 * it may hold the session's only copy of a file. Never throws.
 */
export async function workspaceVolumeHoldReason(sessionId: string, sessionMetadata: unknown): Promise<string | null> {
  const volume = recordedWorkspaceVolume(sessionId, sessionMetadata);
  if (!volume) return 'the session has no valid workspace volume record';
  try {
    const health = await platinumJson<{ status?: string; reason?: string | null }>(
      // probe=false: the verdict on unsaved writes comes from Platinum's database, not the gateway host.
      `/v1/volumes/${encodeURIComponent(volume.name)}/health?probe=false`,
      { signal: AbortSignal.timeout(15_000) },
      volumeOrigin(volume),
    );
    return health.status === 'ok' ? null : `volume ${volume.name} is ${health.status ?? 'unknown'}: ${health.reason ?? 'no reason given'}`;
  } catch (err) {
    return `volume ${volume.name} health check failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Delete the session's workspace volume when it has one: its content ended (purge, account erasure). Throws on failure. */
export async function deleteSessionWorkspaceVolume(sessionId: string, metadata: unknown): Promise<void> {
  const volume = recordedWorkspaceVolume(sessionId, metadata);
  if (!volume) return;
  await deleteWorkspaceVolume(volume);
  logger.info(`[workspace] deleted volume ${volume.name}`, { sessionId, region: volume.location ?? 'home' });
}
