/**
 * SandboxContext — the sandbox of the open session, for the whole app.
 *
 * 1. Binds `@kortix/sdk` to the open session (`SessionRuntimeProvider`): its
 *    live event stream runs for the switched-in session only
 * 2. Passes that session's sandboxUrl down to all children via context
 * 3. Switches to a session's sandbox via switchSandbox() and leaves it via
 *    clearSandbox()
 *
 * No session is open: no sandbox. The app used to pick a "default sandbox" on
 * every signed-in start by reading one sessions page per project (151
 * requests for a member of 150 projects, KRTX-2316); nothing reads it, as a
 * thread switches its own session's sandbox in when it connects.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getSandboxUrl, type SandboxInfo } from '@/lib/platform/client';
import { resetIdentityState } from '@kortix/sdk/react';
import { useAuthContext } from '@/contexts/AuthContext';
import { SessionRuntimeProvider, type BoundSession } from '@/components/session/SessionRuntime';
import { useRuntimeStream } from '@/hooks/useRuntimeStream';
import { useDisclosureStore } from '@/lib/session/disclosure-store';
import { log } from '@/lib/logger';

interface SandboxContextValue {
  sandboxUrl: string | undefined;
  sandboxId: string | undefined;
  sandboxUuid: string | undefined;
  sandboxName: string | undefined;
  /**
   * Switch to `sandbox`. `session` is the project session it runs: the SDK
   * binds to it and opens its live stream. Without one (Settings → Instances)
   * only the sandbox URL changes.
   */
  switchSandbox: (sandbox: SandboxInfo, session?: BoundSession) => void;
  /** Drop the switched-in sandbox: the live stream disconnects. */
  clearSandbox: () => void;
}

const SandboxContext = createContext<SandboxContextValue>({
  sandboxUrl: undefined,
  sandboxId: undefined,
  sandboxUuid: undefined,
  sandboxName: undefined,
  switchSandbox: () => {},
  clearSandbox: () => {},
});

export function useSandboxContext() {
  return useContext(SandboxContext);
}

export function SandboxProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuthContext();

  // The switched-in sandbox, and the session it runs.
  const [override, setOverride] = useState<{ sandboxUrl: string; sandboxId: string; sandboxUuid: string; sandboxName: string; session: BoundSession | null } | null>(null);

  const switchSandbox = useCallback((sandbox: SandboxInfo, session?: BoundSession) => {
    const url = getSandboxUrl(sandbox.external_id);
    log.log('🔄 [SandboxContext] Switching to sandbox:', sandbox.external_id, '→', url);
    setOverride((current) => ({
      sandboxUrl: url,
      sandboxId: sandbox.external_id,
      sandboxUuid: sandbox.sandbox_id,
      sandboxName: sandbox.name,
      // The same object while the session is the same: the SDK keeps its
      // stream instead of re-binding on every switch call.
      session:
        session && current?.session?.projectId === session.projectId && current.session.sessionId === session.sessionId
          ? current.session
          : (session ?? null),
    }));
  }, []);

  // Setting null on an already-null override is a no-op render bail-out.
  const clearSandbox = useCallback(() => setOverride(null), []);

  // Cues, the "Live updates paused" state and the foreground/online signals
  // of the live stream the SDK runs for the bound session (below).
  useRuntimeStream();

  // Reset the session and disclosure stores on logout and clear override
  useEffect(() => {
    if (!isAuthenticated) {
      // The SDK's session state: transcripts, pending requests, sync readers.
      resetIdentityState();
      // Expand/collapse choices are keyed by part id: drop them with the transcript.
      useDisclosureStore.getState().clear();
      setOverride(null);
    }
  }, [isAuthenticated]);

  // Keyed by the values, not the override object: a repeat switch to the same
  // sandbox builds a new object and must not re-render every consumer.
  const sandboxUrl = override?.sandboxUrl;
  const sandboxId = override?.sandboxId;
  const sandboxUuid = override?.sandboxUuid;
  const sandboxName = override?.sandboxName;
  const value = useMemo<SandboxContextValue>(
    () => ({ sandboxUrl, sandboxId, sandboxUuid, sandboxName, switchSandbox, clearSandbox }),
    [sandboxUrl, sandboxId, sandboxUuid, sandboxName, switchSandbox, clearSandbox]
  );

  // The live stream follows the switched-in sandbox of an open session only.
  return (
    <SandboxContext.Provider value={value}>
      <SessionRuntimeProvider session={override?.session ?? null}>{children}</SessionRuntimeProvider>
    </SandboxContext.Provider>
  );
}
