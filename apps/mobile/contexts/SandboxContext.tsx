/**
 * SandboxContext — provides sandboxUrl to the entire app after auth.
 *
 * 1. After login, calls useSandbox() to ensure user has a sandbox
 * 2. Detects provisioning state and exposes it for the progress screen
 * 4. Passes sandboxUrl down to all children via context
 * 5. Supports switching to a different sandbox via switchSandbox()
 */

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSandbox, platformKeys } from '@/lib/platform/hooks';
import { getSandboxUrl, type SandboxInfo } from '@/lib/platform/client';
import { useAuthContext } from '@/contexts/AuthContext';
import { useSessionStateStore } from '@kortix/sdk/react';
import { log } from '@/lib/logger';

interface SandboxContextValue {
  sandboxUrl: string | undefined;
  /**
   * The Kortix project this sandbox's session belongs to.
   *
   * Every sandbox mobile talks to IS a Kortix project session — `ensureSandbox`
   * creates one — so the project id was always present in the row's metadata
   * and simply never surfaced. Screens need it because a session is addressed
   * as (projectId, sessionId).
   */
  projectId: string | undefined;
  sandboxId: string | undefined;
  sandboxUuid: string | undefined;
  sandboxName: string | undefined;
  isLoading: boolean;
  error: Error | null;
  /** True when the sandbox exists but is still being provisioned */
  isProvisioning: boolean;
  /** The sandbox_id (UUID) to use for polling provisioning status */
  provisioningSandboxId: string | undefined;
  /** The external_id for proxy URL construction */
  provisioningExternalId: string | undefined;
  /** The provider of the provisioning sandbox. */
  provisioningProvider: string | undefined;
  /** Call this when provisioning completes to refetch sandbox data */
  onProvisioningComplete: () => void;
  switchSandbox: (sandbox: SandboxInfo) => void;
}

const SandboxContext = createContext<SandboxContextValue>({
  sandboxUrl: undefined,
  projectId: undefined,
  sandboxId: undefined,
  sandboxUuid: undefined,
  sandboxName: undefined,
  isLoading: false,
  error: null,
  isProvisioning: false,
  provisioningSandboxId: undefined,
  provisioningExternalId: undefined,
  provisioningProvider: undefined,
  onProvisioningComplete: () => {},
  switchSandbox: () => {},
});

export function useSandboxContext() {
  return useContext(SandboxContext);
}

export function SandboxProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading: authLoading } = useAuthContext();
  const queryClient = useQueryClient();

  // Only fetch sandbox when user is fully authenticated (not loading, not anonymous)
  const shouldFetch = isAuthenticated === true && !authLoading;

  const { data, isLoading, error } = useSandbox(shouldFetch);

  // Override state — when user manually switches sandbox
  const [override, setOverride] = useState<{ sandboxUrl: string; sandboxId: string; sandboxUuid: string; sandboxName: string } | null>(null);

  const switchSandbox = useCallback((sandbox: SandboxInfo) => {
    const url = getSandboxUrl(sandbox.external_id);
    log.log('🔄 [SandboxContext] Switching to sandbox:', sandbox.external_id, '→', url);
    setOverride({ sandboxUrl: url, sandboxId: sandbox.external_id, sandboxUuid: sandbox.sandbox_id, sandboxName: sandbox.name });
  }, []);

  // Detect provisioning state from useSandbox result
  const isProvisioning = !!(data?.sandbox && data.sandbox.status === 'provisioning');
  const provisioningSandboxId = isProvisioning ? data?.sandbox?.sandbox_id : undefined;
  const provisioningExternalId = isProvisioning ? data?.sandbox?.external_id : undefined;
  const provisioningProvider = isProvisioning ? data?.sandbox?.provider : undefined;

  // Derive values — override takes precedence
  // When provisioning, don't expose sandboxUrl (it's not ready yet)
  const sandboxUrl = override?.sandboxUrl ?? (shouldFetch && !isProvisioning ? data?.sandboxUrl : undefined);
  const sandboxId = override?.sandboxId ?? (shouldFetch ? data?.sandboxId : undefined);
  const sandboxUuid = override?.sandboxUuid ?? (shouldFetch ? data?.sandbox?.sandbox_id : undefined);
  const sandboxName = override?.sandboxName ?? (shouldFetch ? data?.sandbox?.name : undefined);
  const projectId = shouldFetch
    ? ((data?.sandbox?.metadata as { project_id?: string } | undefined)?.project_id ?? undefined)
    : undefined;

  // Called by the provisioning progress screen when sandbox becomes ready
  const onProvisioningComplete = useCallback(() => {
    log.log('🎉 [SandboxContext] Provisioning complete, refetching sandbox...');
    queryClient.invalidateQueries({ queryKey: platformKeys.sandbox() });
  }, [queryClient]);

  // No global SSE mount. `useSession` opens the stream for the session being
  // viewed and tears it down on unmount, so a stream now belongs to a session
  // rather than to whatever sandbox happened to be current.

  // Reset sync store on logout and clear override
  useEffect(() => {
    if (!isAuthenticated) {
      useSessionStateStore.getState().reset();
      setOverride(null);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (sandboxUrl) {
      log.log('✅ [SandboxContext] Sandbox ready:', sandboxUrl);
    }
    if (isProvisioning) {
      log.log('⏳ [SandboxContext] Sandbox provisioning:', provisioningSandboxId);
    }
    if (error && shouldFetch) {
      log.error('❌ [SandboxContext] Sandbox error:', error?.message || error);
    }
  }, [sandboxUrl, isProvisioning, provisioningSandboxId, error, shouldFetch]);

  return (
    <SandboxContext.Provider
      value={{
        sandboxUrl,
        projectId,
        sandboxId,
        sandboxUuid,
        sandboxName,
        isLoading: shouldFetch ? isLoading : false,
        error: shouldFetch ? (error as Error | null) : null,
        isProvisioning,
        provisioningSandboxId,
        provisioningExternalId,
        provisioningProvider,
        onProvisioningComplete,
        switchSandbox,
      }}
    >
      {children}
    </SandboxContext.Provider>
  );
}
