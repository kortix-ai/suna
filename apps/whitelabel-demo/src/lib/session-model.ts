'use client';

/**
 * The session's current model, read through the provider-neutral route.
 *
 * The upstream field is named after the runtime, which reference-app CLIENT
 * code must not know about (see scripts/sdk-boundary.mjs `provider-term`) —
 * the route is the translation seam, so the client speaks `model`.
 *
 * One hook, one query key: the scope-bar chip and the switcher inside its
 * popover are the same answer from the same cache entry, not two opinions and
 * not two requests.
 */

import { authHeaders, getSessionToken } from '@/lib/session';
import { useQuery } from '@tanstack/react-query';

/** Same key the switcher inside the popover uses, so a change invalidates both. */
export function sessionModelKey(projectId: string, sessionId: string) {
  return ['session-model', projectId, sessionId] as const;
}

export function useSessionModel(projectId: string, sessionId: string) {
  return useQuery({
    queryKey: sessionModelKey(projectId, sessionId),
    queryFn: async () => {
      const res = await fetch(
        `/api/session-model?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(sessionId)}`,
        { headers: authHeaders(getSessionToken()) },
      );
      if (!res.ok) return { model: null as string | null };
      return (await res.json()) as { model: string | null };
    },
    staleTime: 30_000,
    retry: false,
  });
}
