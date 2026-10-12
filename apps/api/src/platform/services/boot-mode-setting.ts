/**
 * The Volumes / boot-mode policy row, read through the shared 30 s cache.
 *
 * Kept apart from boot-mode-store.ts (which queries sessions) so the feature
 * flag registry can ask "is Volumes on for this organization?" without
 * importing the database: the cache loads it lazily.
 */
import { config } from '../../config';
import { parseBootModePolicy, resolveVolumes, type BootModePolicy, type VolumesDecision } from './boot-mode';
import { createCachedPlatformSetting } from './platform-setting-cache';

export const BOOT_MODE_SETTING_KEY = 'session_boot_modes';

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

/**
 * Bring this instance's copy of the policy to at most `maxAgeMs` old. The API
 * runs several instances, each with its own 30 s cache, so a project read
 * right after a flag flip can land on one that still holds the old policy
 * and show Volumes and Stateless sessions in the wrong positions.
 */
export async function ensureBootModePolicyFresh(maxAgeMs = 2_000): Promise<void> {
  await setting.readFresh(maxAgeMs);
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

/** The Volumes master switch for one organization (account id). Unknown account ⇒ off. */
export function volumesFor(accountId: string | null | undefined): VolumesDecision {
  return resolveVolumes(bootModePolicy().policy, accountId);
}

export function volumesEnabledFor(accountId: string | null | undefined): boolean {
  return volumesFor(accountId).enabled;
}

/** This organization's own Volumes entry, if it has one (undefined ⇒ the global switch and rollout decide). */
export function volumesOrgEntry(accountId: string | null | undefined): boolean | undefined {
  const id = (accountId ?? '').toLowerCase();
  if (!id) return undefined;
  return bootModePolicy().policy.volumes.orgs[id];
}

/**
 * Set (`true`/`false`) or clear (`null`) one organization's Volumes entry in
 * the same policy row Admin → Volumes edits. The merge runs in SQL on the
 * stored value, so it never overwrites a concurrent change to another field.
 */
export async function setVolumesForOrg(accountId: string, enabled: boolean | null): Promise<void> {
  const id = accountId.toLowerCase();
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('invalid organization id');
  const { db } = await import('../../shared/db');
  const { sql } = await import('drizzle-orm');
  const orgs = (value: ReturnType<typeof sql>) =>
    enabled === null
      ? sql`coalesce(${value}->'volumes'->'orgs', '{}'::jsonb) - ${id}::text`
      : sql`coalesce(${value}->'volumes'->'orgs', '{}'::jsonb) || jsonb_build_object(${id}::text, ${enabled}::boolean)`;
  const merged = (value: ReturnType<typeof sql>) =>
    sql`coalesce(${value}, '{}'::jsonb) || jsonb_build_object('volumes', coalesce(${value}->'volumes', '{}'::jsonb) || jsonb_build_object('orgs', ${orgs(value)}))`;
  await db.execute(sql`
    INSERT INTO kortix.platform_settings (key, value, updated_at)
    VALUES (${BOOT_MODE_SETTING_KEY}, ${merged(sql`NULL::jsonb`)}, now())
    ON CONFLICT (key) DO UPDATE
      SET value = ${merged(sql`kortix.platform_settings.value`)}, updated_at = now()
  `);
  await setting.refresh();
}

/**
 * {@link volumesEnabledFor} that never refuses on a stale or cold cache: an
 * "off" answer is re-read from the database (at most 2 s old) before it
 * stands. Another API instance may have just turned Volumes on, and an
 * instance that just started has no cache at all.
 */
export async function volumesEnabledForFresh(accountId: string | null | undefined): Promise<boolean> {
  if (volumesEnabledFor(accountId)) return true;
  await setting.readFresh(2_000);
  return volumesEnabledFor(accountId);
}

/**
 * Stateless sessions for this organization: Volumes is on and the
 * organization's boot mode (its own rule, else the default) is `volume`, so a
 * stopped session gives up its box and wakes on a fresh one.
 */
export function statelessEnabledFor(accountId: string | null | undefined): boolean {
  const id = (accountId ?? '').toLowerCase();
  if (!id || !volumesEnabledFor(id)) return false;
  const { policy } = bootModePolicy();
  if (policy.killSwitch) return false;
  // Only the organization's own rule: the default never boots on a volume.
  return policy.orgs[id]?.mode === 'volume';
}

/** This organization's own boot-mode rule, if it has one. */
export function bootModeOrgEntry(accountId: string | null | undefined): unknown {
  const id = (accountId ?? '').toLowerCase();
  if (!id) return undefined;
  return bootModePolicy().policy.orgs[id];
}

/**
 * Set the organization's boot mode to `volume` (true) or `standard` (false),
 * or clear its rule (null, back to the default), in the same policy row
 * Admin → Volumes edits. Merged in SQL so other fields are never overwritten.
 */
export async function setStatelessForOrg(accountId: string, enabled: boolean | null): Promise<void> {
  const id = accountId.toLowerCase();
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('invalid organization id');
  const { db } = await import('../../shared/db');
  const { sql } = await import('drizzle-orm');
  const mode = enabled ? 'volume' : 'standard';
  const orgs = (value: ReturnType<typeof sql>) =>
    enabled === null
      ? sql`coalesce(${value}->'orgs', '{}'::jsonb) - ${id}::text`
      : sql`coalesce(${value}->'orgs', '{}'::jsonb) || jsonb_build_object(${id}::text, jsonb_build_object('mode', ${mode}::text, 'standardFallback', true))`;
  const merged = (value: ReturnType<typeof sql>) =>
    sql`coalesce(${value}, '{}'::jsonb) || jsonb_build_object('orgs', ${orgs(value)})`;
  await db.execute(sql`
    INSERT INTO kortix.platform_settings (key, value, updated_at)
    VALUES (${BOOT_MODE_SETTING_KEY}, ${merged(sql`NULL::jsonb`)}, now())
    ON CONFLICT (key) DO UPDATE
      SET value = ${merged(sql`kortix.platform_settings.value`)}, updated_at = now()
  `);
  await setting.refresh();
}
