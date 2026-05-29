'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { getProjectSession, updateProjectSession } from '@/lib/projects-client';
import { useServerStore } from '@/stores/server-store';

import {
  useCreateOpenCodeSession,
  useOpenCodeRuntimeReady,
  useOpenCodeSessions,
  type Session,
} from './use-opencode-sessions';

/**
 * Canonical OpenCode-session ↔ Kortix-session mapping.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * Every Kortix session is backed by exactly ONE sandbox, and that sandbox runs
 * ONE OpenCode runtime with ONE local storage DB. That single DB can hold MANY
 * session rows — a root (no `parentID`), sub-sessions (have a `parentID`), and,
 * historically, accidental duplicate roots minted by a racy auto-create. Kortix
 * pins the canonical root via `project_sessions.opencode_session_id`.
 *
 * The old code (a) silently fell back to "first root by *recency*" whenever the
 * pin wasn't found in the live list, and (b) wrote the pin exactly once and
 * never reconciled it. Net effect: the active conversation could flip to a
 * different/newer root, and a stale pin (e.g. after a sandbox rebuild wiped the
 * DB) was never repaired — the user's session looked "replaced" / "lost".
 *
 * THE INVARIANT THIS ENFORCES
 * ---------------------------
 * 1. If the pinned root still exists in the live DB, it ALWAYS wins. Identity
 *    never drifts off it due to recency or a stray duplicate root.
 * 2. If the pin is missing (fresh/rebuilt sandbox, deleted session, or never
 *    set), adopt the DETERMINISTIC canonical root — the oldest root by creation
 *    time, tie-broken by id. Being a pure function of DB state, every client
 *    (and every render) converges on the same id, so there is no flip-flop.
 * 3. The DB is created at most ONCE per physical sandbox, and only when it holds
 *    no root at all — so we never mint duplicate roots.
 * 4. The pin is healed to whatever we resolved, so the mapping self-repairs.
 */

/**
 * Deterministically choose the canonical root from a sandbox's OpenCode session
 * list. The canonical root is the OLDEST root (no `parentID`) by creation time;
 * ties break on id so the choice is total and stable across clients. Returns
 * `null` when the list contains no root (e.g. a brand-new, empty sandbox).
 */
export function pickCanonicalRoot(sessions: Session[]): Session | null {
  let best: Session | null = null;
  for (const s of sessions) {
    if (s.parentID) continue; // roots only — sub-sessions are never the pin
    if (!best) {
      best = s;
      continue;
    }
    const candidateCreated = s.time?.created ?? 0;
    const bestCreated = best.time?.created ?? 0;
    if (candidateCreated < bestCreated) {
      best = s;
    } else if (candidateCreated === bestCreated && s.id < best.id) {
      best = s; // total order on identical timestamps → fully deterministic
    }
  }
  return best;
}

/**
 * Resolve which OpenCode session id the Kortix session should be pinned to,
 * given the currently-persisted pin, the live session list, and the id of a
 * session we may have just created this render. Pure so it can be unit-tested
 * and reused by both the resolution and the heal/pin write.
 */
export function resolveRootSessionId(opts: {
  pinnedRootId: string | null;
  sessions: Session[];
  justCreatedId?: string | null;
}): string | null {
  const { pinnedRootId, sessions, justCreatedId } = opts;
  // 1. Honor the pin whenever it still exists in the live DB. This is the
  //    stable identity — we never flip off it for a newer/duplicate root.
  if (pinnedRootId && sessions.some((s) => s.id === pinnedRootId)) {
    return pinnedRootId;
  }
  // 2. Pin missing from this DB → adopt the deterministic canonical root.
  const canonical = pickCanonicalRoot(sessions);
  if (canonical) return canonical.id;
  // 3. Truly empty DB → fall back to whatever we just created this render
  //    (the create hook seeds the list cache, so this is short-lived).
  return justCreatedId ?? null;
}

/**
 * Should we create a fresh root for this sandbox right now? Pure so the exact
 * gating is unit-tested. We create iff the runtime is ready, the list has
 * settled (not loading / not errored), there is no valid pin, the sandbox holds
 * no root at all, and we haven't already issued a create for this sandbox.
 */
export function shouldCreateRoot(opts: {
  runtimeReady: boolean;
  serverId: string | null;
  listSettled: boolean;
  pinPresent: boolean;
  sessions: Session[];
  alreadyCreated: boolean;
}): boolean {
  const { runtimeReady, serverId, listSettled, pinPresent, sessions, alreadyCreated } = opts;
  if (!runtimeReady || !serverId) return false;
  if (!listSettled) return false; // never create off a loading/errored list
  if (pinPresent) return false; // a valid pin exists → adopt it, never create
  if (pickCanonicalRoot(sessions)) return false; // a root already exists → adopt
  if (alreadyCreated) return false; // one create per physical sandbox
  return true;
}

