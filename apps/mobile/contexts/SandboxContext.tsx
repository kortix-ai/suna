/**
 * SandboxContext — provides sandboxUrl to the entire app after auth.
 *
 * 1. After login, calls useSandbox() to ensure user has a sandbox
 * 2. Detects provisioning state and exposes it for the progress screen
 * 3. Mounts the SSE event stream on the sandbox of the open session only
 * 4. Passes sandboxUrl down to all children via context
 * 5. Supports switching to a session's sandbox via switchSandbox() and
 *    leaving it via clearSandbox()
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSandbox, platformKeys } from '@/lib/platform/hooks';
import { getSandboxUrl, type SandboxInfo } from '@/lib/platform/client';
import { useOpenCodeEventStream } from '@/lib/opencode/event-stream';
import { useAuthContext } from '@/contexts/AuthContext';
import { useSyncStore } from '@/lib/opencode/sync-store';
import { useDisclosureStore } from '@/lib/session/disclosure-store';
import { log } from '@/lib/logger';

interface SandboxContextValue {
  sandboxUrl: string | undefined;
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
  /** Drop the switched-in sandbox: the live stream disconnects. */
  clearSandbox: () => void;
}

const SandboxContext = createContext<SandboxContextValue>({
  sandboxUrl: undefined,
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
  clearSandbox: () => {},
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

  // Setting null on an already-null override is a no-op render bail-out.
  const clearSandbox = useCallback(() => setOverride(null), []);

  // Detect provisioning state from useSandbox result
  const isProvisioning = !!(data?.sandbox && data.sandbox.status === 'provisioning');
  const provisioningSandboxId = isProvisioning ? data?.sandbox?.sandbox_id : undefined;
  const provisioningExternalId = isProvisioning ? data?.sandbox?.external_id : undefined;
  const provisioningProvider = isProvisioning ? data?.sandbox?.provider : undefined;

  // Derive values — override takes precedence
  // Expose the default sandboxUrl only while that sandbox is active. The SSE
  // stream below connects to it, and a provisioning, stopped, or failed
  // sandbox cannot serve /event: the stream would error and reconnect forever.
  const sandboxUrl =
    override?.sandboxUrl ??
    (shouldFetch && data?.sandbox.status === 'active' ? data.sandboxUrl : undefined);
  const sandboxId = override?.sandboxId ?? (shouldFetch ? data?.sandboxId : undefined);
  const sandboxUuid = override?.sandboxUuid ?? (shouldFetch ? data?.sandbox?.sandbox_id : undefined);
  const sandboxName = override?.sandboxName ?? (shouldFetch ? data?.sandbox?.name : undefined);

  // Called by the provisioning progress screen when sandbox becomes ready
  const onProvisioningComplete = useCallback(() => {
    log.log('🎉 [SandboxContext] Provisioning complete, refetching sandbox...');
    queryClient.invalidateQueries({ queryKey: platformKeys.sandbox() });
  }, [queryClient]);

  // The live SSE stream follows the switched-in sandbox of an open session only.
  // The default sandbox above can belong to any project, so the stream never
  // connects to it (no-ops while undefined).
  useOpenCodeEventStream(override?.sandboxUrl);

  // Reset the sync and disclosure stores on logout and clear override
  useEffect(() => {
    if (!isAuthenticated) {
      useSyncStore.getState().reset();
      // Expand/collapse choices are keyed by part id: drop them with the transcript.
      useDisclosureStore.getState().clear();
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

  const contextLoading = shouldFetch ? isLoading : false;
  const contextError = shouldFetch ? (error as Error | null) : null;
  const value = useMemo<SandboxContextValue>(
    () => ({
      sandboxUrl,
      sandboxId,
      sandboxUuid,
      sandboxName,
      isLoading: contextLoading,
      error: contextError,
      isProvisioning,
      provisioningSandboxId,
      provisioningExternalId,
      provisioningProvider,
      onProvisioningComplete,
      switchSandbox,
      clearSandbox,
    }),
    [
      sandboxUrl,
      sandboxId,
      sandboxUuid,
      sandboxName,
      contextLoading,
      contextError,
      isProvisioning,
      provisioningSandboxId,
      provisioningExternalId,
      provisioningProvider,
      onProvisioningComplete,
      switchSandbox,
      clearSandbox,
    ]
  );

  return <SandboxContext.Provider value={value}>{children}</SandboxContext.Provider>;
}
