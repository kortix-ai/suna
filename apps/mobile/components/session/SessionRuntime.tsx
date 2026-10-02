/**
 * SessionRuntime — the open session's runtime, from `@kortix/sdk`.
 *
 * `useSession` binds the SDK to one session: it confirms the runtime is ready
 * (`/start`), points every runtime call at that session's computer, and keeps
 * the live event stream open. The transcript, the pending questions and the
 * runtime's status then live in the SDK's stores (`lib/session/session-store.ts`).
 *
 * ONE instance per app, mounted by `SandboxProvider` for the session whose
 * computer is switched in: two would apply every stream event twice. A screen
 * reads it with `useSessionRuntime()`; `null` means no session is bound.
 *
 * `chatEngine: false`: the thread reads its own transcript (`useSessionSync`),
 * for the root and for a sub-agent alike, so this hook does not also read it.
 */
import React, { createContext, useContext } from 'react';
import { useSession, type UseSessionResult } from '@kortix/sdk/react';

export interface BoundSession {
  projectId: string;
  /** The Kortix session id (never the runtime's own id). */
  sessionId: string;
}

const SessionRuntimeContext = createContext<UseSessionResult | null>(null);

export function SessionRuntimeProvider({
  session,
  children,
}: {
  session: BoundSession | null;
  children: React.ReactNode;
}) {
  const runtime = useSession(session?.projectId ?? '', session?.sessionId ?? '', {
    enabled: !!session,
    chatEngine: false,
    // The project home hands its first prompt to the server at create.
    replayStartStash: false,
  });
  return <SessionRuntimeContext.Provider value={session ? runtime : null}>{children}</SessionRuntimeContext.Provider>;
}

/** The bound session's runtime, or `null` when none is bound. */
export function useSessionRuntime(): UseSessionResult | null {
  return useContext(SessionRuntimeContext);
}
