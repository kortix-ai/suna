'use client';

import { useEffect, useRef } from 'react';

import type { ServerTurnErrorRow } from '../browser/stores/sync-store';
import { useSyncStore } from '../browser/stores/sync-store';
import {
  type SessionTurnHistoryEntry,
  listSessionTurns,
} from '../core/rest/projects-client/sessions';

/**
 * The durable half of "any turn error is registered and rendered".
 *
 * A turn that fails before generation starts — `ModelNotFound` ~2ms after the
 * prompt, a runtime that never accepted it, a box that went away — leaves the
 * runtime's own transcript holding the user message and NOTHING else. The
 * failure exists only as a live `session.error` frame, which reaches exactly
 * one tab: the one that was open at the time. Reload in another browser and
 * the turn reads as a prompt nobody answered.
 *
 * The control plane retains one settled row per turn WITH its error, keyed by
 * the user message it answered (`GET .../turns`). This hook reads that and
 * hands it to the store, which renders it through the same in-place mechanism
 * the live frame uses — so the two are idempotent and the user sees one error
 * block either way.
 *
 * COST: one request per mount, plus one per turn end. Never a poll — `/turn`
 * (`useSessionWorking`) is already the thing watching liveness, and this only
 * needs to run when its answer changes.
 */

/** How many turns back a mount looks. Deep enough to cover a long session's
 *  visible transcript, bounded so one mount is never a scan of a year of
 *  history. The server clamps its own ceiling at 200. */
export const TURN_HISTORY_LIMIT = 50;

/**
 * Reduce the server's turn history to the rows the transcript can render:
 * a failure, and the prompt it belongs under.
 *
 * `/turns` is newest first, so the FIRST row for a given `message_id` wins —
 * a prompt the server redelivered can settle more than once under one wire id,
 * and the freshest ending is the true one.
 */
export function serverTurnErrorRows(
  turns: readonly SessionTurnHistoryEntry[],
): ServerTurnErrorRow[] {
  const rows: ServerTurnErrorRow[] = [];
  const seen = new Set<string>();
  for (const turn of turns) {
    const messageId = turn.message_id;
    const error = turn.error;
    if (!messageId || !error?.message) continue;
    if (seen.has(messageId)) continue;
    seen.add(messageId);
    rows.push({ messageId, error: { name: error.name, message: error.message } });
  }
  return rows;
}

/** Read the history when a turn ENDS — the falling edge, never the rising one
 *  and never a tick in between. */
export function shouldRefetchTurnHistory(input: {
  wasWorking: boolean;
  isWorking: boolean;
}): boolean {
  return input.wasWorking && !input.isWorking;
}

export interface UseDurableTurnErrorsOptions {
  /** Off while the host has no session to read (an empty route param, a
   *  disabled chat engine). */
  enabled?: boolean;
  /** Is a turn running right now? Only its falling edge triggers a read. */
  working?: boolean;
  limit?: number;
}

/**
 * @param projectId   Kortix project — what `/turns` is addressed by.
 * @param sessionId   Kortix session — likewise.
 * @param runtimeSessionId  The OPENCODE wire session id the transcript is
 *   keyed by in the sync store. Two ids, deliberately: passing the wrong one
 *   would write another session's transcript, so it is explicit.
 */
export function useDurableTurnErrors(
  projectId: string,
  sessionId: string,
  runtimeSessionId: string | null,
  options: UseDurableTurnErrorsOptions = {},
): void {
  const { enabled = true, working = false, limit = TURN_HISTORY_LIMIT } = options;
  const active = enabled && !!projectId && !!sessionId && !!runtimeSessionId;

  /** The last answer from the server, kept so it can be re-applied when the
   *  transcript changes. The read and the apply are deliberately decoupled: a
   *  row for a prompt this transcript has not loaded yet is skipped, and the
   *  page that loads it later must still get its error. */
  const rowsRef = useRef<ServerTurnErrorRow[]>([]);
  const messages = useSyncStore((s) => (runtimeSessionId ? s.messages[runtimeSessionId] : undefined));

  const applyRows = () => {
    if (!runtimeSessionId || rowsRef.current.length === 0) return;
    useSyncStore.getState().applyServerTurnErrors(runtimeSessionId, rowsRef.current);
  };

  const readHistory = async () => {
    if (!active) return;
    try {
      const turns = await listSessionTurns(projectId, sessionId, { limit });
      rowsRef.current = serverTurnErrorRows(turns);
      applyRows();
    } catch {
      // A failed history read is not a failed transcript. The live frame still
      // renders for the tab that sees it; this one simply learned nothing.
    }
  };

  // One read per mounted session.
  useEffect(() => {
    if (!active) {
      rowsRef.current = [];
      return;
    }
    void readHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, projectId, sessionId, runtimeSessionId, limit]);

  // One read per turn end — the moment a fresh failure becomes durable.
  const wasWorkingRef = useRef(working);
  useEffect(() => {
    const wasWorking = wasWorkingRef.current;
    wasWorkingRef.current = working;
    if (!active) return;
    if (!shouldRefetchTurnHistory({ wasWorking, isWorking: working })) return;
    void readHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, working]);

  // Re-apply whenever the transcript itself moves: the rows may have arrived
  // before the messages they belong to (a cold mount reads both at once), and
  // `loadOlder` brings prompts into view that were beyond the first page.
  // Applying is a no-op when nothing changes — the store returns the same
  // state object, so this costs no render.
  useEffect(() => {
    applyRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, runtimeSessionId]);
}
