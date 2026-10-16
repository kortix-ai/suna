/**
 * /workspace on a Platinum volume: the project's `workspace_volume` flag, step 1
 * of stateless sandboxes.
 *
 * One volume per session, `kws-<session_id>`, mounted at /workspace when the box
 * is created, so the mount exists before kortixd starts. The box still stops and
 * resumes in place; nothing here deletes a box. kortixd fills the empty volume
 * on the first boot with its usual Git or S3 transports and adopts the checkout
 * on every later boot (KORTIX_WORKSPACE_VOLUME=1, services/workspace-provider).
 *
 * Platinum volumes belong to the control plane that created them: a us-east
 * volume is invisible to the global origin, which answers 404 for it, and 204
 * for a `missing_ok` delete that deletes nothing (measured on dev, 2026-10-16).
 * So the session records where its volume lives, and every call about it and
 * every box of the session goes to that region.
 */
import { projectSessions } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';

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
/** project_sessions.metadata: the session's volume. Set once, never cleared. Server-managed. */
export const WORKSPACE_VOLUME_SESSION_KEY = 'workspace_volume';

export interface WorkspaceVolume {
  name: string;
  /** The Platinum region it lives in, as `location` on a create; null = the home region. */
  location: string | null;
}

const REGION_KEY = /^[a-z]{2,8}-[a-z]{2,12}$/;

export function workspaceVolumeName(sessionId: string): string {
  return `kws-${sessionId}`;
}

/** Operator switch: KORTIX_WORKSPACE_VOLUMES=off gives no new session a volume. */
export function workspaceVolumesKillSwitchOff(): boolean {
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

/**
 * The volume a new box of this session mounts at /workspace, or null for a
 * box-disk session. A session that has a volume always gets it back, whatever
 * the flag and the kill switch say: a box without it would not have the
 * session's files. Otherwise the project flag decides, once.
 *
 * The record is written before the volume is created, in one statement that
 * keeps an existing record, so a crash in between leaves a record the next boot
 * completes (the create is open-or-create), never an unrecorded volume.
 *
 * Fails the boot when the volume cannot be opened: a session never falls back
 * to the box disk (see the PR for why).
 */
export async function resolveWorkspaceVolume(input: {
  sessionId: string;
  projectMetadata: unknown;
  /** Where this box would be created (the project's `us_region`); undefined = home. */
  location: string | undefined;
}): Promise<WorkspaceVolume | null> {
  const { sessionId } = input;
  const [row] = await db
    .select({ metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  let volume = recordedWorkspaceVolume(sessionId, row?.metadata);
  if (!volume) {
    if (!row || workspaceVolumesKillSwitchOff() || !resolveFeatureFlag(input.projectMetadata, 'workspace_volume')) {
      return null;
    }
    const wanted: WorkspaceVolume = { name: workspaceVolumeName(sessionId), location: input.location ?? null };
    const [written] = (await db.execute(sql`
      UPDATE kortix.project_sessions
         SET metadata = coalesce(metadata, '{}'::jsonb)
           || CASE WHEN coalesce(metadata, '{}'::jsonb) ? ${WORKSPACE_VOLUME_SESSION_KEY}::text THEN '{}'::jsonb
                   ELSE jsonb_build_object(${WORKSPACE_VOLUME_SESSION_KEY}::text, ${JSON.stringify(wanted)}::jsonb) END
       WHERE session_id = ${sessionId}
       RETURNING metadata
    `)) as unknown as Array<{ metadata: unknown }>;
    volume = recordedWorkspaceVolume(sessionId, written?.metadata);
    if (!volume) throw new Error(`[workspace] This session's workspace volume record is not valid, so it did not start.`);
  }
  await openWorkspaceVolume(volume);
  return volume;
}

/**
 * The box create for a session with a volume: mount it at /workspace, run in
 * the volume's region (no home-region fallback: the box could not mount it
 * there), tell kortixd, and drop the one-time branch restore. That restore
 * clears a checkout whose adoption marker does not match, and on a volume the
 * checkout is the session's only copy (kortixd refuses it too).
 */
export function applyWorkspaceVolume(create: CreateSandboxOpts, volume: WorkspaceVolume): void {
  create.volumes = { ...create.volumes, [WORKSPACE_VOLUME_MOUNT]: { volume: volume.name } };
  create.location = volume.location ?? undefined;
  if (volume.location) create.locationRequired = true;
  const { KORTIX_SESSION_BRANCH_RESTORE: _restore, ...env } = create.envVars ?? {};
  create.envVars = { ...env, [WORKSPACE_VOLUME_ENV]: '1' };
}

/** Open-or-create in its region, `git` sync (a single-writer working copy). Three tries over ~6 s. */
async function openWorkspaceVolume(volume: WorkspaceVolume): Promise<void> {
  const origin = volumeOrigin(volume);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const body = await platinumJson<{ region?: string }>(
        `/v1/volumes/${encodeURIComponent(volume.name)}`,
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
  logger.warn(`[workspace] volume ${volume.name} (${volume.location ?? 'home'}) did not open`, {
    error: lastErr instanceof Error ? lastErr.message : String(lastErr),
  });
  throw new Error(
    quota
      ? '[workspace] This session’s workspace volume could not be created: the workspace reached its storage volume limit. Delete old sessions, or ask Kortix for more.'
      : WORKSPACE_VOLUME_UNREACHABLE_MESSAGE,
  );
}

/**
 * Delete a DELETED session's workspace volume, when it has one. A session that
 * is not deleted keeps it: the box-removal lane also serves a lost session's
 * recovery and a stuck provisioning, and their next box mounts this volume.
 * The box must be gone first: Platinum refuses a delete with `volume_busy`
 * while any box, running or stopped, mounts it. A sandbox DELETE answers before
 * the box releases its mount, so `volume_busy` is waited out for ~10 s. Throws
 * on any failure so the caller retries.
 */
export async function deleteWorkspaceVolume(sessionId: string): Promise<'deleted' | 'none'> {
  const [row] = await db
    .select({ metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  const metadata = row?.metadata as Record<string, unknown> | null | undefined;
  const volume = recordedWorkspaceVolume(sessionId, metadata);
  if (!volume || typeof metadata?.deletedAt !== 'string') return 'none';
  for (let attempt = 1; ; attempt++) {
    try {
      await platinumJson(
        `/v1/volumes/${encodeURIComponent(volume.name)}?missing_ok=true`,
        { method: 'DELETE', signal: AbortSignal.timeout(15_000) },
        volumeOrigin(volume),
      );
      break;
    } catch (err) {
      if (attempt >= 5 || (err as { code?: unknown } | null)?.code !== 'volume_busy') throw err;
      await Bun.sleep(2_000);
    }
  }
  logger.info(`[workspace] deleted volume ${volume.name} (${volume.location ?? 'home'})`);
  return 'deleted';
}

async function sessionWorkspaceVolume(sessionId: string): Promise<WorkspaceVolume | null> {
  const [row] = await db
    .select({ metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  return recordedWorkspaceVolume(sessionId, row?.metadata);
}

export async function sessionHasWorkspaceVolume(sessionId: string): Promise<boolean> {
  return (await sessionWorkspaceVolume(sessionId)) !== null;
}
