export type SandboxProvider = 'daytona' | 'local_docker' | 'justavps';

export interface ServerEntry {
  id: string;
  label: string;
  url: string;
  isDefault?: boolean;
  /** Sandbox provider type, if this server was provisioned via platform API */
  provider?: SandboxProvider;
  /** Platform sandbox external ID used for proxy routing (/p/{external_id}/8000). */
  sandboxId?: string;
  /** Stable DB sandbox_id used in instance-scoped frontend routes (/instances/{instanceId}/...). */
  instanceId?: string;
  /**
   * Container-port → host-port map from Docker (local_docker provider).
   * e.g. { "6080": "32001", "8000": "32005", "9223": "32007" }
   * For Daytona, ports are accessed via subdomain routing, so this is unused.
   */
  mappedPorts?: Record<string, string>;
}

/**
 * Thin runtime view consumed across the app. The per-session runtime is owned
 * by `current-runtime` (set by the active session via useSession); this store is
 * a stable read surface over it for the not-yet-migrated consumers.
 *
 *   - `getActiveServerUrl()` resolves the active OpenCode proxy URL (current
 *     runtime, then the local-dev fallback).
 *   - `activeServerId` / `serverVersion` / `urlVersion` / `servers` are inert
 *     read fields kept so existing query/scoping-key consumers keep compiling;
 *     the legacy multi-instance registry + switching machinery is gone.
 */
export interface ServerStore {
  /** Legacy server registry — always empty now; consumers fall back to current-runtime. */
  servers: ServerEntry[];
  /** Stable scoping/query key for the active runtime (kept '' — current-runtime owns identity). */
  activeServerId: string;
  /** Reconnect trigger key — inert; SSE reconnect is driven by current-runtime's own version. */
  serverVersion: number;
  /** Silent re-verify key — inert. */
  urlVersion: number;
  /** Resolve the active OpenCode proxy URL (current runtime + local-dev fallback). */
  getActiveServerUrl: () => string;
}

export const PATH_PROXY_URL_REGEX =
  /^https?:\/\/[^/]+\/v1\/p\/([^/]+)\/(\d+)(\/.*)?$/;
