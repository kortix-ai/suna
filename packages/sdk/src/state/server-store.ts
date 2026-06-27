import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSafeJSONStorage } from '../platform/storage/managed-storage';

import { getSupabaseAccessToken } from '../platform/auth';
import { platformConfig } from '../platform/config';
import {
  buildInstancePath,
  INSTANCE_SCOPED_ROUTES,
  normalizeAppPathname,
  setActiveInstanceCookie,
} from '../platform/instance-routes';

import {
  CLOUD_SANDBOX_SERVER_ID,
  DEFAULT_SERVER_ID,
  type SandboxProvider,
  type ServerEntry,
  type ServerStore,
} from './server-store/types';
import {
  deriveProxyBaseFromServerUrl,
  generateId,
  getBackendUrl,
  getDefaultSandboxUrl,
  getSandboxServerUrl,
} from './server-store/url-helpers';
import { getCurrentRuntimeSandboxId, getCurrentRuntimeUrl } from './current-runtime';
import {
  deleteServerFromApi,
  isManagedEntry,
  loadFromApi,
  selectedSandboxPatch,
  syncAllToApi,
  syncServerToApi,
} from './server-store/api-sync';

// Re-export the public surface that moved into sibling modules so importers of
// '../state/server-store' (and '@kortix/sdk/server-store') stay unchanged.
export type { SandboxProvider, ServerEntry };
export { getSandboxUrlForExternalId, resolveServerUrl } from './server-store/url-helpers';

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

// Connection-store reset on server switch. Registered by sandbox-connection-
// store at module load — SAME pattern as registerClientResetter above — so
// server-store never statically imports sandbox-connection-store. A static
// import re-entered this module via the logger→opencode-sdk→server-store chain
// before `_resetClient` initialized → 'Cannot access _resetClient before
// initialization' TDZ (caught live 2026-06-13).
let _connSwitchReset: (() => void) | null = null;
export function registerConnSwitchReset(fn: () => void): void {
  _connSwitchReset = fn;
}

