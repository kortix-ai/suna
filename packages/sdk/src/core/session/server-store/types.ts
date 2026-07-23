/**
 * Thin runtime view consumed across the app. The per-session runtime is owned
 * by `current-runtime` (set by the active session via useSession); this store is
 * a stable read surface over it: `getActiveServerUrl()` resolves the active
 * Runtime proxy URL (current runtime, then the local-dev fallback).
 */
export interface ServerStore {
  /** Resolve the active Runtime proxy URL (current runtime + local-dev fallback). */
  getActiveServerUrl: () => string;
}

export const PATH_PROXY_URL_REGEX =
  /^https?:\/\/[^/]+\/v1\/p\/([^/]+)\/(\d+)(\/.*)?$/;
