'use client';

import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ensureOpencodeSession, getProjectSession } from '@/lib/projects-client';
import { useServerStore } from '@/stores/server-store';

import {
  useOpenCodeRuntimeReady,
  useOpenCodeSessions,
  type Session,
} from './use-opencode-sessions';

/**
 * OpenCode ↔ Kortix session mapping — READ side.
 *
 * The mapping is now BACKEND-OWNED: the API
 * (POST /projects/:id/sessions/:sid/ensure-opencode → opencode-mapping.ts) is
 * the sole authority that creates/resolves/heals the canonical OpenCode root
 * and writes `project_sessions.opencode_session_id`. This hook no longer
 * creates sessions or PATCHes the pin from the client (that caused the
 * "session replaced / data lost" drift). It just:
 *   1. renders the stored pin immediately (no blank flash on re-open), and
 *   2. fires the backend `ensure` once per sandbox so a missing/stale pin is
 *      created/healed server-side, retrying while the runtime is still warming.
 *
 * The OpenCode session list is still read (read-only) for ?oc deep-links and
 * sidebar sub-session rendering.
 */

/**
 * One-shot ensure guard, keyed by sandbox server id and held at module scope so
 * it survives component remounts (a per-mount ref would re-fire on every
 * navigation). A restart clears it via clearOpencodeEnsureGuard().
 */
const ensuredForServer = new Set<string>();

/** Re-enable the one-shot ensure for all sandboxes — call on runtime teardown
 *  (e.g. session restart) so the new sandbox gets its own ensure. */
export function clearOpencodeEnsureGuard(): void {
  ensuredForServer.clear();
}

/** Fast retries before backing off to the slow heartbeat. */
const MAX_ENSURE_ATTEMPTS = 8;
/** After the fast retries are spent, keep trying at this slow cadence forever
 *  (until unmount / server switch). A snapshot-restored box on the flaky
 *  experimental region can take longer than the fast window to become
 *  reachable through the proxy; without this the pin would never resolve and
 *  the chat would spin permanently even after the box goes healthy. */
const ENSURE_HEARTBEAT_MS = 15_000;

export interface CanonicalOpenCodeSession {
  /** The authoritative pinned root id (server-managed), or null while resolving. */
  rootSessionId: string | null;
  /** The sandbox's live OpenCode session list (read-only) for ?oc + UI. */
  sessions: Session[];
  isLoading: boolean;
  isError: boolean;
  listed: boolean;
  error: unknown;
}

export function useCanonicalOpenCodeSession(params: {
  projectId: string;
  sessionId: string;
}): CanonicalOpenCodeSession {
  const { projectId, sessionId } = params;
  const queryClient = useQueryClient();
  const runtimeReady = useOpenCodeRuntimeReady();
  const serverId = useServerStore((s) => s.activeServerId) ?? null;
  const sessionsQuery = useOpenCodeSessions();

  // The Kortix session row carries the authoritative, server-managed pin.
  const projectSessionQuery = useQuery({
    queryKey: ['project-session', projectId, sessionId],
    queryFn: () => getProjectSession(projectId, sessionId),
    enabled: !!projectId && !!sessionId,
    staleTime: 10_000,
  });
  const pin = projectSessionQuery.data?.opencode_session_id ?? null;

  const ensureMutation = useMutation({
    mutationFn: () => ensureOpencodeSession(projectId, sessionId),
    onSuccess: (updated) => {
      queryClient.setQueryData(['project-session', projectId, sessionId], updated);
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
    },
  });

  // Render the stored pin immediately; fall back to whatever ensure just
  // returned (covers the very first map before the row query refetches).
  const rootSessionId = pin ?? ensureMutation.data?.opencode_session_id ?? null;

  // Fire the backend ensure once per sandbox (create-if-missing + heal-if-stale,
  // server-side), retrying with backoff while the runtime is still warming.
  // The client never creates a session or writes the pin itself.
  const attemptsRef = useRef(0);
  useEffect(() => {
    if (!runtimeReady || !serverId) return;
    if (ensuredForServer.has(serverId)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Fresh fast-retry budget for this (server, readiness) cycle — a new
    // sandbox shouldn't inherit a previous one's exhausted attempts.
    attemptsRef.current = 0;

    // Schedule the next attempt — fast exponential backoff for the first
    // MAX_ENSURE_ATTEMPTS, then a slow steady heartbeat that NEVER gives up
    // (cancelled only on unmount / server switch). Giving up permanently is
    // what left snapshot-restored boxes spinning forever after a flaky proxy
    // warm-up window — the box goes healthy seconds later but nothing retries.
    const scheduleRetry = () => {
      if (cancelled || !serverId) return;
      ensuredForServer.delete(serverId);
      const delay =
        attemptsRef.current < MAX_ENSURE_ATTEMPTS
          ? Math.min(800 * 2 ** attemptsRef.current, 8_000)
          : ENSURE_HEARTBEAT_MS;
      attemptsRef.current += 1;
      timer = setTimeout(run, delay);
    };

    const run = () => {
      if (cancelled || !serverId) return;
      ensuredForServer.add(serverId);
      ensureMutation.mutate(undefined, {
        onSuccess: (updated) => {
          // Mapped → done; the pin is written and the guard stays set. Anything
          // else (still warming, unreachable, or a transient null) → retry.
          if (!updated.opencode_session_id) scheduleRetry();
        },
        onError: scheduleRetry,
      });
    };
    run();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // Re-run only when the sandbox identity or readiness changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeReady, serverId]);

  return {
    rootSessionId,
    sessions: sessionsQuery.data ?? [],
    isLoading: sessionsQuery.isLoading,
    isError: sessionsQuery.isError,
    listed: sessionsQuery.isSuccess,
    error: ensureMutation.error ?? sessionsQuery.error ?? null,
  };
}
