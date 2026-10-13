/**
 * The boot-mode policy row, read through the shared 30 s cache. The cache
 * loads it lazily, so importing this file does not import the database.
 */
import { config } from '../../config';
import { parseBootModePolicy, type BootModePolicy } from './boot-mode';
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
