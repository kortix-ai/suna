/**
 * Storage and lookups for session boot modes (boot-mode.ts holds the rules).
 * A new box's mode follows its project's Volumes and Stateless sessions flags.
 */
import { config } from '../../config';
import { projects, projectSessions } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { isPlatinumConfigured } from '../../shared/platinum';
import {
  parseSessionBootRecord,
  resolveBootMode,
  type BootModeDecision,
  type SessionBootRecord,
} from './boot-mode';

export { BOOT_MODE_SETTING_KEY, bootArtifactsSpec } from './boot-mode-setting';

/** project_sessions.metadata key holding the session's SessionBootRecord. */
export const SESSION_BOOT_KEY = 'bootMode';

/**
 * KORTIX_EPHEMERAL_SANDBOXES=off: no new volume boxes. An operator emergency
 * override, not the product switch (that is the project's Stateless sessions flag).
 */
export function envVolumeOff(): boolean {
  const raw = (config.KORTIX_EPHEMERAL_SANDBOXES ?? '').trim().toLowerCase();
  return raw === '0' || raw === 'off' || raw === 'false' || raw === 'no';
}

/** The mode a new box of this project's session asks for on `provider`. */
export async function resolveProjectBootMode(input: {
  projectId: string;
  provider: string;
  /** The project's metadata when the caller already holds it; read otherwise. */
  projectMetadata?: unknown;
}): Promise<BootModeDecision> {
  const volumeProvider = input.provider === 'platinum' && isPlatinumConfigured();
  let metadata = input.projectMetadata;
  if (volumeProvider && metadata === undefined) {
    const [row] = await db
      .select({ metadata: projects.metadata })
      .from(projects)
      .where(eq(projects.projectId, input.projectId))
      .limit(1);
    metadata = row?.metadata ?? null;
  }
  const { resolveFeatureFlag } = await import('../../feature-flags/registry');
  return resolveBootMode({
    volumeProvider,
    volumes: resolveFeatureFlag(metadata, 'volumes'),
    stateless: resolveFeatureFlag(metadata, 'stateless_sessions'),
    envVolumeOff: envVolumeOff(),
  });
}

export async function readSessionBoot(
  sessionId: string,
): Promise<{ record: SessionBootRecord | null; stateVolume: string | null }> {
  const [row] = await db
    .select({ metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  const md = (row?.metadata ?? {}) as Record<string, unknown>;
  const { ownSessionStateVolume } = await import('./ephemeral-sandbox');
  return {
    record: parseSessionBootRecord(md[SESSION_BOOT_KEY]),
    stateVolume: ownSessionStateVolume(sessionId, md),
  };
}

/**
 * Persist the session's boot record. `dropStateVolume` forgets a session
 * volume that never held a booted box's state, so later boots do not insist
 * on it, and queues that volume for deletion in the same statement: once
 * forgotten, neither the session delete nor the cascade trigger would ever
 * name it again, and it would hold one of the workspace's volumes forever.
 * The delay lets the failed box that mounted it go first; a volume still
 * mounted is refused by storage and retried.
 */
export async function writeSessionBoot(
  sessionId: string,
  record: SessionBootRecord,
  opts: { dropStateVolume?: boolean } = {},
): Promise<void> {
  const trimmed: SessionBootRecord = { ...record, fallbacks: record.fallbacks.slice(-10) };
  const patch = JSON.stringify({ [SESSION_BOOT_KEY]: trimmed });
  if (opts.dropStateVolume) {
    const { sessionStateVolumeName } = await import('./ephemeral-sandbox');
    // Every sub-statement reads the row as it was before the UPDATE, so
    // `prev` sees the volume being forgotten. Only the session's own volume.
    await db.execute(sql`
      WITH prev AS (
        SELECT metadata->>'ephemeral_state_volume' AS volume
          FROM kortix.project_sessions
         WHERE session_id = ${sessionId}
           FOR UPDATE
      ), upd AS (
        UPDATE kortix.project_sessions
           SET metadata = (coalesce(metadata, '{}'::jsonb) || ${patch}::jsonb) - 'ephemeral_state_volume'
         WHERE session_id = ${sessionId}
      )
      INSERT INTO kortix.platinum_volume_deletions (volume_name, reason, not_before)
      SELECT volume, 'session_volume_dropped', now() + interval '20 seconds'
        FROM prev
       WHERE volume = ${sessionStateVolumeName(sessionId)}
      ON CONFLICT (volume_name) DO NOTHING
    `);
    return;
  }
  await db
    .update(projectSessions)
    .set({ metadata: sql`coalesce(${projectSessions.metadata}, '{}'::jsonb) || ${patch}::jsonb` })
    .where(eq(projectSessions.sessionId, sessionId));
}
