/**
 * Storage and lookups for session boot modes (boot-mode.ts holds the rules).
 *
 * The policy is ONE `kortix.platform_settings` row, read through the shared
 * 30 s cache so the provisioning path never waits on it. A missing row is the
 * env-driven behavior from before the console existed.
 */
import { projects, projectSessions } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { config } from '../../config';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { db } from '../../shared/db';
import { isPlatinumConfigured } from '../../shared/platinum';
import {
  parseBootModePolicy,
  parseSessionBootRecord,
  resolveBootMode,
  type BootModeDecision,
  type BootModePolicy,
  type SessionBootRecord,
} from './boot-mode';
import { createCachedPlatformSetting } from './platform-setting-cache';

export const BOOT_MODE_SETTING_KEY = 'session_boot_modes';
/** project_sessions.metadata key holding the session's SessionBootRecord. */
export const SESSION_BOOT_KEY = 'bootMode';

const envArtifactsSet = (): boolean => Boolean((config.KORTIX_BOOT_ARTIFACTS ?? '').trim());

const setting = createCachedPlatformSetting<{ stored: boolean; policy: BootModePolicy }>(
  BOOT_MODE_SETTING_KEY,
  (value) => ({
    stored: value !== undefined && value !== null,
    policy: parseBootModePolicy(value, envArtifactsSet()),
  }),
);

export function bootModePolicy(): { stored: boolean; policy: BootModePolicy } {
  return setting.read();
}

export async function refreshBootModePolicy(): Promise<{ stored: boolean; policy: BootModePolicy }> {
  await setting.refresh();
  return setting.read();
}

export async function saveBootModePolicy(policy: BootModePolicy): Promise<void> {
  await setting.write(policy);
}

export function __setBootModePolicyForTests(value: unknown): void {
  setting.__setForTests(value);
}

/** KORTIX_EPHEMERAL_SANDBOXES=off: no new volume boxes. */
export function envVolumeOff(): boolean {
  const raw = (process.env.KORTIX_EPHEMERAL_SANDBOXES ?? '').trim().toLowerCase();
  return raw === '0' || raw === 'off' || raw === 'false' || raw === 'no';
}

/** The mode a new box of this project's session asks for on `provider`. */
export async function resolveProjectBootMode(input: {
  accountId?: string | null;
  projectId: string;
  provider: string;
  projectMetadata?: unknown;
}): Promise<BootModeDecision> {
  const volumeProvider = input.provider === 'platinum' && isPlatinumConfigured();
  let accountId = input.accountId ?? null;
  let metadata = input.projectMetadata;
  if (volumeProvider && (!accountId || metadata === undefined)) {
    const [row] = await db
      .select({ accountId: projects.accountId, metadata: projects.metadata })
      .from(projects)
      .where(eq(projects.projectId, input.projectId))
      .limit(1);
    accountId = accountId ?? row?.accountId ?? null;
    if (metadata === undefined) metadata = row?.metadata;
  }
  return resolveBootMode(bootModePolicy().policy, {
    accountId: accountId ?? '',
    volumeProvider,
    projectVolumeFlag: volumeProvider && resolveFeatureFlag(metadata, 'ephemeral_sandboxes'),
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
  const vol = md.ephemeral_state_volume;
  return {
    record: parseSessionBootRecord(md[SESSION_BOOT_KEY]),
    stateVolume: typeof vol === 'string' && vol ? vol : null,
  };
}

/**
 * Persist the session's boot record. `dropStateVolume` forgets a session
 * volume that never held a booted box's state, so later boots do not insist
 * on it.
 */
export async function writeSessionBoot(
  sessionId: string,
  record: SessionBootRecord,
  opts: { dropStateVolume?: boolean } = {},
): Promise<void> {
  const trimmed: SessionBootRecord = { ...record, fallbacks: record.fallbacks.slice(-10) };
  const merged = sql`coalesce(${projectSessions.metadata}, '{}'::jsonb) || ${JSON.stringify({ [SESSION_BOOT_KEY]: trimmed })}::jsonb`;
  await db
    .update(projectSessions)
    .set({ metadata: opts.dropStateVolume ? sql`(${merged}) - 'ephemeral_state_volume'` : merged })
    .where(eq(projectSessions.sessionId, sessionId));
}

export interface BootModeStats {
  since: string;
  modes: Array<{ mode: string; requested: number; booted: number }>;
  fallbacks: Array<{ from: string; to: string; reason: string; count: number; sample: string | null }>;
}

/** Sessions booted per mode and fallbacks taken, over the last `hours`. */
export async function bootModeStats(hours = 24): Promise<BootModeStats> {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const modes = (await db.execute(sql`
    WITH s AS (
      SELECT metadata->'bootMode' AS bm FROM kortix.project_sessions
       WHERE metadata ? 'bootMode' AND metadata->'bootMode'->>'updatedAt' > ${since}
    ), m AS (SELECT unnest(ARRAY['standard','artifacts','volume']) AS mode)
    SELECT m.mode,
           (SELECT count(*) FROM s WHERE s.bm->>'requested' = m.mode)::int AS requested,
           (SELECT count(*) FROM s WHERE s.bm->>'mode' = m.mode AND s.bm->>'bootedAt' > ${since})::int AS booted
      FROM m
  `)) as unknown;
  const fallbacks = (await db.execute(sql`
    SELECT e->>'from' AS "from", e->>'to' AS "to", e->>'reason' AS reason,
           count(*)::int AS count, max(e->>'detail') AS sample
      FROM kortix.project_sessions ps,
           jsonb_array_elements(coalesce(ps.metadata->'bootMode'->'fallbacks', '[]'::jsonb)) e
     WHERE ps.metadata ? 'bootMode' AND e->>'at' > ${since}
     GROUP BY 1, 2, 3
     ORDER BY 4 DESC
  `)) as unknown;
  const rows = <T>(r: unknown): T[] => ((r as { rows?: T[] })?.rows ?? (r as T[])) ?? [];
  return { since, modes: [...rows<BootModeStats['modes'][number]>(modes)], fallbacks: [...rows<BootModeStats['fallbacks'][number]>(fallbacks)] };
}
