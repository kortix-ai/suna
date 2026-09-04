/**
 * Thin runtime view consumed across the app. The per-session runtime is owned
 * by `current-runtime` (set by the active session via useSession); this store is
 * a stable read surface over it: `getActiveServerUrl()` resolves control
 * traffic and `getActiveWorkspaceUrl()` resolves files, PTYs, and ports.
 */
export interface ServerStore {
  /** Resolve the active OpenCode proxy URL (current runtime + local-dev fallback). */
  getActiveServerUrl: () => string;
  /** Resolve the runtime that owns files, PTYs, and user ports. */
  getActiveWorkspaceUrl: () => string;
}

export const PATH_PROXY_URL_REGEX = /^https?:\/\/[^/]+\/v1\/p\/([^/]+)\/(\d+)(\/.*)?$/;
