import { create } from 'zustand';

import { getActiveOpenCodeUrl } from './server-store/active';
import type { ServerStore } from './server-store/types';

// Re-export the public surface that lives in sibling modules so importers of
// '../state/server-store' (and '@kortix/sdk/server-store') stay unchanged.
export { getSandboxUrlForExternalId, getPublicShareUrlForToken } from './server-store/url-helpers';
export {
  deriveSubdomainOpts,
  getActiveDbSandboxId,
  getActiveOpenCodeUrl,
  getActiveSandboxId,
  getBackendPort,
} from './server-store/active';

/**
 * server-store — a thin, read-only view over the per-session runtime.
 *
 * The runtime (which sandbox the app talks to) is owned by `current-runtime`,
 * set by the active session via `useSession`. This store exposes it as a stable
 * surface: `getActiveServerUrl()` resolves the active OpenCode proxy URL. The
 * old multi-instance registry, the persisted server list, and the server-
 * switching machinery are gone — there is no "active server" to switch.
 *
 * The resolution helpers themselves live in `./server-store/active` (framework-
 * free, part of the isomorphic core); this module adds only the zustand read
 * surface for React hosts.
 */
export const useServerStore = create<ServerStore>(() => ({
  getActiveServerUrl: () => getActiveOpenCodeUrl(),
}));
