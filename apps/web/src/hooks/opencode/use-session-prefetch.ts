"use client";

import { useCallback, useEffect } from "react";
import { getClient } from "@/lib/opencode-sdk";
import { useSyncStore } from "@/stores/opencode-sync-store";
import {
  saveSessionToIDB,
  loadSessionFromIDB,
  pruneIDBCache,
} from "@/lib/idb-sync-cache";
import type { Session } from "./use-opencode-sessions";

const prefetchedSessions = new Set<string>();
const inFlightPrefetches = new Map<string, Promise<void>>();

/**
 * Prefetch a single session's messages into the sync store + IDB cache.
 * Skips if the session is already in the sync store.
 */
export async function prefetchSession(sessionId: string): Promise<void> {
  if (prefetchedSessions.has(sessionId)) return;
  const existingPrefetch = inFlightPrefetches.get(sessionId);
  if (existingPrefetch) return existingPrefetch;

  const run = (async () => {
    const state = useSyncStore.getState();
    if (sessionId in state.messages && (state.messages[sessionId]?.length ?? 0) > 0) {
      prefetchedSessions.add(sessionId);
      return;
    }

    // Try IDB cache first
    const cached = await loadSessionFromIDB(sessionId);
    if (cached && cached.messages.length > 0) {
      const currentState = useSyncStore.getState();
      if (!(sessionId in currentState.messages) || (currentState.messages[sessionId]?.length ?? 0) === 0) {
        currentState.hydrate(
          sessionId,
          cached.messages.map((info) => ({
            info,
            parts: cached.parts[info.id] ?? [],
          })),
        );
      }
    }

    // Fetch fresh data from server in background
    try {
      const res = await getClient().session.messages({ sessionID: sessionId });
      const data = (res.data ?? []) as any[];
      if (data.length > 0) {
        useSyncStore.getState().hydrate(sessionId, data);
        const parts = useSyncStore.getState().parts;
        const msgs = useSyncStore.getState().messages[sessionId] ?? [];
        saveSessionToIDB(sessionId, msgs, parts);
      }
      prefetchedSessions.add(sessionId);
    } catch {
      // Non-critical — cache is still warm from IDB
    }
  })().finally(() => {
    inFlightPrefetches.delete(sessionId);
  });

  inFlightPrefetches.set(sessionId, run);
  return run;
}

/**
 * Reset prefetch tracking (e.g., on server switch).
 */
export function resetPrefetchState(): void {
  prefetchedSessions.clear();
  inFlightPrefetches.clear();
}

/**
 * Hook: background-prefetch top N sessions after session list loads.
 * Uses requestIdleCallback to avoid blocking UI.
 */
export function useBackgroundSessionPrefetch(sessions: Session[] | undefined) {
  useEffect(() => {
    if (!sessions || sessions.length === 0) return;
    void pruneIDBCache();
  }, [sessions]);

  const prefetchOnHover = useCallback((sessionId: string) => {
    prefetchSession(sessionId);
  }, []);

  return { prefetchOnHover };
}
