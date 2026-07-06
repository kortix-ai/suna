'use client';

import { type ReactNode, createContext, createElement, useContext } from 'react';

/**
 * The route-scoped project id, injected by the host instead of read from a
 * router. The SDK is router-agnostic: a Next host derives the id from
 * `useParams()` and mounts `KortixProjectProvider` once near its root; native
 * or CLI-driven hosts pass whatever their navigation state says. Hooks that
 * need "the project the user is looking at" (`useOpenCodeProviders`,
 * `useOpenCodeLocal`) read it via `useKortixRouteProjectId`, which yields
 * `null` outside a project scope — the same as a non-project route.
 */
const KortixProjectContext = createContext<string | null>(null);

export function KortixProjectProvider(props: {
  projectId: string | null;
  children?: ReactNode;
}): ReactNode {
  return createElement(KortixProjectContext.Provider, { value: props.projectId }, props.children);
}

export function useKortixRouteProjectId(): string | null {
  return useContext(KortixProjectContext);
}
