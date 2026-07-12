'use client';

import { useQuery } from '@tanstack/react-query';

import { getProjectSession } from '../core/rest/projects-client';

import { useRuntimeSessions, type Session } from './use-runtime-sessions';

/**
 * Runtime ↔ Kortix session mapping — READ side.
 *
 * The mapping is now fully SERVER-OWNED: `POST /sessions/:id/start` (see
 * openSession in apps/api) resolves + persists the canonical Runtime root and
 * returns the pin in its payload. This hook no longer creates/heals the pin from
 * the client (the old client-side runtime ensure mutation caused the
 * "session replaced / data lost" drift). It just surfaces the pin:
 *   1. the value /start handed us this render (`pinFromStart`), else
 *   2. the persisted pin on the Kortix session row (`getProjectSession`).
 *
 * The Runtime session list is still read (read-only) for ?oc deep-links and
 * sidebar sub-session rendering.
 */

export interface CanonicalRuntimeSession {
  /** The authoritative pinned root id (server-managed), or null while resolving. */
  rootSessionId: string | null;
  /** The sandbox's live Runtime session list (read-only) for ?oc + UI. */
  sessions: Session[];
  isLoading: boolean;
  isError: boolean;
  listed: boolean;
  error: unknown;
}

export function useCanonicalRuntimeSession(params: {
  projectId: string;
  sessionId: string;
  /** The pin POST /start resolved server-side this render (preferred source). */
  pinFromStart?: string | null;
  enabled?: boolean;
}): CanonicalRuntimeSession {
  const { projectId, sessionId, pinFromStart, enabled = true } = params;
  const sessionsQuery = useRuntimeSessions(enabled);

  // The Kortix session row carries the authoritative, server-managed pin — used
  // as a fallback when /start's value isn't in this render's props yet.
  // The /start pin is authoritative on open, so only fall back to the persisted
  // row pin when /start didn't hand us one THIS render — i.e. a deep-link refresh
  // (no /start in flight yet) or the idle-stopped 'starting' window where the box
  // reads active but the pin isn't resolved (pinFromStart null → query still runs).
  // On a warm start pinFromStart is always present, so this saves a redundant
  // round-trip that otherwise contends for connections during boot.
  const projectSessionQuery = useQuery({
    queryKey: ['project-session', projectId, sessionId],
    queryFn: () => getProjectSession(projectId, sessionId, { showErrors: false }),
    enabled: enabled && !!projectId && !!sessionId && !pinFromStart,
    staleTime: 10_000,
  });
  const pin = projectSessionQuery.data?.runtime_session_id ?? null;
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
