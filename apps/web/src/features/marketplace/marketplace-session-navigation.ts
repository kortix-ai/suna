'use client';

import type { QueryClient } from '@tanstack/react-query';

import { prefetchSessionStart } from '@kortix/sdk/react';

export interface SessionRouter {
  prefetch: (href: string) => void;
}

export function marketplaceInstallSessionHref(projectId: string, sessionId: string): string {
  return `/projects/${projectId}/sessions/${sessionId}`;
}

export function prepareMarketplaceInstallSessionNavigation(
  queryClient: QueryClient,
  router: SessionRouter,
  projectId: string,
  sessionId: string | null | undefined,
): string | null {
  if (!sessionId) return null;

  const href = marketplaceInstallSessionHref(projectId, sessionId);
  router.prefetch(href);
  prefetchSessionStart(queryClient, projectId, sessionId);
  void queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
  return href;
}
