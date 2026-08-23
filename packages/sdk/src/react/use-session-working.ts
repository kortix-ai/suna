'use client';

import type { SessionStatus } from '@opencode-ai/sdk/v2/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useSessionWorkingStore } from '../browser/stores/session-working-store';
import { useSyncStore } from '../browser/stores/sync-store';
import {
  type SessionTurn,
  type SessionTurnEnded,
  getSessionTurn,
} from '../core/rest/projects-client/sessions';
import {
  type AbortReceipt,
  type SendReceipt,
  type WorkingInboxInput,
  type WorkingInputs,
  type WorkingProjection,
  projectWorking,
  workingExpiryAtMs,
} from '../core/session/working';
import { qk } from './query-keys';

/**
 * The ONE answer to "is this session working?", and where the answer came from.
 *
 * It replaces four machines that each held a private opinion and could not be
 * reconciled: a prompt-observation phase machine with a stall timer, a busy
 * status override in the sync layer, a 30s safety timeout in the composer, and
 * a 5s polling grace beside it. When a session stayed busy forever, none of
 * them could be blamed or believed — which is exactly why this one is a pure
 * projection over observations that are each stamped and attributed.
 */

/** Cadence while the session is idle. Never `false`: a turn can START without
 *  this tab doing anything — a trigger fires, a second device sends, the inbox
 *  delivers a queued prompt — and only a poll (or an SSE frame that may never
 *  come) can show it. */
export const WORKING_POLL_IDLE_MS = 15_000;
/** Cadence while the session is working, including on this tab's own
 *  unanswered receipt: the end of the turn is the news worth having early. */
export const WORKING_POLL_ACTIVE_MS = 5_000;

export function workingPollMs(projection: WorkingProjection): number {
  return projection.state === 'working' ? WORKING_POLL_ACTIVE_MS : WORKING_POLL_IDLE_MS;
}

/**
 * Which side of a turn boundary a status frame is on.
 *
 * The runtime does NOT emit one frame per turn. Measured mid-turn on the local
 * stack, it alternated `busy` → `retry` → `busy` about every 140ms, and an
 * effect keyed on the observation INSTANT therefore re-invalidated `/turn` and
 * `/prompts` at that rate, once per mount. A `busy`→`retry` flip is not news
 * about whether a turn is open; only crossing between `idle` and not-idle is.
 *
 * `'none'` is deliberately distinct from `'idle'`: silence is not an
 * observation, and collapsing them would stop the FIRST frame of a turn from
 * reading as a change.
 */
export function streamTurnPhase(status: SessionStatus | undefined): 'idle' | 'active' | 'none' {
  if (!status) return 'none';
  return status.type === 'idle' ? 'idle' : 'active';
}

/** One `GET .../turn` answer plus the instant the read was ISSUED. Stamping at
 *  issue rather than arrival is what lets the projection tell "this read is
 *  older than the send" from "this read answers the send". */
export interface SessionTurnObservation {
  turns: SessionTurn[];
  last_ended?: SessionTurnEnded;
  atMs: number;
}

/** Fold the two live sources plus the local receipt into the projection's
 *  inputs. Pure, so "a failed read contributes nothing" is a test, not a
 *  convention. */
export function buildWorkingInputs(input: {
  turn: SessionTurnObservation | undefined;
  inbox: WorkingInboxInput | undefined;
  status: SessionStatus | undefined;
  statusAtMs: number;
  /** When the runtime's own output last reached this tab for this session
   *  (`useSyncStore.sessionActivityAt`). 0/undefined when it never has. */
  activityAtMs?: number;
  optimistic: SendReceipt | null;
  abort?: AbortReceipt | null;
  nowMs: number;
}): WorkingInputs {
  return {
    nowMs: input.nowMs,
    optimistic: input.optimistic,
    abort: input.abort ?? null,
    inbox: input.inbox ?? null,
    server: input.turn
      ? { turns: input.turn.turns, lastEnded: input.turn.last_ended, atMs: input.turn.atMs }
      : null,
    // The runtime's own output, which is not an observation OF the runtime but
    // the runtime itself — see `WorkingActivityInput`. It is what answers when
    // every observer has gone quiet: a dropped status frame, a poll throttled
    // by a backgrounded tab.
    activity: input.activityAtMs ? { atMs: input.activityAtMs } : null,
    // Silence is not an observation. A session with no status frame yet feeds
    // NOTHING here — the old code read "no status" as idle, which unmasked
    // live turns whenever a frame was dropped.
    stream: input.status
      ? {
          type:
            input.status.type === 'busy' || input.status.type === 'retry'
              ? input.status.type
              : 'idle',
          atMs: input.statusAtMs,
        }
      : null,
  };
}

