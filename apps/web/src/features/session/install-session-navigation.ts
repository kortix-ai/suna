'use client';

import type { QueryClient } from '@tanstack/react-query';

import { prefetchSessionStart, qk } from '@kortix/sdk/react';

export interface SessionRouter {
  prefetch: (href: string) => void;
}

/**
 * Where an agent-driven install session lives. One route, because a marketplace
 * install and a marketplace template install are both just sessions.
 */
export function installSessionHref(projectId: string, sessionId: string): string {
  return `/projects/${projectId}/sessions/${sessionId}`;
}

/**
 * Warm the session route and its start payload, then hand back the href.
 *
 * Shared by every "the agent does it in a session" flow — marketplace add-to-
 * project and marketplace template install. Named without a surface prefix precisely
 * because a second surface arrived: the mechanism is the session, not the store.
 */
export function prepareInstallSessionNavigation(
  queryClient: QueryClient,
  router: SessionRouter,
  projectId: string,
  sessionId: string | null | undefined,
): string | null {
  if (!sessionId) return null;

  const href = installSessionHref(projectId, sessionId);
  router.prefetch(href);
  prefetchSessionStart(queryClient, projectId, sessionId);
  void queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) });
  return href;
}