export const useServerStore = create<ServerStore>()(
  persist(
    (set, get) => ({
      // Starts empty — sandboxes are loaded via useSandbox hook after auth.
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
        // Reset the connection store SYNCHRONOUSLY with the switch: its
        // status/healthy belonged to the PREVIOUS server, and every consumer
        // that reads it before the next health poll (runtime-ready marks, the
        // ensure/opencode query gates) was acting on another sandbox's health
        // — observed live as runtime-ready firing 1ms BEFORE server-switched
        // and the chat wedging against a mid-claim runtime. Null-safe: the
        // connection store registers this lazily (see registerConnSwitchReset);
        // before then the hook's effect-reset covers it.
        _connSwitchReset?.();
        syncActiveInstanceCookie(target);

        set({
          activeServerId: id,
          serverVersion: state.serverVersion + 1,
          ...selectedSandboxPatch(target),
          // Mark userSelected unless this is an auto-switch (e.g. from useSandbox)
          ...(options?.auto ? {} : { userSelected: true }),
        });
      },

      getActiveServerUrl: () => {
        // The runtime is owned by `current-runtime` (set by the active session) —
        // prefer it. The legacy server-store fallback below covers the not-yet-
        // deleted dashboard/instance surfaces + self-hosted local dev.
        const current = getCurrentRuntimeUrl();
        if (current) return current;
        const state = get();
        const active = state.servers.find((s) => s.id === state.activeServerId);
        if (!active) {
          // In cloud mode, don't fall back to the local Docker URL —
          // useSandbox will register the real sandbox shortly.
          // Returning '' signals callers to wait / skip the request.
          if (state.activeServerId === CLOUD_SANDBOX_SERVER_ID || (platformConfig().billingEnabled ?? false)) return '';
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

        // Remove ALL managed sandbox entries from localStorage — sandboxes
        // are loaded fresh via useSandbox hook on every page load. This strips:
        //   - Well-known IDs (default, cloud-sandbox)
        //   - Stale random-ID entries (srv_xxx) that have a provider set
        //     (leaked from addSandboxServer calls in older code)
        // Only custom user-added entries (no provider) survive rehydration.
        state.servers = state.servers.filter(
          (s) => !isManagedEntry(s) && !s.provider,
        );

        // Managed sandbox entries are rebuilt from the platform API, so the
        // active server may be missing during hydration. Keep the selected
        // managed ID/cookie alive so refresh restores the same instance once
        // useSandbox registers it again.
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
        // Sandbox entries come from useSandbox hook, not from here.
        // Only sync with API if user is authenticated — otherwise these
        // fire-and-forget requests produce 401 console errors on the homepage.
        const localServers = [...state.servers];
        getSupabaseAccessToken().then((token) => {
          if (!token) return; // Not authenticated, skip API sync
          loadFromApi(localServers).then((apiEntries) => {
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

/**
 * Get the full active ServerEntry (including mappedPorts, provider, etc.).
 * Returns null if the active server can't be found (shouldn't happen).
 */
export function getActiveServer(): ServerEntry | null {
  const state = useServerStore.getState();
  return state.servers.find((s) => s.id === state.activeServerId) ?? null;
}

/**
 * Get the host port for a given container port on the active server.
 * Returns null if no mapping exists (e.g. Daytona, default server, or unknown port).
 */
export function getActiveServerMappedPort(containerPort: string): string | null {
  const server = getActiveServer();
  return server?.mappedPorts?.[containerPort] ?? null;
}

// ── Subdomain proxy helpers ──────────────────────────────────────────────────

/**
 * Extract the backend port from NEXT_PUBLIC_BACKEND_URL (e.g. 8008 from
 * "http://localhost:8008/v1"). Used for subdomain URL construction:
 *   http://p{port}-{sandboxId}.localhost:{backendPort}/
 */
export function getBackendPort(): number {
  try {
    const url = new URL(getBackendUrl());
    return parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 80);
  } catch {
    return 8008; // fallback for local dev
  }
}

/**
 * Get the sandboxId for the active server.
 * - Local mode: defaults to 'kortix-sandbox' (the Docker container name)
 * - Cloud mode: uses the server's sandboxId from the store (empty if not yet loaded)
 */
export function getActiveSandboxId(): string | undefined {
  const current = getCurrentRuntimeSandboxId();
  if (current) return current;
  const state = useServerStore.getState();
  const server = state.servers.find((s) => s.id === state.activeServerId) ?? null;
  return server?.sandboxId;
}

/**
 * Get SubdomainUrlOptions for the active server.
 *
 * Always returns a valid options object — every provider (local_docker, daytona,
 * justavps) routes through the backend's unified preview proxy, so there is no
 * "cloud uses its own scheme" special case anymore. The `apiBaseUrl` field lets
 * `rewriteLocalhostUrl` take the path-based branch on remote deployments.
 *
 * Use in non-React contexts: call directly (reads from store snapshot).
 */
export function getSubdomainOpts(): { sandboxId: string; backendPort: number; apiBaseUrl: string } {
  return getInstanceSubdomainOpts();
}

export function getInstanceSubdomainOpts(
  backendPort = 8000,
): { sandboxId: string; backendPort: number; apiBaseUrl: string } {
  const active = getActiveServer();
  const fromUrl = active?.url ? deriveProxyBaseFromServerUrl(active.url) : null;
  if (fromUrl) {
    return fromUrl;
  }

  return {
    sandboxId: getActiveSandboxId() ?? platformConfig().sandboxId ?? 'kortix-sandbox',
    backendPort,
    apiBaseUrl: getBackendUrl(),
  };
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

  // Fall back to the configured sandbox ID (from runtime env) or 'kortix-sandbox'.
  // This ensures proxy rewriting NEVER silently degrades to raw localhost URLs
  // just because the store hasn't hydrated the sandboxId yet, or because the
  // provider is marked as cloud (Daytona/JustAVPS use the same /p/ proxy).
  const sandboxId = server?.sandboxId || platformConfig().sandboxId || 'kortix-sandbox';
  return {
    sandboxId,
    backendPort: getBackendPort(),
    apiBaseUrl: getBackendUrl(),
  };
}

export function getActiveInstanceId(): string | undefined {
  const state = useServerStore.getState();
  const active = state.servers.find((s) => s.id === state.activeServerId);
  return active?.instanceId;
}

export function getServerByInstanceId(instanceId: string): ServerEntry | undefined {
  const state = useServerStore.getState();
  return state.servers.find((s) => s.instanceId === instanceId);
}

/** Stable server IDs for managed sandbox entries */
export { DEFAULT_SERVER_ID, CLOUD_SANDBOX_SERVER_ID };

// ── Centralized Instance Switching ──────────────────────────────────────────
//
// ONE function that handles ALL instance switches. Every caller (sidebar,
// /instances page, layout sync, onboarding) calls this instead of manually
// orchestrating registerOrUpdateSandbox + swapForServer + setActiveServer.

/**
 * Import tab store lazily to avoid circular dependency at module init.
 * The tab-store imports from server-store for URL helpers, so we can't
 * import it at the top level.
 */
function getTabStore() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./tab-store').useTabStore;
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

export interface SwitchToInstanceResult {
  serverId: string;
  alreadyActive: boolean;
}

export interface SwitchToInstanceOptions {
  /**
   * When true, validate the instance against the platform API even if a matching
   * server entry already exists in the store. Use this for explicit
   * /instances/:id/... routes so stale local entries can't strand the UI on a
   * dead or provisioning machine.
   */
  validate?: boolean;
}

export interface ActivateServerSelectionOptions {
  pathname?: string | null;
}

export interface ActivateInstanceSelectionOptions extends SwitchToInstanceOptions, ActivateServerSelectionOptions {}

export interface ActivateServerSelectionResult extends SwitchToInstanceResult {
  href: string;
}

const PRESERVABLE_INSTANCE_PATHS = new Set<string>(INSTANCE_SCOPED_ROUTES);

function deriveSelectionHref(server: ServerEntry | undefined, pathname?: string | null): string {
  const tabStore = getTabStore().getState();
  const activeTab = tabStore.activeTabId ? tabStore.tabs[tabStore.activeTabId] : null;
  const tabHref = activeTab?.href ? normalizeAppPathname(activeTab.href) : '';
  const normalizedPath = pathname ? normalizeAppPathname(pathname) : '';
  const preserveCurrentPath =
    normalizedPath !== ''
    && normalizedPath !== '/dashboard'
    && PRESERVABLE_INSTANCE_PATHS.has(normalizedPath)
    && (!activeTab || activeTab.type === 'dashboard' || tabHref === '/dashboard');

  const fallbackPath = PRESERVABLE_INSTANCE_PATHS.has(normalizedPath)
    ? normalizedPath
    : '/dashboard';

  const nextPath = preserveCurrentPath
    ? normalizedPath
    : tabHref || fallbackPath || '/dashboard';
  return server?.instanceId ? buildInstancePath(server.instanceId, nextPath) : nextPath;
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
export function switchToInstance(
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

  return null; // Not in store — caller should use switchToInstanceAsync
}

export function activateServerSelection(
  serverId: string,
  options?: ActivateServerSelectionOptions,
): ActivateServerSelectionResult | null {
  const state = useServerStore.getState();
  const target = state.servers.find((s) => s.id === serverId);
  if (!target) return null;

  const alreadyActive = state.activeServerId === serverId;
  if (!alreadyActive) {
    switchToServerEntry(serverId);
  }

  const next = useServerStore.getState().servers.find((s) => s.id === serverId) ?? target;
  return {
    serverId,
    alreadyActive,
    href: deriveSelectionHref(next, options?.pathname),
  };
}

export async function activateInstanceSelection(
  instanceId: string,
  options?: ActivateInstanceSelectionOptions,
): Promise<ActivateServerSelectionResult | null> {
  const result = switchToInstance(instanceId)
    ?? await switchToInstanceAsync(instanceId, { validate: options?.validate });

  if (!result) return null;

  const server = useServerStore.getState().servers.find((s) => s.id === result.serverId);
  return {
    ...result,
    href: deriveSelectionHref(server, options?.pathname),
  };
}

/**
 * Async version — fetches sandbox info from API if not in store, registers
 * it, and switches. Returns the result or null if the instance is not active
 * (will redirect to /instances/:id for status UI).
 */
export async function switchToInstanceAsync(
  instanceId: string,
  options?: SwitchToInstanceOptions,
): Promise<SwitchToInstanceResult | null> {
  const validate = options?.validate ?? false;

  // Fast path: only trust the store when explicit validation isn't required.
  if (!validate) {
    const sync = switchToInstance(instanceId);
    if (sync) return sync;
  }

  // Not in store or validation requested — fetch from API
  const { getSandboxById, extractMappedPorts } = await import('../platform/platform-client');
  const match = await getSandboxById(instanceId);

  if (!match || match.status !== 'active' || !match.external_id) {
    return null; // Not active — caller should redirect to /instances/:id
  }

  // Register and switch
  const store = useServerStore.getState();
  const isLocal = match.provider === 'local_docker';
  const existing = store.servers.find((s) => s.instanceId === instanceId);
  const stableId = isLocal
    ? undefined
    : existing?.id ?? stableServerIdForInstance(instanceId, match.provider);
  const serverId = store.registerOrUpdateSandbox(
    {
      label: match.name || match.sandbox_id,
      provider: match.provider as SandboxProvider,
      sandboxId: match.external_id,
      instanceId: match.sandbox_id,
      mappedPorts: extractMappedPorts(match),
    },
    { autoSwitch: false, isLocal, stableId: isLocal ? undefined : stableId },
  );
  switchToServerEntry(serverId);
  return { serverId, alreadyActive: false };
}

