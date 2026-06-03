import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSafeJSONStorage } from '@/lib/storage/managed-storage';

import { authenticatedFetch, getSupabaseAccessToken } from '@/lib/auth-token';
import { isBillingEnabled } from '@/lib/config';
import { getEnv } from '@/lib/env-config';
import { setActiveInstanceCookie } from '@/lib/instance-routes';

/**
 * SDK client reset callback — set by opencode-sdk.ts to break the circular
 * dependency (server-store → opencode-sdk → server-store). Called when the
 * active server or token changes to force client recreation.
 */
let _resetClient: (() => void) | null = null;

/** Called by opencode-sdk.ts at module load to register the reset function. */
export function registerClientResetter(fn: () => void): void {
  _resetClient = fn;
}

function resetSDKClient(): void {
  _resetClient?.();
}

type SandboxProvider = 'daytona' | 'local_docker';

export interface ServerEntry {
  id: string;
  label: string;
  url: string;
  isDefault?: boolean;
  /** Sandbox provider type, if this server was provisioned via platform API */
  provider?: SandboxProvider;
  /** Platform sandbox external ID used for proxy routing (/p/{external_id}/8000). */
  sandboxId?: string;
  /** Stable DB sandbox_id used to associate project/session sandboxes with server entries. */
  instanceId?: string;
  /**
   * Container-port → host-port map from Docker (local_docker provider).
   * e.g. { "6080": "32001", "8000": "32005", "9223": "32007" }
   * For Daytona, ports are accessed via subdomain routing, so this is unused.
   */
  mappedPorts?: Record<string, string>;
}

