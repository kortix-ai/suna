import type { TunnelConfig } from '../config';
import { CapabilityRegistry } from './index';
import { createDesktopCapability } from './desktop';
import { findCuaDriverBinary } from './desktop/cua-driver';
import { createFilesystemCapability } from './filesystem';
import { createShellCapability } from './shell';

const DRIVER_NOT_FOUND =
  'cua-driver was not found. The Kortix desktop app bundles it on macOS and Windows; a CLI install needs it in CUA_DRIVER_BIN, ~/.local/bin, /usr/local/bin or /opt/homebrew/bin.';

/**
 * Why Computer Use cannot run here, or null when the trusted local driver is
 * present. Never throws: a rejected driver is a reason, not an agent crash.
 * Missing macOS grants are not a reason: the capability registers and the
 * agent reports `desktopPermissions`, which drive the setup.
 */
export function desktopUnavailableReason(findDesktopDriver: () => string | null = findCuaDriverBinary): string | null {
  try {
    return findDesktopDriver() ? null : DRIVER_NOT_FOUND;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Build the local RPC surface from the browser-approved capability ceiling. */
export function createEnabledCapabilityRegistry(
  config: TunnelConfig,
  findDesktopDriver: () => string | null = findCuaDriverBinary,
  desktop: { onPermissionMissing?: () => void } = {},
): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  const enabled = new Set(config.enabledCapabilities ?? ['filesystem', 'shell', 'desktop']);
  if (enabled.has('filesystem')) registry.register(createFilesystemCapability(config));
  if (enabled.has('shell')) registry.register(createShellCapability(config));
  // Advertise Computer Use only when this process can execute the trusted
  // local driver; otherwise record why, so Kortix shows the reason.
  if (enabled.has('desktop')) {
    const reason = desktopUnavailableReason(findDesktopDriver);
    if (reason) registry.unavailable.set('desktop', reason);
    else registry.register(createDesktopCapability(desktop));
  }
  return registry;
}
