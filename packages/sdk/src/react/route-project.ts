'use client';

import { type ReactNode, createContext, createElement, useContext } from 'react';

/**
 * The route-scoped workspace id, injected by the host instead of read from a
 * router. The SDK is router-agnostic: a Next host derives the id from
 * `useParams()` and mounts `KortixWorkspaceProvider` once near its root; native
 * or CLI-driven hosts pass whatever their navigation state says. Hooks that
 * need the active workspace (`useOpenCodeProviders`, `useOpenCodeLocal`) read it
 * via `useKortixRouteWorkspaceId`, which yields `null` outside a workspace scope.
 */
const KortixWorkspaceContext = createContext<string | null>(null);

export function KortixWorkspaceProvider(props: {
  workspaceId: string | null;
  children?: ReactNode;
}): ReactNode {
  return createElement(KortixWorkspaceContext.Provider, { value: props.workspaceId }, props.children);
}

export function useKortixRouteWorkspaceId(): string | null {
  return useContext(KortixWorkspaceContext);
}

/** @deprecated Use `KortixWorkspaceProvider`. */
export const KortixProjectProvider = KortixWorkspaceProvider;
/** @deprecated Use `useKortixRouteWorkspaceId`. */
export const useKortixRouteProjectId = useKortixRouteWorkspaceId;
