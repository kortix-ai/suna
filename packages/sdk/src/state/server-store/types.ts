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

export interface ServerStore {
  servers: ServerEntry[];
  activeServerId: string;
  /**
   * Last explicitly selected managed sandbox. Managed server entries are
   * rebuilt from the platform API on reload, so this survives the hydration gap
   * where the entry itself is not in `servers` yet.
   */
  lastSelectedInstanceId: string;
  lastSelectedSandboxId: string;
  /** True when the user has manually picked a server via the selector UI. */
  userSelected: boolean;
  /**
   * Bumps ONLY on actual server switches (user picks a different server).
   * The SSE event stream subscribes to this — bumping it nukes all cached
   * queries and reconnects, so it must be used sparingly.
   */
  serverVersion: number;
  /**
   * Bumps on any URL/port update to the active server. The connection
   * health monitor subscribes to this for silent re-verification without
   * nuking cached data.
   */
  urlVersion: number;
  addServer: (label: string, url: string) => ServerEntry;
  /**
   * Add a new managed sandbox as a server entry. Deduplicates by sandboxId —
   * if a server with the same sandboxId already exists, returns it instead.
   * All metadata (provider, sandboxId, mappedPorts) is set atomically.
   */
  addSandboxServer: (entry: {
    label: string;
    provider: SandboxProvider;
    sandboxId: string;
    instanceId?: string;
    mappedPorts?: Record<string, string>;
  }) => ServerEntry;
  updateServer: (id: string, updates: Partial<Pick<ServerEntry, 'label' | 'url'>>) => void;
  /**
   * Silently update a server's URL, ports, provider, and/or sandboxId
   * without triggering a full reconnect (no serverVersion bump). Only
   * bumps urlVersion so the connection monitor re-verifies.
   */
  updateServerSilent: (id: string, updates: Partial<Pick<ServerEntry, 'url' | 'provider' | 'sandboxId' | 'instanceId'>> & { mappedPorts?: Record<string, string>; label?: string }) => void;
  removeServer: (id: string) => void;
  setActiveServer: (id: string, options?: { auto?: boolean; force?: boolean }) => void;
  getActiveServerUrl: () => string;
  clearStatuses: () => void;

  // ── Centralized actions (refactored from scattered callers) ──

  /**
   * Bump serverVersion to trigger a full reconnect (SSE + cached queries).
   * Use instead of direct `setState({ serverVersion: ... })` calls —
   * this is the single point of control for reconnect triggers.
   */
  bumpServerVersion: () => void;

  /**
   * Register or update a managed sandbox entry in the store.
   *
   * In local mode: updates the existing 'default' entry's metadata.
   * In cloud mode: creates or updates the 'cloud-sandbox' entry.
   *
   * Returns the server ID of the registered entry.
   */
  registerOrUpdateSandbox: (sandbox: {
    label: string;
    provider: SandboxProvider;
    sandboxId: string;
    instanceId?: string;
    mappedPorts?: Record<string, string>;
  }, options?: {
    /** If true, auto-switch to this sandbox when user hasn't manually selected */
    autoSwitch?: boolean;
    /** If true, restore this sandbox when it matches the persisted selection */
    restoreSelection?: boolean;
    /** If true, this is local mode — update default entry instead of cloud-sandbox */
    isLocal?: boolean;
    /** Optional stable ID to use for cloud sandboxes (e.g. "sandbox-<sandboxId>") */
    stableId?: string;
  }) => string;

}

export const DEFAULT_SERVER_ID = 'default';
export const CLOUD_SANDBOX_SERVER_ID = 'cloud-sandbox';

export const PATH_PROXY_URL_REGEX =
  /^https?:\/\/[^/]+\/v1\/p\/([^/]+)\/(\d+)(\/.*)?$/;