interface ServerStore {
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

/**
 * The default sandbox URL routes through the backend's unified preview proxy.
 * Uses the container name ('kortix-sandbox') as the sandbox ID — the backend
 * resolves this via Docker DNS on the shared network.
 * Same URL pattern for all providers: /v1/p/{sandboxId}/{port}/*
 */
function getBackendUrl(): string {
  return (getEnv().BACKEND_URL || 'http://localhost:8008/v1').replace(/\/+$/, '');
}

function getDefaultSandboxUrl(): string {
  return `${getBackendUrl()}/p/kortix-sandbox/8000`;
}

function getServersApi(): string {
  return `${getBackendUrl()}/servers`;
}

/**
 * Derive the proxy URL for a managed sandbox entry.
 * Always computed fresh — never persisted — so route renames can't go stale.
 */
function getSandboxServerUrl(sandboxId: string): string {
  return `${getBackendUrl()}/p/${sandboxId}/8000`;
}

/**
 * Derive the OpenCode proxy URL for a sandbox by its provider sandbox id
 * (a project session's `external_id`). Pure function of the id — no dependency
 * on the active server — so we can connect to several session sandboxes in
 * parallel (e.g. background SSE streams for every open session tab).
 */
export function getSandboxUrlForExternalId(externalId: string): string {
  return getSandboxServerUrl(externalId);
}

const DEFAULT_SERVER_ID = 'default';
const CLOUD_SANDBOX_SERVER_ID = 'cloud-sandbox';

const PATH_PROXY_URL_REGEX =
  /^https?:\/\/[^/]+\/v1\/p\/([^/]+)\/(\d+)(\/.*)?$/;

function deriveProxyBaseFromServerUrl(url: string): { sandboxId: string; backendPort: number; apiBaseUrl: string } | null {
  try {
    const parsed = new URL(url);
    const subdomainMatch = parsed.hostname.match(/^p(\d+)-([^.]+)\.localhost$/);
    if (subdomainMatch) {
      const backendPort = parseInt(parsed.port, 10) || (parsed.protocol === 'https:' ? 443 : 80);
      return {
        sandboxId: subdomainMatch[2],
        backendPort,
        apiBaseUrl: `http://localhost:${backendPort}/v1`,
      };
    }

    const pathMatch = url.match(PATH_PROXY_URL_REGEX);
    if (pathMatch) {
      return {
        sandboxId: pathMatch[1],
        backendPort: parseInt(parsed.port, 10) || (parsed.protocol === 'https:' ? 443 : 80),
        apiBaseUrl: `${parsed.protocol}//${parsed.host}/v1`,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function generateId(): string {
  return `srv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── API sync helpers (fire-and-forget) ──────────────────────────────────────
// ONLY custom user-added instances are synced to the servers API.
// Managed sandbox entries ('default', 'cloud-sandbox') come from runtime/session
// registration paths — they live in zustand/localStorage only.

/** IDs of managed entries that should NOT be synced to the servers API. */
const MANAGED_IDS = new Set([DEFAULT_SERVER_ID, CLOUD_SANDBOX_SERVER_ID]);

/** True if this entry is a managed sandbox (not a custom user entry). */
function isManagedEntry(s: ServerEntry | string): boolean {
  const id = typeof s === 'string' ? s : s.id;
  // Also matches per-sandbox stable IDs (e.g. "sandbox-<sandboxId>")
  if (MANAGED_IDS.has(id) || id.startsWith('sandbox-')) return true;
  if (typeof s !== 'string') {
    // Older builds leaked managed sandbox proxy URLs into custom-server
    // persistence without provider metadata. If left in localStorage/API sync,
    // the app keeps reconnecting to stale /v1/p/<old-id>/8000 URLs and the
    // backend correctly returns 403. Treat any backend preview-proxy URL as
    // managed/ephemeral so it is stripped and rebuilt from fresh sandbox rows.
    if (s.provider) return true;
    if (s.url && PATH_PROXY_URL_REGEX.test(s.url)) return true;
  }
  return false;
}

function toApiPayload(s: ServerEntry) {
  return {
    id: s.id,
    label: s.label,
    url: s.url,
    isDefault: s.isDefault,
    provider: s.provider,
    sandboxId: s.sandboxId,
    mappedPorts: s.mappedPorts,
  };
}

function syncServerToApi(server: ServerEntry) {
  if (isManagedEntry(server)) return; // managed entries are not persisted to API
  authenticatedFetch(`${getServersApi()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(toApiPayload(server)),
  }, { retryOnAuthError: false }).catch(() => {}); // fire-and-forget
}

function deleteServerFromApi(id: string) {
  if (isManagedEntry(id)) return;
  authenticatedFetch(`${getServersApi()}/${id}`, { method: 'DELETE' },
    { retryOnAuthError: false }).catch(() => {});
}

function selectedSandboxPatch(server: ServerEntry | null | undefined) {
  if (!server?.provider && !server?.instanceId && !server?.sandboxId) return {};
  return {
    lastSelectedInstanceId: server.instanceId ?? '',
    lastSelectedSandboxId: server.sandboxId ?? '',
  };
}

/** Bulk sync all servers to API (used on initial hydration). */
function syncAllToApi(servers: ServerEntry[]) {
  const custom = servers.filter((s) => !isManagedEntry(s));
  if (custom.length === 0) return;
  authenticatedFetch(`${getServersApi()}/sync`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ servers: custom.map(toApiPayload) }),
  }, { retryOnAuthError: false }).catch(() => {});
}

/** Load servers from API. */
async function loadFromApi(): Promise<ServerEntry[] | null> {
  try {
    const res = await authenticatedFetch(getServersApi(), undefined,
      { retryOnAuthError: false });
    if (!res.ok) return null;
    const rows: Array<{
      id: string;
      label: string;
      url: string;
      isDefault: boolean;
      provider: 'daytona' | 'local_docker' | null;
      sandboxId: string | null;
      mappedPorts: Record<string, string> | null;
    }> = await res.json();
    if (!rows.length) return null;

    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      url: r.url,
      isDefault: r.isDefault,
      provider: r.provider ?? undefined,
      sandboxId: r.sandboxId ?? undefined,
      mappedPorts: r.mappedPorts ?? undefined,
    })).filter((entry) => !isManagedEntry(entry));
  } catch {
    return null;
  }
}

