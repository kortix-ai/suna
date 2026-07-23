"use client";

import { useCallback } from "react";
import { reconcileSessionTail } from "../browser/session-sync/session-sync-registry";
import { useSandboxConnectionStore } from "../browser/stores/sandbox-connection-store";
import { useSyncStore } from "../browser/stores/sync-store";
import { canQueryOpenCodeSession, type Session } from "./use-opencode-sessions";

const prefetchedSessions = new Set<string>();

/** Load a bounded session tail when the user signals navigation intent. */
export async function prefetchSession(sessionId: string): Promise<void> {
	if (!canQueryOpenCodeSession(sessionId)) return;
	if (useSandboxConnectionStore.getState().healthy !== true) return;
	if (prefetchedSessions.has(sessionId)) return;
	const messages = useSyncStore.getState().messages[sessionId];
	if (messages?.length) {
		prefetchedSessions.add(sessionId);
		return;
	}
	await reconcileSessionTail(sessionId, "manual");
	prefetchedSessions.add(sessionId);
}

export function resetPrefetchState(): void {
	prefetchedSessions.clear();
}

export function useBackgroundSessionPrefetch(_sessions: Session[] | undefined) {
	const prefetchOnHover = useCallback((sessionId: string) => {
		void prefetchSession(sessionId);
	}, []);

	return { prefetchOnHover };
}
