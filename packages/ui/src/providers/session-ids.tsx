'use client';

import * as React from 'react';

/**
 * The project and session the session UI renders. Session components read
 * them here, never from host route params. A host mounts <SessionIdsProvider>
 * around its session view (apps/web maps its `/projects/[id]/sessions/[sessionId]`
 * route params in KortixUiProvider). Without a provider both ids are undefined,
 * and the components that need them render nothing or skip their query.
 */
export interface UiSessionIds {
  projectId?: string;
  sessionId?: string;
}

const NO_IDS: UiSessionIds = {};
const SessionIdsContext = React.createContext<UiSessionIds>(NO_IDS);

export function SessionIdsProvider({
  projectId,
  sessionId,
  children,
}: UiSessionIds & { children: React.ReactNode }) {
  const value = React.useMemo(() => ({ projectId, sessionId }), [projectId, sessionId]);
  return <SessionIdsContext.Provider value={value}>{children}</SessionIdsContext.Provider>;
}

/** The nearest SessionIdsProvider's ids. `T` narrows them, as `useUiParams<T>()` does. */
export function useSessionIds<T extends UiSessionIds = UiSessionIds>(): T {
  return React.useContext(SessionIdsContext) as T;
}
