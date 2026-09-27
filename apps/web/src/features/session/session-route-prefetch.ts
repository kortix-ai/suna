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
 * THE FIX. Fire the same three GET/POST reads from that same early point,
 * using the EXACT query keys and options their real consuming hooks use
 * (`sessionStartKey` / `useSession`, `sessionConfigKey` / `useSessionConfigFreshness`,
 * `sessionScopeQueryKey` / `useSessionScope`) so the later hook mount finds
 * warm or in-flight data instead of firing a second request.
 *
 * `/start` IS THE ONE THAT MATTERS MOST: it is what boots/wakes the sandbox,
 * 3-10s dominant cost of opening a session. Starting it here — the instant the
 * route names a session, before the page's own JS chunk has even finished
 * loading — is strictly earlier than `useSession`'s own mount, and is exactly
 * where CLAUDE.md's "start it as early as possible" asks it to run.
 *
 * SAFE TO FIRE REGARDLESS OF BILLING STATE: `POST .../start` checks billing
 * admission server-side BEFORE provisioning anything
 * (`checkBillingAdmission` in `apps/api/src/projects/routes/session-runtime.ts`).
 * A blocked account's early `/start` 402s without spinning up a sandbox — the
 * client-side `canPollSessionStart` gate in `ProjectSessionView` only avoids a
 * REPEATED poll loop against an account that cannot run, it is not what makes
 * an unauthorized start safe.
 *
 * DELIBERATELY NOT WIRED INTO SIDEBAR HOVER. `prefetchSessionStart`
 * (`packages/sdk/src/react/prefetch-session-start.ts`) exists for
 * "createProjectSession→navigate" sites — real navigation, not speculation.
 * Firing `/start` on a session-row HOVER would wake a real sandbox for every
 * row a pointer passes over, at real compute cost, for a session the user may
 * never open. This module only fires once the route ITSELF names the session
 * (`ProjectAccessBoundary`'s `routeSessionId`), which is committed navigation,
 * not a hover guess — the same signal `prefetchSessionOpen` already keys on.
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

import {
  getProjectSessionConfigState,
  getProjectSessionScope,
  sessionStartKey,
  startProjectSession,
} from '@kortix/sdk';

import {
  CONFIG_FRESHNESS_STALE_TIME_MS,
  sessionConfigKey,
} from '@/hooks/projects/use-session-config-freshness';
import { sessionScopeQueryKey } from '@/features/session/scope/use-session-scope';

/**
 * The long-poll budget `useSession` requests by default
 * (`ProjectSessionView` never overrides it) — matched here so this prefetch's
 * `/start` call is the SAME request `useSession`'s own query would have made,
 * not a shorter one that answers `provisioning` and forces an immediate
 * second poll.
 */
const SESSION_START_PREFETCH_WAIT_MS = 15_000;

/**
 * Fire `/start`, `/config` and `/scope` for `(projectId, sessionId)` as soon as
 * the route names them. Fire-and-forget, never throws — every one of these
 * REST calls already reports its own failure through its normal query state
 * once the real hook mounts; a prefetch failing here changes nothing except
 * giving up the head start.
 */
export function prefetchSessionRouteReads(
  queryClient: QueryClient,
  projectId: string,
  sessionId: string,
): void {
  if (!projectId || !sessionId) return;

  void queryClient.prefetchQuery({
    queryKey: sessionStartKey(projectId, sessionId),
    queryFn: () =>
      startProjectSession(projectId, sessionId, { waitMs: SESSION_START_PREFETCH_WAIT_MS }),
  });

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
