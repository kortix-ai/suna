'use client';

import { type QueryClient } from '@tanstack/react-query';
import type { Event as OpenCodeSdkEvent } from '@opencode-ai/sdk/v2/client';
import { useRef } from 'react';
import { authenticatedFetch } from '../../core/http/auth';
import { useDiagnosticsStore, type RawDiagnostic } from '../../browser/stores/diagnostics-store';
import { getActiveOpenCodeUrl } from '../../browser/stores/server-store';
import { useSyncStore } from '../../browser/stores/sync-store';
import type { SyntheticAbortError } from '../../browser/stores/sync-store/types';
import { type Project, type PathInfo, type SessionStatus, opencodeKeys } from '../use-opencode-sessions';
import { qk } from '../query-keys';
import type { NormalizeDiagnosticPaths } from './types';

// Read off the key factory rather than hand-typed, so the matcher moves with
// `qk` instead of silently missing every key after a segment is renamed.
const [KEY_ROOT, PROJECT_SEGMENT] = qk.project.scope('');
const TURN_SEGMENT = qk.project.sessionTurn('', '').at(-1);
const PROMPTS_SEGMENT = qk.project.sessionPrompts('', '').at(-1);

/**
 * Every `GET .../turn` and `GET .../prompts` entry in the cache, for any
 * project and any session.
 *
 * Matched by SHAPE rather than by `qk.project.sessionTurn(projectId,
 * sessionId)`, because `server.instance.disposed` carries neither id: it is
 * scoped to a runtime instance, and the handler only ever holds OpenCode WIRE
 * session ids, while those keys are built from the Kortix `(projectId,
 * sessionId)` pair. The instance going away affects every session the tab was
 * watching on it, so re-reading all of them is the honest breadth — and both
 * families are cheap server reads that the working projection is about to ask
 * for anyway.
 */
function isSessionTruthQuery(query: { queryKey: readonly unknown[] }): boolean {
  const key = query.queryKey;
  const tail = key[key.length - 1];
  return (
    key[0] === KEY_ROOT &&
    key[1] === PROJECT_SEGMENT &&
    (tail === TURN_SEGMENT || tail === PROMPTS_SEGMENT)
  );
}

/**
 * Creates the stable per-stream refs used by the event hook. Each ref captures
 * the first-render values of `queryClient`, `stopCompaction`, and
 * `applySyncEvent` (all stable), matching the original inline `useRef` setup.
 */