/**
 * Which id (if any) should be written to the pin right now? Pure so the
 * heal/no-thrash/never-pin-a-sub-session rules are unit-tested. Returns the id
 * to PATCH, or null to leave the pin untouched.
 */
export function resolvePinWrite(opts: {
  runtimeReady: boolean;
  rootSessionId: string | null;
  pinnedRootId: string | null;
  sessions: Session[];
  attemptedTarget: string | null;
}): string | null {
  const { runtimeReady, rootSessionId, pinnedRootId, sessions, attemptedTarget } = opts;
  if (!runtimeReady || !rootSessionId) return null;
  if (pinnedRootId === rootSessionId) return null; // already in sync → no write
  if (attemptedTarget === rootSessionId) return null; // in-flight / already tried
  const target = sessions.find((s) => s.id === rootSessionId);
  if (target?.parentID) return null; // never pin a sub-session as the root
  return rootSessionId;
}

/**
 * One-shot create guard, keyed by sandbox server id and held at module scope so
 * it SURVIVES component remounts. A `useRef` reset on every mount — which is
 * exactly why navigating away and back during the brief empty-list window used
 * to mint a second root. Keyed by the ephemeral per-sandbox server id, so a new
 * sandbox (e.g. after a restart) is correctly allowed its own single create.
 */
const createdForServer = new Set<string>();

/** Re-enable the one-shot create for all sandboxes — call when the runtime is
 *  intentionally torn down (e.g. session restart). Safe because create only
 *  fires when a sandbox genuinely has no root. */
export function clearCanonicalCreateGuard(): void {
  createdForServer.clear();
}

export interface CanonicalOpenCodeSession {
  /** The resolved canonical root id, or null while still resolving/creating. */
  rootSessionId: string | null;
  /** The live OpenCode session list for this sandbox (sorted by the list hook). */
  sessions: Session[];
  isLoading: boolean;
  isError: boolean;
  /** True once the list has been fetched at least once (even if empty). */
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
  const createMutation = useCreateOpenCodeSession();

  // The Kortix session row carries the persisted pin (`opencode_session_id`).
  const projectSessionQuery = useQuery({
    queryKey: ['project-session', projectId, sessionId],
    queryFn: () => getProjectSession(projectId, sessionId),
    enabled: !!projectId && !!sessionId,
    staleTime: 10_000,
  });
  const pinnedRootId = projectSessionQuery.data?.opencode_session_id ?? null;

  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);
  const pinPresent = !!pinnedRootId && sessions.some((s) => s.id === pinnedRootId);
  const justCreatedId = createMutation.data?.id ?? null;

  const rootSessionId = useMemo(
    () => resolveRootSessionId({ pinnedRootId, sessions, justCreatedId }),
    [pinnedRootId, sessions, justCreatedId],
  );

  const listSettled = !sessionsQuery.isLoading && !sessionsQuery.isError;

  // ── Create exactly one root, only when this sandbox has none ────────────
  // Guarded by the module-level sandbox-scoped set, so React-strict-mode,
  // refocus, and remount-during-empty-window can NEVER race a second root.
  useEffect(() => {
    if (!serverId) return;
    if (
      !shouldCreateRoot({
        runtimeReady,
        serverId,
        listSettled,
        pinPresent,
        sessions,
        alreadyCreated: createdForServer.has(serverId),
      })
    ) {
      return;
    }
    createdForServer.add(serverId);
    createMutation.mutate({ directory: '/workspace' });
  }, [runtimeReady, serverId, listSettled, pinPresent, sessions, createMutation]);

  // ── Pin / heal: make `opencode_session_id` the authoritative root ───────
  // Writes only when the resolved root differs from what's stored (covers the
  // first pin AND healing a stale pin after a sandbox rebuild), never thrashes
  // once they agree, and only ever pins a root (never a sub-session). The
  // attempt ref collapses duplicate concurrent PATCHes for the same target
  // while still allowing a retry if the write fails.
  const pinAttemptRef = useRef<string | null>(null);
  useEffect(() => {
    if (pinnedRootId === rootSessionId) {
      pinAttemptRef.current = rootSessionId; // already in sync — record + stop
      return;
    }
    const target = resolvePinWrite({
      runtimeReady,
      rootSessionId,
      pinnedRootId,
      sessions,
      attemptedTarget: pinAttemptRef.current,
    });
    if (!target) return;
    pinAttemptRef.current = target;
    void updateProjectSession(projectId, sessionId, { opencode_session_id: target })
      .then((updated) => {
        queryClient.setQueryData(['project-session', projectId, sessionId], updated);
        queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
      })
      .catch(() => {
        pinAttemptRef.current = null; // allow a retry on transient failure
      });
  }, [runtimeReady, rootSessionId, pinnedRootId, sessions, projectId, sessionId, queryClient]);

  return {
    rootSessionId,
    sessions,
    isLoading: sessionsQuery.isLoading,
    isError: sessionsQuery.isError,
    listed: sessionsQuery.isSuccess,
    error: sessionsQuery.error ?? createMutation.error ?? null,
  };
}
