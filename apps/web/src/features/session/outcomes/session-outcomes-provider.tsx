'use client';

/**
 * The session's outcomes, computed ONCE.
 *
 * Not a per-turn hook, deliberately. `session-chat.tsx` carries an explicit
 * warning that its turn component re-renders ~60×/second while a response
 * streams, and that ~28 `useMemo`s hang off each render. A `useChangeRequests`
 * call inside the turn would multiply one network cache read by every turn in
 * the transcript, on every frame.
 *
 * So: one query here, one anchor pass here, and `useTurnOutcomes` returns a
 * slice by key. The slice identity is stable while the outcome set is
 * unchanged, so a turn that has no outcomes re-renders no differently than it
 * does today.
 *
 * ## Why this hook and not the SDK's
 *
 * Two hooks named `useChangeRequests` exist, and they populate DIFFERENT React
 * Query caches:
 *
 * - `@kortix/sdk/react` keys on `['project-change-requests', projectId, status]`
 * - `@/features/project-files/hooks/use-change-requests` keys on
 *   `['project-files', 'change-requests', projectId, 'list', status]`
 *
 * `ChangeRequestDetailDialog` — the modal this card opens — mutates through the
 * project-files hook, and its `useInvalidateAll` (use-change-requests.ts:237)
 * invalidates `changeRequestKeys.project(projectId)` and nothing under
 * `project-change-requests`. Read the SDK cache here and a card would still
 * say "Waiting for you" after the user merged the change request in the dialog
 * two inches above it.
 *
 * That is exactly the failure this whole feature exists to prevent — "the
 * status is a lie the moment it is written" is the first line of the spec's
 * problem statement. So the provider reads the cache the mutations invalidate.
 *
 * The consequence: this provider must sit inside a `ProjectFilesProvider`,
 * because the hook takes its project id from that context rather than a
 * parameter. Task 5 mounts it.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';

// NOT `@kortix/sdk/react`'s hook of the same name. See the note below — this is
// a cache-coherence requirement, not a style preference.
import { useChangeRequests } from '@/features/project-files/hooks/use-change-requests';

import { anchorOutcomes, type TurnSpan } from './anchor-outcomes';
import { changeRequestOutcomes } from './change-request-outcomes';
import type { Outcome } from './outcome-types';

interface OutcomesValue {
  byTurn: Map<string, Outcome[]>;
  all: Outcome[];
  onOpen: (outcome: Outcome) => void;
}

const EMPTY: Outcome[] = [];
const OutcomesContext = createContext<OutcomesValue | null>(null);

export function SessionOutcomesProvider({
  projectSessionId,
  turnSpans,
  onOpen,
  children,
}: {
  /** The git session id a change request records as `origin_session_id`. */
  projectSessionId: string | undefined;
  turnSpans: TurnSpan[];
  onOpen: (outcome: Outcome) => void;
  children: ReactNode;
}) {
  // No `projectId` argument: this hook reads it from `ProjectFilesProvider`,
  // which is what keeps it on the same cache entry the dialog invalidates.
  // `'all'` because a merged or closed change request is still an outcome of
  // the turn that produced it — it just reads "Applied" or "Closed".
  const { data } = useChangeRequests('all', { refetchInterval: 60_000 });

  const all = useMemo(
    // Change requests are the only outcome a turn produces. The derived
    // pipeline (files, schedules, background tasks, connector links) was built
    // and removed — see `OutcomeKind` for why each one could not be tied to the
    // turn that showed it.
    () => changeRequestOutcomes(data?.change_requests ?? [], projectSessionId),
    [data?.change_requests, projectSessionId],
  );

  const byTurn = useMemo(() => anchorOutcomes(all, turnSpans), [all, turnSpans]);

  const value = useMemo<OutcomesValue>(() => ({ byTurn, all, onOpen }), [byTurn, all, onOpen]);

  return <OutcomesContext.Provider value={value}>{children}</OutcomesContext.Provider>;
}

/** A turn's outcomes, oldest first. `EMPTY` is a module constant so a turn with
 *  no outcomes gets the SAME array every render and never re-renders for it. */
export function useTurnOutcomes(turnKey: string): Outcome[] {
  const ctx = useContext(OutcomesContext);
  return ctx?.byTurn.get(turnKey) ?? EMPTY;
}

export function useAllOutcomes(): Outcome[] {
  return useContext(OutcomesContext)?.all ?? EMPTY;
}

export function useOutcomeOpen(): (outcome: Outcome) => void {
  const ctx = useContext(OutcomesContext);
  return ctx?.onOpen ?? noop;
}

const noop = () => {};
