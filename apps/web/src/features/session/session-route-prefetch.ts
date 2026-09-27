'use client';

/**
 * Start the session route's control-plane reads BEFORE the session page's own
 * chunk mounts — the same "prefetch beside the access check" pattern
 * `prefetchSessionOpen` already uses for the snapshot (see
 * `project-access-boundary.tsx`).
 *
 * THE PROBLEM. A cold `/projects/<id>/sessions/<id>` open showed the snapshot
 * (`GET .../snapshot?transcript=40`) running alone for ~1.6s, then FOUR more
 * reads starting together only once it resolved: `POST .../start`,
 * `GET .../config`, `GET .../scope`, `GET .../audit`. None of the four needs
 * the snapshot's data — every one of them takes only `projectId` + `sessionId`,
 * exactly like the snapshot. They were not gated on the snapshot by any `enabled`
 * condition; they simply live in `useSession` / `useSessionConfigFreshness` /
 * `useSessionScope`, which only mount once `ProjectSessionView`'s own route
 * segment finishes loading and hydrating — a chunk-load delay the snapshot
 * already escapes by firing from `ProjectAccessBoundary`, which mounts far
 * earlier (it wraps the whole `/projects/<id>` subtree).
 *
 * THE FIX. Fire the two READS (`/config`, `/scope`) from that same early
 * point, using the EXACT query keys and options their consuming hooks use
 * (`sessionConfigKey` / `useSessionConfigFreshness`, `sessionScopeQueryKey` /
 * `useSessionScope`), so the hook mount finds warm or in-flight data.
 *
 * `/start` IS DELIBERATELY NOT HERE. It is a write that wakes the sandbox, and
 * `useSession` refetches it on mount whenever the box is not `ready`
 * (`sessionStartStaleTime` is 0 then), so a prefetched `/start` is always
 * followed by a second one. Browser journey 31 pins exactly one `/start` per
 * open, and caught the duplicate. The create→navigate sites already start the
 * box early through the SDK's `prefetchSessionStart`.
 *
 * DELIBERATELY EXCLUDES THE AUDIT READ (`GET .../audit`). Its data (pending
 * approvals) drives a header badge and a side panel, neither on the transcript's
 * first-paint path — the boot loader, the composer and the message list render
 * with no dependency on it. Pulling it into this same early burst would spend
 * one of the route's first, most contended request slots on a read nothing
 * needs yet; it stays on `ProjectSessionView`'s own mount-time trigger
 * (`session-audit-shared.tsx`), unaccelerated.
 */

import type { QueryClient } from '@tanstack/react-query';

import { getProjectSessionConfigState, getProjectSessionScope } from '@kortix/sdk';

import {
  CONFIG_FRESHNESS_STALE_TIME_MS,
  sessionConfigKey,
} from '@/hooks/projects/use-session-config-freshness';
import { sessionScopeQueryKey } from '@/features/session/scope/use-session-scope';

export function prefetchSessionRouteReads(
  queryClient: QueryClient,
  projectId: string,
  sessionId: string,
): void {
  if (!projectId || !sessionId) return;

  void queryClient.prefetchQuery({
    queryKey: sessionConfigKey(projectId, sessionId),
    queryFn: () => getProjectSessionConfigState(projectId, sessionId),
    staleTime: CONFIG_FRESHNESS_STALE_TIME_MS,
  });

  void queryClient.prefetchQuery({
    queryKey: sessionScopeQueryKey(projectId, sessionId),
    queryFn: () => getProjectSessionScope(projectId, sessionId),
    staleTime: 0,
  });
}
