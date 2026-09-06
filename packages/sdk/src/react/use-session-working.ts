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
import { claimOpenBundle, openBundleTurn } from '../core/session/open-bundle';
import { qk } from './query-keys';
import { usePollOwner } from './use-poll-owner';

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
  /**
   * Who minted the status frame (`useSyncStore.sessionStatusOrigin`). `'local'`
   * marks a tab fabrication — the missing-busy sweep, a synthetic abort, a
   * cache handoff — which may answer for a silent session but may never veto
   * the server's open turn. Absent means `'wire'`.
   */
  statusOrigin?: 'wire' | 'local';
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
          // Only an explicit terminal state can clear an active session. An
          // unknown producer state must preserve the user's Stop control.
          type:
            input.status.type === 'idle'
              ? 'idle'
              : input.status.type === 'retry'
                ? 'retry'
                : 'busy',
          origin: input.statusOrigin ?? 'wire',
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

/**
 * The instant a status frame counts from: the store's own arrival stamp
 * (`sessionStatusAt`, written by `setStatus` when the frame landed), falling
 * back to the observer's clock only for a slot that predates the stamp slice.
 *
 * Stamping at OBSERVATION was the old rule, and it had a resurrection hole: a
 * remount resets the observation state, the effect re-stamps whatever the
 * store still holds, and a dead stream's last idle frame came back looking
 * brand new — fresh enough to veto the open `/turn` row for another full
 * `STREAM_OBSERVATION_MAX_MS` window. The frame's age is a fact about the
 * frame, so it lives with the frame.
 */
export function streamObservationStamp(
  storeStampMs: number | undefined,
  nowMs: number,
): number {
  return storeStampMs ?? nowMs;
}

/**
 * ONE reading of "which turns are open", for the `/turn` query.
 *
 * It claims the SESSION-OPEN BUNDLE first. Three hooks mount this query on a
 * session route (`useSession`, the composer, the session panel) and the open
 * path reads it before anything else can, which measured as up to 6 `/turn`
 * requests inside a single open. A claim only succeeds while an open bundle is
 * in flight or seconds old, so the burst collapses to one server answer and
 * every poll after it still goes to the endpoint.
 *
 * A claim that answers `null` — no bundle, a failed bundle, or a bundle whose
 * turn leg was `known: false` — falls through to `GET .../turn`. UNKNOWN is not
 * idle: the fallback must ASK, never assume.
 *
 * Exported because this package has no hook-render harness: the reads and pure
 * predicates ARE the test surface for effect-gated logic.
 */
export async function readSessionTurnObservation(
  projectId: string,
  sessionId: string,
): Promise<SessionTurnObservation> {
  const claimed = claimOpenBundle(projectId, sessionId);
  if (claimed) {
    const bundle = await claimed;
    const turn = bundle ? openBundleTurn(bundle) : null;
    // The stamp is the bundle's `observed_at` — the instant the SERVER took the
    // reading — never arrival, for the same reason the direct read below stamps
    // before the request and not after it.
    if (turn) return { turns: turn.turns, last_ended: turn.last_ended, atMs: turn.atMs };
  }
  // Stamped BEFORE the request. An answer is only as fresh as the moment
  // it was asked, and a slow proxy hop must not make a stale read look new.
  const atMs = Date.now();
  const status = await getSessionTurn(projectId, sessionId);
  return { turns: status.turns ?? [], last_ended: status.last_ended, atMs };
}

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
  // Who minted that frame — `'local'` for a tab fabrication, which the
  // projection lets answer but never lets contradict the server's open turn.
  const statusOrigin = useSyncStore((state) =>
    streamKey ? state.sessionStatusOrigin[streamKey] : undefined,
  );
  // When the frame LANDED in the store — the stamp `observed` below counts
  // from, so a remount cannot resurrect a dead stream's frame as fresh.
  const statusAtMs = useSyncStore((state) =>
    streamKey ? state.sessionStatusAt[streamKey] : undefined,
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
    origin: 'wire' | 'local';
    atMs: number;
  } | null>(null);
  useEffect(() => {
    if (!status) {
      setObserved((previous) => (previous && previous.key === streamKey ? previous : null));
      return;
    }
    // An origin flip over an unchanged value re-stamps too: the store kept the
    // object's identity on purpose (`setStatus`), but a wire frame landing
    // over a fabricated one — or the reverse — is a new observation. The stamp
    // itself is the store's arrival time (`streamObservationStamp`), so a
    // remount observing an OLD frame does not mint it a new age.
    setObserved({
      key: streamKey,
      status,
      origin: statusOrigin ?? 'wire',
      atMs: streamObservationStamp(statusAtMs, Date.now()),
    });
  }, [status, statusOrigin, statusAtMs, streamKey]);
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
      statusOrigin: stream?.origin,
      activityAtMs,
      optimistic,
      abort,
      nowMs,
    });
  const project = (turn: SessionTurnObservation | undefined, nowMs: number): WorkingProjection =>
    projectWorking(inputsFor(turn, nowMs));

  const pollOwner = usePollOwner(`turn:${projectId}/${sessionId}`, canRead);

  const query = useQuery({
    queryKey: qk.project.sessionTurn(projectId, sessionId),
    enabled: canRead,
    queryFn: () => readSessionTurnObservation(projectId, sessionId),
    // ONE timer per session, however many components mount this hook.
    // `refetchInterval` is scheduled per OBSERVER: three mount points on a
    // session route (this hook is called by `useSession`, the composer and the
    // session panel) ran three timers against one cache entry and polled the
    // session at three times its declared cadence — measured as 6 `/turn`
    // reads inside one 25 s open. Non-owners read the same entry the owner
    // refreshes, so nobody sees a staler answer; only the scheduling moved.
    refetchInterval: (query) =>
      pollOwner ? workingPollMs(project(query.state.data, Date.now())) : false,
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