export interface UseSessionWorkingOptions {
  enabled?: boolean;
  /**
   * The OpenCode wire session id whose SSE status frames belong to this
   * session, when the host knows it.
   *
   * Two ids, deliberately: `sessionId` is the Kortix session (what `/turn` is
   * addressed by), while the sync store is keyed by the wire id OpenCode
   * assigns inside the sandbox. Passing the wrong one would read another
   * session's frames, so it is explicit rather than guessed.
   */
  runtimeSessionId?: string | null;
}

/** How many live `useSessionWorking` mounts observe each session — the guard
 *  that makes the unmount pruning below safe under multiple observers. */
const workingObserverCounts = new Map<string, number>();

export function useSessionWorking(
  projectId: string,
  sessionId: string,
  options: UseSessionWorkingOptions = {},
): WorkingProjection {
  const { enabled = true, runtimeSessionId = null } = options;
  const streamKey = runtimeSessionId ?? '';
  const status = useSyncStore((state) =>
    streamKey ? (state.sessionStatus[streamKey] as SessionStatus | undefined) : undefined,
  );
  // Both LOCAL inputs come from one per-session store rather than from props.
  // More than one place mounts this hook for the same session and they share
  // one `/turn` cache entry; when each held its own receipt, the observer
  // without one wrote an uninformed read into that entry and defeated the
  // other's receipt. See `session-working-store.ts`.
  const optimistic = useSessionWorkingStore((state) => state.receipts[sessionId] ?? null);
  const abort = useSessionWorkingStore((state) => state.aborts[sessionId] ?? null);
  const inbox = useSessionWorkingStore((state) => state.inbox[sessionId]);

  // Leak hygiene: drop the session's inputs when the LAST observer unmounts.
  // Refcounted, because several places mount this hook for one session
  // (`useSession`, the composer, the session panel) — a single unmount while
  // the others are live must never delete the receipt a send is standing on.
  useEffect(() => {
    if (!sessionId) return;
    workingObserverCounts.set(sessionId, (workingObserverCounts.get(sessionId) ?? 0) + 1);
    return () => {
      const next = (workingObserverCounts.get(sessionId) ?? 1) - 1;
      if (next > 0) {
        workingObserverCounts.set(sessionId, next);
        return;
      }
      workingObserverCounts.delete(sessionId);
      useSessionWorkingStore.getState().clearSession(sessionId);
    };
  }, [sessionId]);

  // Stamped when THIS tab observed the frame — the store keeps no arrival time,
  // and an unstamped frame cannot be ranked against a server read. Written in
  // an effect, never during render (a render-phase ref write deadlocked the
  // session shell once already).
  const [observed, setObserved] = useState<{
    key: string;
    status: SessionStatus;
    atMs: number;
  } | null>(null);
  useEffect(() => {
    if (!status) {
      setObserved((previous) => (previous && previous.key === streamKey ? previous : null));
      return;
    }
    setObserved({ key: streamKey, status, atMs: Date.now() });
  }, [status, streamKey]);
  const stream = observed && observed.key === streamKey ? observed : null;

  // The runtime's own output for THIS session's wire id. Quantized to a second
  // in the store, so subscribing here cannot re-render at the stream's rate.
  const activityAtMs = useSyncStore((s) =>
    streamKey ? s.sessionActivityAt[streamKey] : undefined,
  );

  const canRead = enabled && !!projectId && !!sessionId;

  const inputsFor = (turn: SessionTurnObservation | undefined, nowMs: number): WorkingInputs =>
    buildWorkingInputs({
      turn,
      inbox,
      status: stream?.status,
      statusAtMs: stream?.atMs ?? 0,
      activityAtMs,
      optimistic,
      abort,
      nowMs,
    });
  const project = (turn: SessionTurnObservation | undefined, nowMs: number): WorkingProjection =>
    projectWorking(inputsFor(turn, nowMs));

  const query = useQuery({
    queryKey: qk.project.sessionTurn(projectId, sessionId),
    enabled: canRead,
    queryFn: async (): Promise<SessionTurnObservation> => {
      // Stamped BEFORE the request. An answer is only as fresh as the moment
      // it was asked, and a slow proxy hop must not make a stale read look new.
      const atMs = Date.now();
      const status = await getSessionTurn(projectId, sessionId);
      return { turns: status.turns ?? [], last_ended: status.last_ended, atMs };
    },
    refetchInterval: (query) => workingPollMs(project(query.state.data, Date.now())),
    // Coming back to a tab is the moment a turn that started (or ended) while
    // it was hidden has to be on screen.
    refetchOnWindowFocus: true,
    // A read that failed says nothing; it must not fabricate either state.
    // `SERVER_OBSERVATION_MAX_MS` is what stops the retained last-success from
    // deciding once the failures outlast it.
    retry: 1,
  });

  // A status frame is the earliest news there is that a turn started or ended.
  // NOTHING invalidated this query before — no SSE frame, no mutation — so a
  // turn that ended stayed "open" in the cache until the next interval tick.
  // That window was up to WORKING_POLL_ACTIVE_MS of the composer holding Stop
  // after the last token, and of `rewind()` throwing "Cannot rewind a busy
  // session" on the Edit the user clicked the moment the reply landed.
  // The prompt list is invalidated with it: a reading of the inbox is the one
  // input with a life shorter than its own poll interval, and the turn ending
  // is exactly when a `waiting` row becomes a running one.
  const queryClient = useQueryClient();
  // Keyed on the PHASE, not on the observation instant. The instant changes on
  // every frame, and the runtime emits many per turn — see `streamTurnPhase`
  // for the measured `busy`/`retry` oscillation this stops re-fetching on.
  const streamPhase = streamTurnPhase(stream?.status);
  useEffect(() => {
    if (!canRead || streamPhase === 'none') return;
    void queryClient.invalidateQueries({
      queryKey: qk.project.sessionTurn(projectId, sessionId),
    });
    void queryClient.invalidateQueries({
      queryKey: qk.project.sessionPrompts(projectId, sessionId),
    });
  }, [canRead, projectId, sessionId, streamPhase, queryClient]);

  // Re-evaluated on every render because `nowMs` moves — the projection is
  // pure, so this costs one object and cannot drift from the poll's own view.
  const inputs = inputsFor(canRead ? query.data : undefined, Date.now());
  const projection = projectWorking(inputs);

  // EVERY input ages out, and nothing else re-renders at the instant it does.
  //
  // This is not only the send receipt's cap. react-query hands back the last
  // SUCCESSFUL `data` while the reads after it fail, and it does not notify
  // this observer while doing so — `data` is unchanged — so in the outage
  // `SERVER_OBSERVATION_MAX_MS` was written for there is no render at all
  // after the first failure, and the bound was never applied. The timer
  // decides nothing: it asks the pure projection again with a newer `now`.
  const [, setExpiryTick] = useState(0);
  const expiryAtMs = workingExpiryAtMs(inputs);
  useEffect(() => {
    if (expiryAtMs === null) return;
    const timer = setTimeout(
      () => setExpiryTick((tick) => tick + 1),
      Math.max(0, expiryAtMs - Date.now()) + 1,
    );
    return () => clearTimeout(timer);
  }, [expiryAtMs]);

  // Stable identity while the ANSWER is unchanged, so consumers that memoize on
  // it are not re-run once per render just because `now` moved.
  const identity = `${projection.state}|${projection.source}|${projection.turnId}|${projection.since}|${projection.serverOpenTurnToken}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => projection, [identity]);
}
