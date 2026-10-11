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