export const useServerStore = create<ServerStore>()(
  persist(
    (set, get) => ({
      // Starts empty — runtime/session sandboxes are registered by active pages.
      servers: [],
      activeServerId: '',
      lastSelectedInstanceId: '',
      lastSelectedSandboxId: '',
      userSelected: false,
      serverVersion: 0,
      urlVersion: 0,

      addServer: (label: string, url: string) => {
        const normalizedUrl = url.replace(/\/+$/, '');
        const newServer: ServerEntry = {
          id: generateId(),
          label: label || normalizedUrl.replace(/^https?:\/\//, ''),
          url: normalizedUrl,
        };
        set((state) => ({
          servers: [...state.servers, newServer],
        }));
        syncServerToApi(newServer);
        return newServer;
      },

      addSandboxServer: (entry) => {
        const state = get();
        // Deduplicate: if a server with this sandboxId already exists, return it.
        const existing = state.servers.find((s) => s.sandboxId === entry.sandboxId);
        if (existing) return existing;

        const newServer: ServerEntry = {
          id: generateId(),
          label: entry.label || entry.sandboxId,
          url: '',  // Sandbox URLs are derived at runtime via getSandboxServerUrl()
          provider: entry.provider,
          sandboxId: entry.sandboxId,
          instanceId: entry.instanceId,
          mappedPorts: entry.mappedPorts,
        };
        set((state) => ({
          servers: [...state.servers, newServer],
        }));
        // Sandbox entries are NOT synced to the servers API — they come from
        // the sandboxes table. Only custom user-added entries are synced.
        return newServer;
      },

      updateServer: (id: string, updates: Partial<Pick<ServerEntry, 'label' | 'url'>>) => {
        const state = get();
        const isActive = state.activeServerId === id;
        set((state) => ({
          servers: state.servers.map((s) =>
            s.id === id
              ? {
                  ...s,
                  ...updates,
                  url: updates.url ? updates.url.replace(/\/+$/, '') : s.url,
                }
              : s,
          ),
          // Manual updateServer bumps serverVersion (full reconnect) —
          // use updateServerSilent for sandbox URL/port changes.
          ...(isActive && updates.url ? { serverVersion: state.serverVersion + 1 } : {}),
        }));
        // Sync non-token updates to API
        if (updates.label || updates.url) {
          const updated = get().servers.find((s) => s.id === id);
          if (updated) syncServerToApi(updated);
        }
      },

      updateServerSilent: (id, updates) => {
        const state = get();
        const isActive = state.activeServerId === id;
        const existing = state.servers.find((s) => s.id === id);
        if (!existing) return;

        const urlChanged = updates.url != null && updates.url !== existing.url;
        const portsChanged =
          updates.mappedPorts != null &&
          JSON.stringify(existing.mappedPorts) !== JSON.stringify(updates.mappedPorts);
        const providerChanged = updates.provider != null && updates.provider !== existing.provider;
        const sandboxIdChanged = updates.sandboxId != null && updates.sandboxId !== existing.sandboxId;
        const instanceIdChanged = updates.instanceId != null && updates.instanceId !== existing.instanceId;

        if (!urlChanged && !portsChanged && !updates.label && !providerChanged && !sandboxIdChanged && !instanceIdChanged) return;

        set((state) => ({
          servers: state.servers.map((s) =>
            s.id === id
              ? {
                  ...s,
                  ...(updates.url ? { url: updates.url.replace(/\/+$/, '') } : {}),
                  ...(updates.label ? { label: updates.label } : {}),
                  ...(updates.mappedPorts ? { mappedPorts: updates.mappedPorts } : {}),
                  ...(updates.provider != null ? { provider: updates.provider } : {}),
                  ...(updates.sandboxId != null ? { sandboxId: updates.sandboxId } : {}),
                  ...(updates.instanceId != null ? { instanceId: updates.instanceId } : {}),
                }
              : s,
          ),
          // When the sandbox itself changed, force a full reconnect (SSE + queries).
          // For URL/port-only changes, only bump urlVersion (silent re-verify).
          ...(isActive && sandboxIdChanged
            ? { serverVersion: state.serverVersion + 1 }
            : isActive && (urlChanged || portsChanged)
              ? { urlVersion: state.urlVersion + 1 }
              : {}),
        }));
        // Sync to API
        const updated = get().servers.find((s) => s.id === id);
        if (updated) syncServerToApi(updated);
      },

      removeServer: (id: string) => {
        const state = get();
        const server = state.servers.find((s) => s.id === id);
        if (server?.isDefault) return;

        const wasActive = state.activeServerId === id;
        const newServers = state.servers.filter((s) => s.id !== id);

        // Find a valid fallback — prefer 'default', then first remaining, then empty.
        const fallbackId = wasActive
          ? (newServers.find((s) => s.id === DEFAULT_SERVER_ID)?.id
            ?? newServers[0]?.id
            ?? '')
          : state.activeServerId;

        set({
          servers: newServers,
          activeServerId: fallbackId,
          ...(wasActive && server ? selectedSandboxPatch(newServers.find((s) => s.id === fallbackId) ?? null) : {}),
          // If we removed the active server, bump version and reset userSelected
          // so the next sandbox creation can auto-switch.
          ...(wasActive ? {
            serverVersion: state.serverVersion + 1,
            userSelected: false,
          } : {}),
        });
        deleteServerFromApi(id);
      },

      setActiveServer: (id: string, options?: { auto?: boolean; force?: boolean }) => {
        const state = get();
        const isSameId = state.activeServerId === id;
        const target = state.servers.find((s) => s.id === id) ?? null;

        if (isSameId && !(options as { auto?: boolean; force?: boolean } | undefined)?.force) {
          syncActiveInstanceCookie(target);
          return;
        } // true no-op — same server, no data change

        // Force SDK client to recreate for the new server URL
        resetSDKClient();
        syncActiveInstanceCookie(target);

        set({
          activeServerId: id,
          serverVersion: state.serverVersion + 1,
          ...selectedSandboxPatch(target),
          // Mark userSelected unless this is an automatic runtime switch.
          ...(options?.auto ? {} : { userSelected: true }),
        });
      },

      getActiveServerUrl: () => {
        const state = get();
        const active = state.servers.find((s) => s.id === state.activeServerId);
        if (!active) {
	          // In cloud mode, don't fall back to the local Docker URL.
          // Returning '' signals callers to wait / skip the request.
          if (state.activeServerId === CLOUD_SANDBOX_SERVER_ID || isBillingEnabled()) return '';
           // For local mode (empty activeServerId or 'default'), fall back
           // to DEFAULT_SANDBOX_URL so the app works during the rehydration gap.
           return getDefaultSandboxUrl();
        }
        // Sandbox entries: always derive URL fresh (never stale)
        if (active.sandboxId) return getSandboxServerUrl(active.sandboxId);
        // Custom entries: use the user-provided URL
        return active.url || getDefaultSandboxUrl();
      },

      clearStatuses: () => {
        // placeholder -- the session status store subscribes to version changes
      },

      // ── Centralized actions ──

      bumpServerVersion: () => {
        set((state) => ({ serverVersion: state.serverVersion + 1 }));
      },

      registerOrUpdateSandbox: (sandbox, options) => {
        const state = get();
        const isLocal = options?.isLocal ?? false;
        const autoSwitch = options?.autoSwitch ?? false;
        const restoreSelection = options?.restoreSelection ?? true;
        const targetId = options?.stableId ?? (isLocal ? DEFAULT_SERVER_ID : CLOUD_SANDBOX_SERVER_ID);

        // In pure local mode, keep using the default entry. Discovered local sandboxes
        // with their own stable IDs flow through the generic managed-sandbox branch.
        if (isLocal && targetId === DEFAULT_SERVER_ID) {
          const defaultEntry = state.servers.find((s) => s.id === DEFAULT_SERVER_ID);
          if (defaultEntry) {
            get().updateServerSilent(DEFAULT_SERVER_ID, {
              mappedPorts: sandbox.mappedPorts,
              provider: sandbox.provider,
              sandboxId: sandbox.sandboxId,
              instanceId: sandbox.instanceId,
              ...(sandbox.label ? { label: sandbox.label } : {}),
            });
          } else {
            // Entry was stripped on rehydration — re-create it now.
            const wasPendingActive = state.activeServerId === DEFAULT_SERVER_ID;
            const newDefault: ServerEntry = {
              id: DEFAULT_SERVER_ID,
              label: sandbox.label || 'Local Sandbox',
              url: '',
              isDefault: true,
              provider: sandbox.provider,
              sandboxId: sandbox.sandboxId,
              instanceId: sandbox.instanceId,
              mappedPorts: sandbox.mappedPorts,
            };
            set((s) => ({
              servers: [...s.servers, newDefault],
              ...(wasPendingActive ? { serverVersion: s.serverVersion + 1 } : {}),
            }));
          }
          const freshAfterLocalRegister = get();
          const matchesLastSelection = restoreSelection && (
            (!!sandbox.instanceId && freshAfterLocalRegister.lastSelectedInstanceId === sandbox.instanceId) ||
            (!!sandbox.sandboxId && freshAfterLocalRegister.lastSelectedSandboxId === sandbox.sandboxId)
          );
          if (matchesLastSelection) {
            get().setActiveServer(DEFAULT_SERVER_ID, { auto: true, force: true });
            set({ userSelected: true });
          }
          // Auto-switch to local default if nothing is selected.
          if (autoSwitch) {
            const fresh = get();
            const currentId = fresh.activeServerId;
            const noActiveServer = !currentId || !fresh.servers.some((s) => s.id === currentId);
            if (!fresh.userSelected && noActiveServer) {
              get().setActiveServer(DEFAULT_SERVER_ID, { auto: true });
            }
          }
          return DEFAULT_SERVER_ID;
        }

        // Cloud mode: use the stable ID from options, or fall back to CLOUD_SANDBOX_SERVER_ID.
        // First check if an entry with this instanceId already exists under ANY id —
        // prevents duplicates when different callers derive different stable IDs for
        // the same sandbox (e.g. 'cloud-sandbox' vs 'sandbox-<id>').
        const existingByInstance = sandbox.instanceId
          ? state.servers.find((s) => s.instanceId === sandbox.instanceId && isManagedEntry(s))
          : null;
        const resolvedTargetId = existingByInstance?.id ?? targetId;
        const existing = existingByInstance ?? state.servers.find((s) => s.id === resolvedTargetId);

        if (existing) {
          get().updateServerSilent(existing.id, {
            label: sandbox.label || existing.label,
            mappedPorts: sandbox.mappedPorts,
            provider: sandbox.provider,
            sandboxId: sandbox.sandboxId,
            instanceId: sandbox.instanceId,
          });
        } else {
          const newEntry: ServerEntry = {
            id: resolvedTargetId,
            label: sandbox.label,
            url: '',  // Sandbox URLs are derived at runtime via getSandboxServerUrl()
            provider: sandbox.provider,
            sandboxId: sandbox.sandboxId,
            instanceId: sandbox.instanceId,
            mappedPorts: sandbox.mappedPorts,
          };
          const wasPendingActive = state.activeServerId === resolvedTargetId;
          set((state) => ({
            servers: [...state.servers, newEntry],
            ...(wasPendingActive ? { serverVersion: state.serverVersion + 1 } : {}),
          }));
        }

        const freshAfterRegister = get();
        const matchesLastSelection = restoreSelection && (
          (!!sandbox.instanceId && freshAfterRegister.lastSelectedInstanceId === sandbox.instanceId) ||
          (!!sandbox.sandboxId && freshAfterRegister.lastSelectedSandboxId === sandbox.sandboxId)
        );
        if (matchesLastSelection) {
          get().setActiveServer(resolvedTargetId, { auto: true, force: true });
          set({ userSelected: true });
        }

        // Auto-switch to the sandbox if the user hasn't manually picked a server.
        // Covers: empty activeServerId (after rehydration stripped managed entries),
        // DEFAULT_SERVER_ID (local mode), or the same targetId (no-op in setActiveServer).
        // Uses get() for fresh state so the newly-added entry is visible.
        if (autoSwitch) {
          const fresh = get();
          const currentId = fresh.activeServerId;
          const noActiveServer = !currentId || !fresh.servers.some((s) => s.id === currentId);
          if (!fresh.userSelected && (noActiveServer || currentId === DEFAULT_SERVER_ID)) {
            get().setActiveServer(isLocal && resolvedTargetId === DEFAULT_SERVER_ID ? DEFAULT_SERVER_ID : resolvedTargetId, { auto: true });
          }
        }

        return resolvedTargetId;
      },

    }),
    {
      name: 'opencode-servers-v6', // v6: sandbox URLs derived at runtime, never persisted
      storage: createSafeJSONStorage(),
      partialize: (state) => ({
        servers: state.servers.filter((s) => !isManagedEntry(s)),
        activeServerId: state.activeServerId,
        lastSelectedInstanceId: state.lastSelectedInstanceId,
        lastSelectedSandboxId: state.lastSelectedSandboxId,
        userSelected: state.userSelected,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        state.lastSelectedInstanceId = state.lastSelectedInstanceId ?? '';
        state.lastSelectedSandboxId = state.lastSelectedSandboxId ?? '';

	        // Remove ALL managed sandbox entries from localStorage. Runtime/session
	        // registration rebuilds active managed entries. This strips:
        //   - Well-known IDs (default, cloud-sandbox)
        //   - Stale random-ID entries (srv_xxx) that have a provider set
        //     (leaked from addSandboxServer calls in older code)
        // Only custom user-added entries (no provider) survive rehydration.
        state.servers = state.servers.filter(
          (s) => !isManagedEntry(s) && !s.provider,
        );

        // Managed sandbox entries are rebuilt from the platform API, so the
        // active server may be missing during hydration. Keep the selected
	        // managed ID/cookie alive so refresh can restore the same instance.
        if (state.activeServerId && !state.servers.some((s) => s.id === state.activeServerId)) {
          const activeLooksManaged =
            state.activeServerId === DEFAULT_SERVER_ID ||
            state.activeServerId === CLOUD_SANDBOX_SERVER_ID ||
            state.activeServerId.startsWith('sandbox-');
          const hasPersistedSandboxSelection = !!state.lastSelectedInstanceId || !!state.lastSelectedSandboxId;

          if (activeLooksManaged || hasPersistedSandboxSelection) {
            state.userSelected = true;
          } else {
            state.activeServerId = state.servers[0]?.id ?? '';
            state.userSelected = false;
          }
        }

        const active = state.servers.find((s) => s.id === state.activeServerId) ?? null;
        if (active) {
          syncActiveInstanceCookie(active);
        } else if (state.lastSelectedInstanceId) {
          setActiveInstanceCookie(state.lastSelectedInstanceId);
        } else {
          syncActiveInstanceCookie(null);
        }

        // Load custom entries from API (user-added URLs).
	        // Sandbox entries come from runtime/session registration, not from here.
        // Only sync with API if user is authenticated — otherwise these
        // fire-and-forget requests produce 401 console errors on the homepage.
        const localServers = [...state.servers];
        getSupabaseAccessToken().then((token) => {
          if (!token) return; // Not authenticated, skip API sync
          loadFromApi().then((apiEntries) => {
            if (apiEntries && apiEntries.length > 0) {
              // Merge: keep sandbox entries from zustand + custom entries from API
              const currentState = useServerStore.getState();
              const sandboxEntries = currentState.servers.filter((s) => s.provider);
              const apiIds = new Set(apiEntries.map((s) => s.id));
              const kept = sandboxEntries.filter((s) => !apiIds.has(s.id));
              useServerStore.setState({ servers: [...kept, ...apiEntries] });
            } else {
              syncAllToApi(localServers);
            }
          });
        });
      },
    },
  ),
);

/**
 * Get the current active sandbox URL (routed through the backend).
 * Use this in non-React contexts (API modules, etc.).
 */
export function getActiveOpenCodeUrl(): string {
  return useServerStore.getState().getActiveServerUrl();
}

// ── Subdomain proxy helpers ──────────────────────────────────────────────────

/**
 * Extract the backend port from NEXT_PUBLIC_BACKEND_URL (e.g. 8008 from
 * "http://localhost:8008/v1"). Used for subdomain URL construction:
 *   http://p{port}-{sandboxId}.localhost:{backendPort}/
 */
function getBackendPort(): number {
  try {
    const url = new URL(getBackendUrl());
    return parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 80);
  } catch {
    return 8008; // fallback for local dev
  }
}

/**
 * Derive SubdomainUrlOptions from a ServerEntry (pure function).
 *
 * Always returns a valid options object — never undefined. Every provider routes
 * through the same backend preview proxy; the `apiBaseUrl` field lets
 * `rewriteLocalhostUrl` take the path-based branch on VPS/cloud deployments
 * where *.localhost DNS isn't available.
 *
 * Use inside useMemo with [server?.provider, server?.sandboxId] as deps
 * to satisfy react-hooks/exhaustive-deps:
 *
 *   const subdomainOpts = useMemo(
 *     () => deriveSubdomainOpts(activeServer),
 *     [activeServer],
 *   );
 */
export function deriveSubdomainOpts(
  server: ServerEntry | null | undefined,
): { sandboxId: string; backendPort: number; apiBaseUrl: string } {
  const fromUrl = server?.url ? deriveProxyBaseFromServerUrl(server.url) : null;
  if (fromUrl) {
    return fromUrl;
  }

  // Fall back to the local sandbox name.
  // This ensures proxy rewriting NEVER silently degrades to raw localhost URLs
  // just because the store hasn't hydrated the sandboxId yet, or because the
  // provider is marked as cloud (Daytona/JustAVPS use the same /p/ proxy).
  const sandboxId = server?.sandboxId || 'kortix-sandbox';
  return {
    sandboxId,
    backendPort: getBackendPort(),
    apiBaseUrl: getBackendUrl(),
  };
}

// ── Centralized Instance Switching ──────────────────────────────────────────
//
// ONE function that handles ALL instance switches. Every caller (sidebar,
// session pages and sandbox lifecycle code call this instead of manually
// orchestrating registerOrUpdateSandbox + swapForServer + setActiveServer.

/**
 * Import tab store lazily to avoid circular dependency at module init.
 * The tab-store imports from server-store for URL helpers, so we can't
 * import it at the top level.
 */
function getTabStore() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/stores/tab-store').useTabStore;
}

