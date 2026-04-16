/**
 * useSandbox — monitors the user's sandbox lifecycle.
 *
 * On mount (when user is authenticated):
 *   1. Calls GET /platform/sandbox to check for an existing sandbox
 *   2. If one exists, registers it as a server in the server-store
 *      so the OpenCode SDK automatically connects to it
 *   3. If none exists AND billing is enabled (cloud mode), auto-creates
 *      one via POST /platform/init so the user doesn't have to manually
 *      provision a sandbox
 *   4. If none exists AND billing is disabled (self-hosted), returns null
 *      — the user creates one via the Instance Manager dialog
 */

import { useQuery } from '@tanstack/react-query';
import {
  getSandbox,
  listSandboxes,
  getProviders,
  extractMappedPorts,
  type SandboxInfo,
  type SandboxProviderName,
} from '@/lib/platform-client';
import { useServerStore } from '@/stores/server-store';
import { useAuth } from '@/components/AuthProvider';
import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { getCurrentInstanceIdFromPathname, getActiveInstanceIdFromCookie } from '@/lib/instance-routes';

/**
 * Derive a stable, deterministic server-store ID for a sandbox.
 * - Local docker primary: 'default' (single local sandbox in local mode)
 * - Local docker discovered alongside cloud: 'sandbox-<sandboxId>'
 * - Cloud primary: 'cloud-sandbox' (backward-compat with existing persisted activeServerId)
 * - Cloud additional: 'sandbox-<sandboxId>'
 */
function stableIdForSandbox(sandbox: SandboxInfo, isPrimary: boolean): string {
  if (sandbox.provider === 'local_docker') return isPrimary ? 'default' : `sandbox-${sandbox.sandbox_id}`;
  if (isPrimary) return 'cloud-sandbox';
  return `sandbox-${sandbox.sandbox_id}`;
}

/**
 * Register a sandbox as a server entry in the server store using a stable,
 * deterministic ID. Deduplication and update are handled by registerOrUpdateSandbox.
 *
 * Returns the server ID of the registered entry, or null if sandbox has no external_id.
 */
function registerSandboxServer(sandbox: SandboxInfo, autoSwitch: boolean, isPrimary: boolean): string | null {
  if (!sandbox.external_id) {
    console.warn('[useSandbox] Sandbox missing external_id, skipping registration');
    return null;
  }

  const store = useServerStore.getState();
  const isLocal = sandbox.provider === 'local_docker';
  const stableId = stableIdForSandbox(sandbox, isPrimary);

  const serverId = store.registerOrUpdateSandbox(
    {
      label: sandbox.name || (isLocal ? 'Local Sandbox' : 'Cloud Sandbox'),
      provider: sandbox.provider,
      sandboxId: sandbox.external_id,
      instanceId: sandbox.sandbox_id,
      mappedPorts: extractMappedPorts(sandbox),
    },
    { autoSwitch, isLocal, stableId: isLocal ? undefined : stableId },
  );

  // For cloud mode, registerOrUpdateSandbox returns the targetId.
  // Explicitly handle auto-switch here for additional (non-primary) sandboxes
  // since registerOrUpdateSandbox's autoSwitch only switches when no server is selected.
  // For the primary sandbox the autoSwitch inside registerOrUpdateSandbox handles it.

  return serverId;
}

export function useSandbox() {
  const { user } = useAuth();
  const pathname = usePathname();

  const query = useQuery({
    queryKey: ['platform', 'sandbox'],
    queryFn: async () => {
      // Just fetch the current sandbox. Creation is handled by /instances page.
      return await getSandbox();
    },
    enabled: !!user,
    staleTime: 0,
    retry: 2,
    refetchOnWindowFocus: false,
  });

  // Register ALL sandboxes in server store whenever primary sandbox loads.
  // Do NOT auto-switch if the user already has an active instance route
  // (e.g. navigated from /instances to /instances/:id/dashboard).
  // Only fetch the full list once per primary sandbox change (not on every render).
  const listFetchedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!query.data) return;
    const primarySandbox = query.data;

    // If a specific instance route is active (URL or cookie from middleware rewrite),
    // don't auto-switch to primary — let the layout sync handle it.
    const routeInstance = getCurrentInstanceIdFromPathname(pathname) || getActiveInstanceIdFromCookie();
    const hasExplicitRoute = !!routeInstance;
    const autoSwitch = !hasExplicitRoute;

    registerSandboxServer(primarySandbox, autoSwitch, true);

    // Only fetch the full list once per primary sandbox (not on every query.data update)
    if (listFetchedForRef.current === primarySandbox.sandbox_id) return;
    listFetchedForRef.current = primarySandbox.sandbox_id;

    // Also register other sandboxes (no auto-switch).
    listSandboxes().then((all) => {
      const activeInstanceIds = new Set<string>();

      for (const s of all) {
        if (!s.external_id || s.status !== 'active') continue;
        activeInstanceIds.add(s.sandbox_id);
        if (s.sandbox_id !== primarySandbox.sandbox_id) {
          registerSandboxServer(s, false, false);
        }
      }

      // Purge stale managed cloud entries so the sidebar doesn't offer dead,
      // provisioning, errored, or deleted instances for direct switching.
      const store = useServerStore.getState();
      const staleIds = store.servers
        .filter((s) => s.id !== 'default')
        .filter((s) => !!s.provider && !!s.instanceId)
        .filter((s) => s.id === 'cloud-sandbox' || s.id.startsWith('sandbox-'))
        .filter((s) => s.instanceId !== routeInstance)
        .filter((s) => s.id !== store.activeServerId)
        .filter((s) => !activeInstanceIds.has(s.instanceId!))
        .map((s) => s.id);

      for (const id of staleIds) {
        store.removeServer(id);
      }
    }).catch(() => {});
  }, [query.data, pathname]);

  return {
    sandbox: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}

/**
 * useProviders — fetch available sandbox providers from the platform.
 */
export function useProviders() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['platform', 'providers'],
    queryFn: getProviders,
    enabled: !!user,
    staleTime: 10 * 60 * 1000, // 10 minutes
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

export type { SandboxProviderName };
