'use client';

import type { QueryClient } from '@tanstack/react-query';

import { prefetchSessionStart, qk } from '@kortix/sdk/react';

export interface SessionRouter {
  prefetch: (href: string) => void;
}

export function marketplaceInstallSessionHref(workspaceId: string, sessionId: string): string {
  return `/workspaces/${workspaceId}/sessions/${sessionId}`;
}

export function prepareMarketplaceInstallSessionNavigation(
  queryClient: QueryClient,
  router: SessionRouter,
  workspaceId: string,
  sessionId: string | null | undefined,
): string | null {
  if (!sessionId) return null;

  const href = marketplaceInstallSessionHref(workspaceId, sessionId);
  router.prefetch(href);
  prefetchSessionStart(queryClient, workspaceId, sessionId);
  void queryClient.invalidateQueries({ queryKey: qk.workspace.sessionsScope(workspaceId) });
  return href;
}
