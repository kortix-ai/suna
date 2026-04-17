"use client";

import { useCallback, useEffect, useRef } from "react";
import { getClient } from "@/lib/opencode-sdk";
import { useSyncStore } from "@/stores/opencode-sync-store";
import {
  saveSessionToIDB,
  loadSessionFromIDB,
  pruneIDBCache,
} from "@/lib/idb-sync-cache";
import type { Session } from "./use-opencode-sessions";

const MAX_BACKGROUND_PREFETCH = 20;
const prefetchedSessions = new Set<string>();

/**
 * Prefetch a single session's messages into the sync store + IDB cache.
 * Skips if the session is already in the sync store.
 */
export async function prefetchSession(sessionId: string): Promise<void> {
  if (prefetchedSessions.has(sessionId)) return;
  prefetchedSessions.add(sessionId);

  const state = useSyncStore.getState();
  if (sessionId in state.messages && (state.messages[sessionId]?.length ?? 0) > 0) {
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
  } catch {
    // Non-critical — cache is still warm from IDB
  }
}

/**
 * Reset prefetch tracking (e.g., on server switch).
 */
export function resetPrefetchState(): void {
  prefetchedSessions.clear();
}

/**
 * Hook: background-prefetch top N sessions after session list loads.
 * Uses requestIdleCallback to avoid blocking UI.
 */
export function useBackgroundSessionPrefetch(sessions: Session[] | undefined) {
  const hasPrefetched = useRef(false);

  useEffect(() => {
    if (!sessions || sessions.length === 0 || hasPrefetched.current) return;
    hasPrefetched.current = true;

    const topSessions = sessions
      .filter((s) => !(s.time as any).archived)
      .sort((a, b) => b.time.updated - a.time.updated)
      .slice(0, MAX_BACKGROUND_PREFETCH);

    let idx = 0;

    const prefetchNext = () => {
      if (idx >= topSessions.length) {
        pruneIDBCache();
        return;
      }
      const session = topSessions[idx++];
      prefetchSession(session.id).finally(() => {
        if (typeof requestIdleCallback !== "undefined") {
          requestIdleCallback(prefetchNext, { timeout: 2000 });
        } else {
          setTimeout(prefetchNext, 100);
        }
      });
    };

    // Start prefetch after a short delay to let critical rendering finish
    const timer = setTimeout(() => {
      if (typeof requestIdleCallback !== "undefined") {
        requestIdleCallback(prefetchNext, { timeout: 3000 });
      } else {
        prefetchNext();
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [sessions]);

  const prefetchOnHover = useCallback((sessionId: string) => {
    prefetchSession(sessionId);
  }, []);

  return { prefetchOnHover };
}
