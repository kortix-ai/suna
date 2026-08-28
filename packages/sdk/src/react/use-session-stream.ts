'use client';

/**
 * useSessionRuntimeStream — the ONE live connection a session view holds.
 *
 * It replaces the opencode-shaped `/p/<box>/8000/global/event` stream
 * (`openEventStream`) AND the connect-time `/p/` hydration reads
 * (`permission.list`, `question.list`, `session.status`) with a single SSE to
 * the CONTROL PLANE: `GET /projects/:pid/sessions/:sid/stream`.
 *
 * What rides it, and where each frame lands:
 *   - runtime channel — the daemon's envelopes, verbatim. They flow into the
 *     SAME reducer path the old stream fed (`createEventHandler` + sync
 *     store), so ids stay mirror-compatible and no translation layer exists.
 *   - control channel — the API's snapshots. `kortix.control.turn` and
 *     `kortix.control.queue` land in the exact react-query entries the
 *     `/turn` and `/prompts` polls fill, and while this stream is connected
 *     those polls hand their cadence over (see `useSessionStreamPresence`).
 *     `kortix.control.runtime_state` seeds statuses/permissions and recovers
 *     open questions — the job of the deleted 2 s self-heal polls.
 *
 * Because the upstream is the API (not the box), this mounts on SESSION
 * IDENTITY, not on runtime readiness: a stopped or waking box still delivers
 * queue/turn/mirror truth, and the runtime channel simply attaches when the
 * daemon does.
 *
 * Recovery is typed, never guessed:
 *   - a runtime `kortix.resync` (or a dense-seq gap) → re-read the transcript
 *     tail of every held session; an epoch change additionally refreshes the
 *     runtime catalogs (the daemon rebooted under us).
 *   - a control resync needs NO fetch — the server re-emits every snapshot.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import {
  noteSessionSyncEvent,
  reconcileSessionTail,
} from '../browser/session-sync/session-sync-registry';
import { useDiagnosticsStore } from '../browser/stores/diagnostics-store';
import { useOpenCodeCompactionStore } from '../browser/stores/opencode-compaction-store';
import { useOpenCodePendingStore } from '../browser/stores/opencode-pending-store';
import { noteRuntimeEvidence } from '../browser/stores/sandbox-connection-store';
import { useServerStore } from '../browser/stores/server-store';
import { useSyncStore } from '../browser/stores/sync-store';
import { logger } from '../core/http/logger';
import { claimOpenBundle } from '../core/session/open-bundle';
import { dropClientForUrl, getClient } from '../core/runtime/client';
import type { SessionOpenBundleRuntime } from '../core/rest/projects-client/sessions';
import type { SessionPrompt } from '../core/rest/projects-client/sessions';
import {
  connectSessionStream,
  type SessionStreamConnection,
} from '../core/stream/session-stream-controller';
import {
  markSessionAuditWatermark,
  markSessionRuntimeChannelLive,
  markSessionStreamConnected,
} from '../core/stream/session-stream-presence';
import { qk } from './query-keys';
import {
  applyRuntimeStateLeg,
  routeSessionStreamFrame,
  type RuntimeControlSnapshot,
  type RuntimeStateLegDeps,
} from './session-stream-routing';
import { clearConfigOverrides } from './use-opencode-config';
import { createEventHandler } from './use-opencode-events/handle-event';
import {
  releaseMessageRehydrate,
  reserveMessageRehydrate,
  resolveClientEvictionUrl,
} from './use-opencode-events/helpers';
import { sessionsNeedingRehydrate } from './use-opencode-events/rehydrate-targets';
import { useEventStreamRefs } from './use-opencode-events/use-event-stream-refs';
import { opencodeKeys } from './use-opencode-sessions';
import { useCurrentRuntime } from './use-current-runtime';
import { markCurrentRuntimeBundleApplied } from '../core/session/current-runtime';
import { noteInboxObservation, reconcileOptimisticPrompts } from './use-session-prompts';
import { resetPrefetchState } from './use-session-prefetch';
import { sessionStreamScope } from './use-session-stream-presence';
import type { SessionTurnObservation } from './use-session-working';

/** One full-question read per this window, however many snapshots name a
 *  missing ask — a recovery, not a poll. */