/**
 * Derive a stable server-store ID for a sandbox by instanceId.
 * - If the instanceId matches the current cloud-sandbox entry → 'cloud-sandbox'
 * - Otherwise → 'sandbox-<instanceId>'
 * - Local docker → 'default'
 */
function stableServerIdForInstance(instanceId: string, provider?: string): string {
  const state = useServerStore.getState();
  if (provider === 'local_docker') {
    const existingLocal = state.servers.find((s) => s.instanceId === instanceId);
    return existingLocal?.id ?? `sandbox-${instanceId}`;
  }
  // Reuse 'cloud-sandbox' if it's already mapped to this instance
  const cloud = state.servers.find((s) => s.id === CLOUD_SANDBOX_SERVER_ID);
  if (cloud?.instanceId === instanceId) return CLOUD_SANDBOX_SERVER_ID;
  return `sandbox-${instanceId}`;
}

/**
 * Core switch logic — finds or creates a server entry for the given instanceId,
 * swaps tabs, and force-switches. Returns the serverId that was activated.
 *
 * This is synchronous when the server entry already exists in the store.
 * Returns null only if the instanceId can't be resolved at all.
 */
function switchToServerEntry(serverId: string): void {
  const store = useServerStore.getState();
  const tabStore = getTabStore();
  tabStore.getState().swapForServer(serverId, store.activeServerId);
  store.setActiveServer(serverId);
}

