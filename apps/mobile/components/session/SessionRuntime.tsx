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
import React, { createContext, useContext, useMemo } from 'react';
import type { SessionLogThread } from '@kortix/sdk';
import { useSession, useSessionLogThread, type UseSessionResult } from '@kortix/sdk/react';

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

/**
 * One runtime session's thread of the bound session, from the session log
 * (`useSessionLogThread`): the root thread for the root runtime id, a
 * sub-agent's thread by its runtime id. On v2 the API's log holds it; on v1 it
 * is the `fromV1` view of that runtime session's rows. `null` without an id or
 * a bound session, and while nothing is loaded.
 */
export function useRuntimeThread(runtimeSessionId: string | null | undefined): SessionLogThread | null {
  const runtime = useSessionRuntime();
  const projectId = runtime?.projectId ?? '';
  const sessionId = runtime?.sessionId ?? '';
  const root = runtime?.runtimeSessionId ?? null;
  const source = useMemo(() => ({ projectId, sessionId, runtimeSessionId: root }), [projectId, sessionId, root]);
  const thread = useSessionLogThread(source, runtimeSessionId === root ? undefined : (runtimeSessionId ?? null));
  return runtimeSessionId && thread && thread.messages.length > 0 ? thread : null;
}