const ASK_RECOVERY_COOLDOWN_MS = 5_000;

export interface UseSessionRuntimeStreamOptions {
  /** Gate the whole connection (mirrors a query `enabled` flag). */
  enabled?: boolean;
}

export function useSessionRuntimeStream(
  projectId: string,
  sessionId: string,
  options: UseSessionRuntimeStreamOptions = {},
): void {
  const enabled = options.enabled !== false && !!projectId && !!sessionId;
  const queryClient = useQueryClient();
  const applySyncEvent = useSyncStore((s) => s.applyEvent);
  const stopCompaction = useOpenCodeCompactionStore((s) => s.stopCompaction);
  const addPermission = useOpenCodePendingStore((s) => s.addPermission);
  const removePermission = useOpenCodePendingStore((s) => s.removePermission);
  const addQuestion = useOpenCodePendingStore((s) => s.addQuestion);
  const removeQuestion = useOpenCodePendingStore((s) => s.removeQuestion);
  const clearPending = useOpenCodePendingStore((s) => s.clear);

  const {
    normalizeDiagnosticPaths,
    fetchLspDiagnosticsDebounced,
    markSessionAbortedLocally,
    reconcileMissingBusySessions,
  } = useEventStreamRefs({ queryClient, stopCompaction, applySyncEvent });

  // ── Runtime-switch bookkeeping, carried over from the old stream hook ─────
  // (T8: evict exactly the one stale cached opencode client; clear the
  // per-sandbox stores on a genuine switch.) Independent of the transport —
  // the runtime client still serves writes, files, pty, and the transcript
  // page loader, so its cache hygiene stays.
  const runtimeVersion = useCurrentRuntime((s) => s.version);
  const activeServerUrl = useServerStore((s) => s.getActiveServerUrl());
  const isMountRef = useRef(true);
  const prevRuntimeVersionRef = useRef(runtimeVersion);
  const prevServerUrlRef = useRef(activeServerUrl);
  useEffect(() => {
    const isFirstMount = isMountRef.current;
    isMountRef.current = false;
    const isServerSwitch = prevRuntimeVersionRef.current !== runtimeVersion;
    prevRuntimeVersionRef.current = runtimeVersion;
    const previousServerUrl = prevServerUrlRef.current;
    const didServerUrlChange = previousServerUrl !== activeServerUrl;
    prevServerUrlRef.current = activeServerUrl;

    const evictUrl = resolveClientEvictionUrl({
      isFirstMount,
      isServerSwitch,
      didServerUrlChange,
      previousServerUrl,
      activeServerUrl,
    });
    if (evictUrl) dropClientForUrl(evictUrl);

    if (isFirstMount || isServerSwitch) {
      clearConfigOverrides();
      clearPending();
      // Diagnostics are keyed by bare file path (no sandbox scope) and would
      // bleed across sandboxes; the sync store and query cache are per-sandbox
      // scoped and deliberately survive.
      useDiagnosticsStore.getState().clearAll();
      resetPrefetchState();
    }
  }, [runtimeVersion, activeServerUrl, clearPending]);

  // ── The stream itself ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return;

    let closed = false;
    let connection: SessionStreamConnection | null = null;

    const handleEvent = createEventHandler({
      queryClient,
      applySyncEvent,
      stopCompaction,
      addPermission,
      removePermission,
      addQuestion,
      removeQuestion,
      normalizeDiagnosticPaths,
      markSessionAbortedLocally,
      fetchLspDiagnosticsDebounced,
      reconcileSessionTail,
      projectId,
    });

    // One bounded full-question read when a state snapshot proves an open ask
    // this tab cannot render. Replaces the 2 s self-heal polls: it fires on
    // EVIDENCE (a snapshot naming an unknown ask), never on a timer.
    let askRecoveryInFlight = false;
    let askRecoveryLastAt = 0;
    const recoverQuestions = () => {
      const now = Date.now();
      if (askRecoveryInFlight || now - askRecoveryLastAt < ASK_RECOVERY_COOLDOWN_MS) return;
      let client: ReturnType<typeof getClient>;
      try {
        client = getClient();
      } catch {
        return; // runtime not pinned yet — the next snapshot retries
      }
      askRecoveryInFlight = true;
      askRecoveryLastAt = now;
      void client.question
        .list()
        .then((res) => {
          if (closed || !Array.isArray(res.data)) return;
          res.data.forEach(addQuestion);
        })
        .catch((error) => {
          logger.warn('question recovery read failed', { error: String(error) });
        })
        .finally(() => {
          askRecoveryInFlight = false;
        });
    };

    const legDeps = (): RuntimeStateLegDeps => ({
      nowMs: Date.now(),
      statusSlot: (sid) => {
        const state = useSyncStore.getState();
        return {
          hasSlot: !!state.sessionStatus[sid],
          origin: state.sessionStatusOrigin[sid],
          stampedAtMs: state.sessionStatusAt[sid],
        };
      },
      applySessionStatus: (sid, status) => {
        // A snapshot is a reading ABOUT the runtime, not the runtime speaking
        // on the wire — `synthetic` marks its write `'local'` (may fill or
        // correct, may never veto the server's open turn).
        applySyncEvent({
          type: 'session.status',
          synthetic: true,
          properties: { sessionID: sid, status },
        } as never);
      },
      reconcileMissingBusy: (statuses) => reconcileMissingBusySessions.current(statuses as never),
      hasPendingPermission: (id) => !!useOpenCodePendingStore.getState().permissions[id],
      hasPendingQuestion: (id) => !!useOpenCodePendingStore.getState().questions[id],
      addPermission: (permission) => addPermission(permission as never),
      requestAskRecovery: () => recoverQuestions(),
      seedRuntimeCollection: (kind, value) => {
        // The bundle already fetched these; write them into the exact cache the
        // hook reads so the panel never issues its own proxied roster read.
        const key =
          kind === 'agents'
            ? opencodeKeys.agents()
            : kind === 'commands'
              ? opencodeKeys.commands()
              : opencodeKeys.sessions();
        queryClient.setQueryData(key, value);
      },
    });

    const scope = sessionStreamScope(projectId, sessionId);

    const sinks = {
      applyRuntimeEvent: (event: never) => {
        // Every delivered daemon frame is live proof the runtime is reachable
        // — it vetoes concurrent health-probe failures, exactly as before —
        // and that the runtime CHANNEL is live, which is what stands the
        // transcript fallback poll down.
        noteRuntimeEvidence();
        markSessionRuntimeChannelLive(scope, true);
        noteSessionSyncEvent(event);
        handleEvent(event);
      },
      applyControlTurn: (observation: SessionTurnObservation) => {
        queryClient.setQueryData(qk.project.sessionTurn(projectId, sessionId), observation);
      },
      applyControlQueue: (prompts: SessionPrompt[], atMs: number) => {
        noteInboxObservation(sessionId, prompts, atMs);
        queryClient.setQueryData<SessionPrompt[]>(
          qk.project.sessionPrompts(projectId, sessionId),
          (prev) => reconcileOptimisticPrompts(prev, prompts),
        );
      },
      applyRuntimeStateLeg: (leg: unknown) => applyRuntimeStateLeg(leg, legDeps()),
      applyControlAudit: (fingerprint: string) => {
        // Push the change onto the scope's audit signal. The web audit surface
        // reads it to invalidate its query and to stand its poll down — the
        // control channel is the notify path now, the endpoint stays the read.
        markSessionAuditWatermark(scope, fingerprint);
      },
      applyControlRuntime: (runtime: RuntimeControlSnapshot) => {
        // The control plane's LIVE box view (was dropped). Cache-only — read by
        // `useSessionRuntimeControl`, which feeds `projectSessionConnection`, so
        // connection/readiness reacts to the stream instead of a poll.
        queryClient.setQueryData(
          qk.project.sessionRuntimeControl(projectId, sessionId),
          runtime,
        );
      },
    };

    /** Re-read THIS stream's session transcript — the honest response to any
     *  signal that runtime frames were lost. The stream is per (projectId,
     *  sessionId), so a gap or resync here concerns this session only; every
     *  other open session runs its own stream and repairs its own gaps. Re-reading
     *  every held transcript on one stream's resync was the multi-MB refetch-all
     *  storm — see `sessionsNeedingRehydrate`. `reserveMessageRehydrate` still
     *  applies its 30s per-session cooldown, so a burst of reconnects coalesces. */
    const reconcileStreamSession = () => {
      for (const sid of sessionsNeedingRehydrate(sessionId)) {
        if (!reserveMessageRehydrate(sid)) continue;
        reconcileSessionTail(sid, 'sse-gap')
          .catch(() => {})
          .finally(() => releaseMessageRehydrate(sid));
      }
    };

    const start = async () => {
      // Seed from the open bundle when one is claimable: the runtime leg is
      // the daemon's state document at capture, and its `{epoch, seq}` is the
      // cursor to stream from — so seeding and streaming cannot disagree
      // about what is already applied. No bundle → no cursor → the server
      // sends full control snapshots anyway, which is not a gap.
      let cursor: { epoch?: string | null; seq?: number | null } | undefined;
      const claimed = claimOpenBundle(projectId, sessionId);
      if (claimed) {
        try {
          const bundle = await claimed;
          const runtime = bundle?.runtime as SessionOpenBundleRuntime | undefined;
          if (!closed && runtime && runtime.known === true) {
            applyRuntimeStateLeg(runtime, legDeps());
            cursor = { epoch: runtime.epoch, seq: runtime.seq };
          }
        } catch {
          // The bundle never rejects, but a claim must never block the stream.
        }
      }
      // Whether or not a bundle landed, the roster seeds (if any) are now in
      // cache — release the roster hooks so they read that cache. Without a
      // bundle this lets them fall back to their own fetch; with one it wins
      // the mount-vs-seed race so no redundant /agent,/command,/session fires.
      if (!closed) markCurrentRuntimeBundleApplied();
      if (closed) return;

      connection = connectSessionStream({
        projectId,
        sessionId,
        ...(cursor ? { cursor } : {}),
        onFrame: (frame) => {
          // `kortix.runtime.status` is the API naming the daemon attach state
          // — `up` means the runtime channel is (about to be) delivering,
          // every `down` reason means it is not. It drives the transcript
          // fallback poll's switch.
          if (frame.channel === 'stream' && frame.type === 'kortix.runtime.status') {
            markSessionRuntimeChannelLive(scope, (frame as { state?: unknown }).state === 'up');
          }
          routeSessionStreamFrame(frame, sinks as never);
        },
        onConnectionChange: (connected) => {
          markSessionStreamConnected(scope, connected);
          // A dead stream delivers no daemon frames, whatever the box does.
          if (!connected) markSessionRuntimeChannelLive(scope, false);
        },
        onRuntimeResync: (info) => {
          reconcileStreamSession();
          if (info.epochChanged) {
            // The daemon rebooted: every runtime catalog this tab holds
            // describes the previous boot.
            for (const key of [
              opencodeKeys.sessions(),
              opencodeKeys.agents(),
              opencodeKeys.commands(),
              opencodeKeys.mcpStatus(),
              opencodeKeys.toolIds(),
            ]) {
              void queryClient.invalidateQueries({ queryKey: key, type: 'active' });
            }
          }
        },
        onRuntimeGap: () => {
          // Per-session stream: the gap is this session's. `info.session` always
          // equals `sessionId` here, so scope to it like the resync path does.
          reconcileStreamSession();
        },
      });
    };

    void start();

    return () => {
      closed = true;
      connection?.close();
      connection = null;
    };
    // Session identity + the gate are the whole dependency list: the
    // controller owns reconnects, so nothing else may bounce the connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, projectId, sessionId, queryClient]);
}