interface SwitchToInstanceResult {
  serverId: string;
  alreadyActive: boolean;
}

function syncActiveInstanceCookie(server: ServerEntry | null | undefined): void {
  setActiveInstanceCookie(server?.instanceId ?? null);
}

/**
 * Switch the entire app to a specific instance by instanceId.
 *
 * 1. If the active server already points at this instanceId → no-op
 * 2. If a server entry with this instanceId exists in the store → switch to it
 * 3. Otherwise → fetch sandbox info from API, register, then switch
 *
 * Returns { serverId, alreadyActive } or null if the instance couldn't be found.
 * When fetchIfMissing is true (default), makes an API call for unknown instances.
 */
function switchToInstance(
  instanceId: string,
): SwitchToInstanceResult | null {
  const state = useServerStore.getState();
  const active = state.servers.find((s) => s.id === state.activeServerId);

  // Already active for this instance — but force reconnect if needed
  if (active?.instanceId === instanceId) {
    return { serverId: state.activeServerId, alreadyActive: true };
  }

  // Known in store — switch immediately
  const existing = state.servers.find((s) => s.instanceId === instanceId);
  if (existing) {
    switchToServerEntry(existing.id);
    return { serverId: existing.id, alreadyActive: false };
  }

  return null;
}

/**
 * Switch to a project-session sandbox using the project-scoped
 * `/projects/:projectId/sessions/:sessionId/sandbox` endpoint.
 */
