'use client';

import { KortixProjectProvider } from '@kortix/sdk/react';
import * as React from 'react';

/**
 * The project and session the session UI renders. Session components read
 * them here, never from host route params. A host mounts <SessionIdsProvider>
 * around its session view (apps/web maps its `/projects/[id]/sessions/[sessionId]`
 * route params in KortixUiProvider). Without a provider both ids are undefined,
 * and the components that need them render nothing or skip their query.
 *
 * With a `projectId` it also scopes the SDK's project hooks
 * (`KortixProjectProvider`: the model catalog, runtime providers), so one
 * provider is all a host mounts for a project view.
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
  const scoped = <SessionIdsContext.Provider value={value}>{children}</SessionIdsContext.Provider>;
  return projectId ? <KortixProjectProvider projectId={projectId}>{scoped}</KortixProjectProvider> : scoped;
}

/** The nearest SessionIdsProvider's ids. `T` narrows them, as `useUiParams<T>()` does. */
export function useSessionIds<T extends UiSessionIds = UiSessionIds>(): T {
  return React.useContext(SessionIdsContext) as T;
}
