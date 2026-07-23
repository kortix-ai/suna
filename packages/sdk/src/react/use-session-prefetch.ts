"use client";

import { useCallback } from "react";
import {
  getSessionSyncController,
  prefetchSessionSyncWithClient,
} from "../browser/session-sync/session-sync-registry";
import { useSandboxConnectionStore } from "../browser/stores/sandbox-connection-store";
import { getClientForUrl } from "../core/runtime/client";
import { canQueryOpenCodeSession, type Session } from "./use-opencode-sessions";

const ACTIVE_RUNTIME = Symbol("active-runtime");
const prefetchedRuntime = new Map<string, string | typeof ACTIVE_RUNTIME>();

/** Load a bounded session tail before navigation or through a known runtime URL. */
export async function prefetchSession(sessionId: string,
  runtimeUrl?: string,
): Promise<void> {
	if (!canQueryOpenCodeSession(sessionId)) return;
	if (!runtimeUrl && useSandboxConnectionStore.getState().healthy !== true) return;
  const source = runtimeUrl ?? ACTIVE_RUNTIME;
  if (prefetchedRuntime.get(sessionId) === source) return;
  let succeeded: boolean;
	if (runtimeUrl) {
    succeeded = await prefetchSessionSyncWithClient(
      sessionId,
      getClientForUrl(runtimeUrl),
    );
  } else {
    const controller = getSessionSyncController(sessionId);
    await controller.reconcile("manual");
    succeeded = controller.getSnapshot().freshness === "fresh";
	}
  if (succeeded) prefetchedRuntime.set(sessionId, source);
}

export function resetPrefetchState(): void {
  for (const [sessionId, source] of prefetchedRuntime) {
    if (source === ACTIVE_RUNTIME) prefetchedRuntime.delete(sessionId);
  }
}

export function useBackgroundSessionPrefetch(_sessions: Session[] | undefined) {
	const prefetchOnHover = useCallback((sessionId: string) => {
		void prefetchSession(sessionId);
	}, []);

	return { prefetchOnHover };
}
