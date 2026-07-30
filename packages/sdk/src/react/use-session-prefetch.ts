'use client';

import { useCallback } from 'react';
import {
  ACTIVE_SESSION_PREFETCH_SOURCE,
  clearActiveSessionPrefetches,
  prefetchSessionSyncOnce,
} from '../browser/session-sync/session-sync-registry';
import { useSandboxConnectionStore } from '../browser/stores/sandbox-connection-store';
import { getClientForUrl } from '../core/runtime/client';
import { canQueryOpenCodeSession, type Session } from './use-opencode-sessions';

/** Load a bounded session tail before navigation or through a known runtime URL. */
export async function prefetchSession(sessionId: string, runtimeUrl?: string): Promise<void> {
  if (!canQueryOpenCodeSession(sessionId)) return;
  if (!runtimeUrl && useSandboxConnectionStore.getState().healthy !== true) return;
  await prefetchSessionSyncOnce(
    sessionId,
    runtimeUrl ?? ACTIVE_SESSION_PREFETCH_SOURCE,
    runtimeUrl ? getClientForUrl(runtimeUrl) : undefined,
  );
}

export function resetPrefetchState(): void {
  clearActiveSessionPrefetches();
}

export function useBackgroundSessionPrefetch(_sessions: Session[] | undefined) {
  const prefetchOnHover = useCallback((sessionId: string) => {
    void prefetchSession(sessionId);
  }, []);

  return { prefetchOnHover };
}