export async function switchToSessionSandboxAsync(
  projectId: string,
  sessionId: string,
  /**
   * Already-fetched sandbox row from the caller (the session page queries it to
   * gate its own render). Passing it here avoids a duplicate
   * GET /sessions/:id/sandbox round-trip on first open of a session — pure dead
   * time on the path to showing a running sandbox.
   */
  prefetched?: {
    status: string;
    external_id: string | null;
    provider: string;
    sandbox_id: string;
  } | null,
): Promise<SwitchToInstanceResult | null> {
  // Fast path: if the active server already points at this session, no-op.
  const sync = switchToInstance(sessionId);
  if (sync) return sync;

  let sandbox = prefetched ?? null;
  if (!sandbox) {
    const { getProjectSessionSandbox } = await import('@/lib/projects-client');
    sandbox = await getProjectSessionSandbox(projectId, sessionId);
  }

  if (!sandbox || sandbox.status !== 'active' || !sandbox.external_id) {
    return null;
  }

  const provider = sandbox.provider as SandboxProvider;
  const store = useServerStore.getState();
  const isLocal = provider === 'local_docker';
  const existing = store.servers.find((s) => s.instanceId === sandbox.sandbox_id);
  const stableId = isLocal
    ? undefined
    : existing?.id ?? stableServerIdForInstance(sandbox.sandbox_id, provider);
  const label = `session ${sandbox.sandbox_id.slice(0, 8)}`;
  // Session sandboxes only run on cloud providers today; local_docker has no
  // mapped-port metadata to forward.
  const serverId = store.registerOrUpdateSandbox(
    {
      label,
      provider,
      sandboxId: sandbox.external_id,
      instanceId: sandbox.sandbox_id,
      mappedPorts: undefined,
    },
    { autoSwitch: false, isLocal, stableId: isLocal ? undefined : stableId },
  );
  switchToServerEntry(serverId);
  return { serverId, alreadyActive: false };
}
