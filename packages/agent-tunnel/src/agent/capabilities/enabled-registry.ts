import type { TunnelConfig } from '../config';
import { CapabilityRegistry } from './index';
import { createDesktopCapability } from './desktop';
import { findCuaDriverBinary } from './desktop/cua-driver';
import { createFilesystemCapability } from './filesystem';
import { createShellCapability } from './shell';

/** Build the local RPC surface from the browser-approved capability ceiling. */
export function createEnabledCapabilityRegistry(
  config: TunnelConfig,
  findDesktopDriver: () => string | null = findCuaDriverBinary,
): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  const enabled = new Set(config.enabledCapabilities ?? ['filesystem', 'shell', 'desktop']);
  if (enabled.has('filesystem')) registry.register(createFilesystemCapability(config));
  if (enabled.has('shell')) registry.register(createShellCapability(config));
  // Do not advertise Computer Use unless this process can execute the trusted
  // local driver. The server must see the real handler surface, not the user's
  // desired capability list.
  if (enabled.has('desktop') && findDesktopDriver()) {
    registry.register(createDesktopCapability());
  }
  return registry;
}
