'use client';

import { useQuery } from '@tanstack/react-query';

import { getProjectSession } from '@/lib/projects-client';

import { useOpenCodeSessions, type Session } from './use-opencode-sessions';

/**
 * OpenCode ↔ Kortix session mapping — READ side.
 *
 * The mapping is now fully SERVER-OWNED: `POST /sessions/:id/start` (see
 * openSession in apps/api) resolves + persists the canonical OpenCode root and
 * returns the pin in its payload. This hook no longer creates/heals the pin from
 * the client (the old client-side `ensure-opencode` mutation caused the
 * "session replaced / data lost" drift). It just surfaces the pin:
 *   1. the value /start handed us this render (`pinFromStart`), else
 *   2. the persisted pin on the Kortix session row (`getProjectSession`).
 *
 * The OpenCode session list is still read (read-only) for ?oc deep-links and
 * sidebar sub-session rendering.
 */

/** Back-compat no-op: the pin is server-owned now, so there's no client guard to
 *  clear. Kept exported because the session page still calls it on teardown. */
export function clearOpencodeEnsureGuard(): void {
  /* no-op */
}

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
  /** The pin POST /start resolved server-side this render (preferred source). */
  pinFromStart?: string | null;
}): CanonicalOpenCodeSession {
  const { projectId, sessionId, pinFromStart } = params;
  const sessionsQuery = useOpenCodeSessions();

  // The Kortix session row carries the authoritative, server-managed pin — used
  // as a fallback when /start's value isn't in this render's props yet.
  const projectSessionQuery = useQuery({
    queryKey: ['project-session', projectId, sessionId],
    queryFn: () => getProjectSession(projectId, sessionId),
    enabled: !!projectId && !!sessionId,
    staleTime: 10_000,
  });
  const pin = projectSessionQuery.data?.opencode_session_id ?? null;
  const rootSessionId = pinFromStart ?? pin ?? null;

  return {
    rootSessionId,
    sessions: sessionsQuery.data ?? [],
    isLoading: sessionsQuery.isLoading,
    isError: sessionsQuery.isError,
    listed: sessionsQuery.isSuccess,
    error: sessionsQuery.error ?? null,
  };
}
