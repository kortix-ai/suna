/**
 * The boot-artifacts volume (`<volume>@<tag>`) a box that boots `artifacts`
 * or `volume` mounts: the `artifacts` field of the `session_boot_modes`
 * platform setting (read through the shared 30 s cache), else
 * KORTIX_BOOT_ARTIFACTS.
 *
 * Nothing else in that row is read any more: Volumes and Stateless sessions
 * are project feature flags (feature-flags/registry.ts), and the fallback
 * attempts are code constants (boot-mode.ts BOOT_FALLBACK).
 */
import { config } from '../../config';
import { createCachedPlatformSetting } from './platform-setting-cache';

export const BOOT_MODE_SETTING_KEY = 'session_boot_modes';

const setting = createCachedPlatformSetting<string | null>(BOOT_MODE_SETTING_KEY, (value) => {
  const artifacts = (value as { artifacts?: unknown } | null | undefined)?.artifacts;
  return typeof artifacts === 'string' && artifacts.trim() ? artifacts.trim() : null;
});

export function bootArtifactsSpec(): string | null {
  return setting.read() ?? config.KORTIX_BOOT_ARTIFACTS ?? null;
}