export function useEventStreamRefs(deps: {
  queryClient: QueryClient;
  stopCompaction: (sessionID: string) => void;
  applySyncEvent: (event: OpenCodeSdkEvent) => void;
}) {
  const { queryClient, stopCompaction, applySyncEvent } = deps;

  /**
   * Resolve an absolute sandbox path to a project-relative path by stripping
   * known worktree/directory prefixes from the React Query cache.
   *
   * For example: `/workspace/desktop/express-crud-app/src/server.js` → `src/server.js`
   *
   * This is critical for LSP diagnostics: the backend sends absolute paths,
   * but the frontend file tree / file viewer uses project-relative paths.
   */
  const normalizeLspPath = useRef((absPath: string): string => {
    if (!absPath || !absPath.startsWith('/')) return absPath;

    // Collect prefixes from cached project/path data
    const prefixes: string[] = [];
    try {
      const project = queryClient.getQueryData<Project>(opencodeKeys.currentProject());
      if (project?.worktree) prefixes.push(project.worktree);
      const pathInfo = queryClient.getQueryData<PathInfo>(opencodeKeys.pathInfo());
      if (pathInfo?.directory) prefixes.push(pathInfo.directory);
      if (pathInfo?.worktree) prefixes.push(pathInfo.worktree);
    } catch {
      // non-critical
    }

    // Deduplicate and sort longest first (most specific prefix wins)
    const unique = [...new Set(prefixes.filter(Boolean))].sort((a, b) => b.length - a.length);

    for (const wt of unique) {
      if (!wt || wt === '/') continue;
      const prefix = wt.endsWith('/') ? wt : wt + '/';
      if (absPath.startsWith(prefix)) {
        return absPath.slice(prefix.length);
      }
    }

    return absPath;
  });

  /** Normalize all keys in a diagnostic map from absolute to relative paths */
  const normalizeDiagnosticPaths = useRef<NormalizeDiagnosticPaths>(
    function normalizeDiagnosticPaths<T>(diagsByFile: Record<string, T[]>): Record<string, T[]> {
      const normalized: Record<string, T[]> = {};
      for (const [file, diags] of Object.entries(diagsByFile)) {
        const relPath = normalizeLspPath.current(file);
        normalized[relPath] = diags;
      }
      return normalized;
    },
  );

  /**
   * Debounced fetch of all LSP diagnostics from the backend.
   *
   * The `lsp.client.diagnostics` SSE event only carries { serverID, path }
   * (no actual diagnostic data). Multiple events fire in rapid succession
   * as the language server reports diagnostics for different files, so we
   * debounce and fetch the full diagnostics map from GET /lsp/diagnostics.
   */
  const fetchLspDiagnosticsDebounced = useRef(
    (() => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      return () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          timer = null;
          try {
            const baseUrl = getActiveOpenCodeUrl();
            const resp = await authenticatedFetch(`${baseUrl}/lsp/diagnostics`);
            if (!resp.ok) return;
            const data = (await resp.json()) as Record<string, RawDiagnostic[]>;
            if (data && typeof data === 'object') {
              const normalized = normalizeDiagnosticPaths.current(data);
              // The endpoint returns the *complete* diagnostics state,
              // so clear stale entries before applying the fresh data.
              const store = useDiagnosticsStore.getState();
              store.clearAll();
              store.setFromLspEvent(normalized);
            }
          } catch {
            // Silently ignore — diagnostics are non-critical and the
            // endpoint may not be available on older OpenCode versions.
          }
        }, 250);
      };
    })(),
  );

  const markSessionAbortedLocally = useRef(
    (sessionID: string, message = 'The operation was aborted because the runtime shut down.') => {
      if (!sessionID) return;
      // `reason: 'runtime-disposed'` — pure infrastructure (OpenCode
      // disposed/respawned mid-stream), never a user action. Read via the
      // SDK's `abortErrorReason` (`core/http/abort-error.ts`); apps/web
      // renders this reason as nothing — no Interrupted row, no error
      // banner — because a runtime that respawns cleanly must not scar the
      // transcript.
      const error: SyntheticAbortError = {
        name: 'AbortError',
        data: { message, reason: 'runtime-disposed' },
      };
      stopCompaction(sessionID);
      // Locally-synthesized event — not from the wire, so it intentionally
      // omits the `id` field every real `Event` union member carries, and
      // `error` is the client-only `SyntheticAbortError` shape (not part of
      // the SDK's `session.error` error union). The sync store's `applyEvent`
      // handles both structurally (see `MessageError`); the assertion just
      // documents that this event is fabricated, not wire data.
      // `synthetic: true` is what that fabrication COSTS: the idle status this
      // writes lands with `'local'` origin, so it may fill a gap but can never
      // veto the control plane's open turn (`WorkingStreamInput.origin`).
      applySyncEvent({
        type: 'session.error',
        synthetic: true,
        properties: { sessionID, error },
      } as unknown as OpenCodeSdkEvent);
      // A brand-new session whose first prompt has not been echoed yet is the
      // one case this must not touch: the prompt is a durable server row and
      // the inbox will redeliver it, so wiping the bubble here deletes text the
      // user typed for a turn that is about to run. Its sibling
      // `reconcileMissingBusySessions` has guarded exactly this since the
      // "message sent from home vanishes" bug; this path never did, and it runs
      // for EVERY non-idle session in the tab on one `server.instance.disposed`
      // frame.
      if (!useSyncStore.getState().hasOptimisticMessages(sessionID)) {
        useSyncStore.getState().clearOptimisticMessages(sessionID);
      }
      // No status write. One runtime instance going away is not evidence that
      // the session is idle: the control plane may still hold the turn, and the
      // box may already be resuming under it. Re-read the sources that CAN know
      // — the turn authority and the durable prompt inbox — and let
      // `projectWorking` answer.
      void queryClient.invalidateQueries({ predicate: isSessionTruthQuery });
    },
  );

  const markSessionIdleLocally = useRef((sessionID: string) => {
    if (!sessionID) return;
    stopCompaction(sessionID);
    // Same locally-synthesized-event caveat as above: no real `id`, and
    // `synthetic: true` so the idle it writes is `'local'`-origin — an
    // INFERENCE from a snapshot's absence, which may answer for a session
    // nothing else speaks for but may never contradict an open `/turn` row.
    // Unmarked, one sweep un-busied a session mid-turn and the unbounded idle
    // veto then discarded every fresh `/turn` read for the rest of the turn
    // (dev, 2026-08-24: no busy indicator, Send instead of Stop, transcript
    // liveness poll off — all while the agent was running).
    applySyncEvent({
      type: 'session.idle',
      synthetic: true,
      properties: { sessionID },
    } as unknown as OpenCodeSdkEvent);
    useSyncStore.getState().setStatus(sessionID, { type: 'idle' }, 'local');
    useSyncStore.getState().clearOptimisticMessages(sessionID);
  });

  /**
   * Walk any session the runtime no longer reports as busy back to idle.
   *
   * This is NOT an inference from silence. `client.session.status()` is a REST
   * read of the runtime's COMPLETE set of non-idle sessions, so a session's
   * absence from it is a positive statement about that session. It is the only
   * repair the raw `sessionStatus` slot has for a MISSED terminal frame — a
   * laptop sleeping mid-turn, a stream reconnect. Every remaining direct
   * reader of that slot is a CHILD-session surface — sub-sessions have no
   * Kortix session row, so `GET .../turn` can never answer for them: the
   * session panel's and turn card's child fallbacks (`session-layout.tsx`,
   * `resolveLastTurnWorking`), and `SubAgentStatusBanner`'s retry countdown.
   * Kortix-session surfaces read the working projection, whose `stream` input
   * this slot feeds — the repair still reaches them, one hop later, with
   * provenance.
   */
  const reconcileMissingBusySessions = useRef((nextStatuses: Record<string, SessionStatus>) => {
    const previousStatuses = useSyncStore.getState().sessionStatus;
    for (const [sessionID, status] of Object.entries(previousStatuses)) {
      if (status?.type !== 'idle' && !nextStatuses[sessionID]) {
        // A brand-new session whose first prompt the server hasn't registered
        // yet is locally-busy but absent from the status snapshot. Don't idle
        // it: markSessionIdleLocally → clearOptimisticMessages would wipe the
        // optimistic user bubble before the real message.updated arrives (the
        // "message sent from home vanishes / blinks" bug). Real status/idle
        // events reconcile it once the server catches up.
        if (useSyncStore.getState().hasOptimisticMessages(sessionID)) continue;
        markSessionIdleLocally.current(sessionID);
      }
    }
  });

  return {
    normalizeLspPath,
    normalizeDiagnosticPaths,
    fetchLspDiagnosticsDebounced,
    markSessionAbortedLocally,
    markSessionIdleLocally,
    reconcileMissingBusySessions,
  };
}
