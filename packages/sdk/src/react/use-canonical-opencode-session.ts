'use client';

import { useEffect, useLayoutEffect, useState } from 'react';

import {
  readPersistedSessionPin,
  resolvePersistedPin,
  resolveSessionPin,
  writePersistedSessionPin,
} from './initial-session-pin';
import { useOpenCodeSessions, type Session } from './use-opencode-sessions';
import { useProjectSession } from './use-project-session';

// SSR-safe: `localStorage` does not exist on the server, and reading it
// during render (rather than an effect) would make the client's FIRST
// hydration render disagree with the server-rendered HTML. Mirrors
// `useSession`'s own `useIsomorphicLayoutEffect` (T5) for the exact
// same reason — a `useLayoutEffect` commits its state update before the
// browser paints, so the corrected value is on screen for the user's very
// first frame instead of trailing one visible "empty" frame behind a plain
// `useEffect`.
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * OpenCode ↔ Kortix session mapping — READ side.
 *
 * The mapping is now fully SERVER-OWNED: `POST /sessions/:id/start` (see
 * openSession in apps/api) resolves + persists the canonical OpenCode root and
 * returns the pin in its payload. This hook no longer creates/heals the pin from
 * the client (the old client-side `ensure-opencode` mutation caused the
 * "session replaced / data lost" drift). It just surfaces the pin:
 *   1. the value /start handed us this render (`pinFromStart`), else
 *   2. the host's own warm-list pin (`initialPin`), else
 *   3. the persisted row (`getProjectSession`) once its REST read resolves,
 *      or — before it does — this browser's own synchronous local mirror of
 *      the last canonical id seen for this session (T6). The local
 *      mirror exists ONLY to cover the gap before (3)'s network read lands;
 *      it never outranks it once loaded, and neither ever outranks (1).
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
  /** A server-authorized pin used for pre-readiness cache hydration. */
  initialPin?: string | null;
  /** Do not list runtime sessions before this session owns the runtime. */
  listRuntimeSessions?: boolean;
}): CanonicalOpenCodeSession {
  const { projectId, sessionId, pinFromStart, initialPin, listRuntimeSessions = true } = params;
  const sessionsQuery = useOpenCodeSessions(listRuntimeSessions);

  // The Kortix session row carries the authoritative, server-managed pin — used
  // as a fallback when /start's value isn't in this render's props yet.
  // The /start pin is authoritative on open, so only fall back to the persisted
  // row pin when /start didn't hand us one THIS render — i.e. a deep-link refresh
  // (no /start in flight yet) or the idle-stopped 'starting' window where the box
  // reads active but the pin isn't resolved (pinFromStart null → query still runs).
  // On a warm start pinFromStart is always present, so this saves a redundant
  // round-trip that otherwise contends for connections during boot.
  // Through `useProjectSession`, not a local `useQuery`: this hook POPULATES
  // the `qk.project.session(id, sid)` entry that `session-files-panel.tsx`,
  // `session-changes-shared.tsx` and `session-title-sync.ts`'s title-refresh
  // ladder all read. A local `useQuery` here shared the key but not the
  // contract — a bare `staleTime: 10_000` against the panels'
  // `contract('inventory')`, and a `queryFn` that differed in `showErrors` —
  // so freshness and error-toast behaviour both came down to which surface
  // mounted first. `enabled` is the one thing that stays local: on a warm
  // start /start already handed us the pin, so this read is pure overhead.
  const projectSessionQuery = useProjectSession(projectId, sessionId, {
    enabled: !pinFromStart && !initialPin,
  });
  const networkPin = projectSessionQuery.data?.opencode_session_id ?? null;

  // T6 — a synchronous local mirror of the persisted pin, so a cold
  // mount (no /start response yet, no host-warm `initialPin`) can still
  // resolve `rootSessionId` on frame one instead of waiting out a network
  // round trip. `useState(null)` matches what a server render sees (no
  // `localStorage`), so hydration never disagrees with the server-rendered
  // HTML; the layout effect below then corrects it to the real cached value
  // before the browser paints — see the module-level comment on
  // `useIsomorphicLayoutEffect`.
  const [cachedPin, setCachedPin] = useState<string | null>(null);
  useIsomorphicLayoutEffect(() => {
    setCachedPin(readPersistedSessionPin(projectId, sessionId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, sessionId]);

  const pin = resolvePersistedPin({ networkPin, cachedPin });
  const rootSessionId = resolveSessionPin({
    startPin: pinFromStart,
    initialPin,
    persistedPin: pin,
  });

  // Mirror a freshly-resolved canonical id back to disk so the NEXT mount of
  // this (projectId, sessionId) can paint synchronously via `cachedPin`
  // above. Scoped to the two AUTHORITATIVE, resolved-this-render sources —
  // /start and the host's warm session-list pin — never to `pin` itself,
  // which would just echo `cachedPin` back to its own key on every render
  // this session is cold. This is also the write half of stale-pin
  // convergence: a re-pinned session's fresh /start id overwrites whatever
  // stale id a previous visit left behind, so the session AFTER this one
  // reads the corrected value instead of the one that just got replaced.
  const freshPin = pinFromStart ?? initialPin ?? null;
  useEffect(() => {
    if (freshPin) writePersistedSessionPin(projectId, sessionId, freshPin);
  }, [projectId, sessionId, freshPin]);

  return {
    rootSessionId,
    sessions: sessionsQuery.data ?? [],
    isLoading: sessionsQuery.isLoading,
    isError: sessionsQuery.isError,
    listed: sessionsQuery.isSuccess,
    error: sessionsQuery.error ?? null,
  };
}
