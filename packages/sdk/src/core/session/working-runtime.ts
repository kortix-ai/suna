import type { SessionTurn } from '../rest/projects-client/sessions';
import type { WorkingServerInput, WorkingStreamInput } from './working';

import { instant } from './working-time';

/**
 * Whether the runtime has already finished this turn.
 *
 * "Newer read wins" is the rule this replaces, and it is wrong here, because
 * the two observers do not learn the same fact at the same time. The idle
 * frame comes straight off the runtime over SSE. The ledger row is closed by
 * a SEPARATE daemon relay (`POST .../turn-stream` `kind:"end"`) — so a `/turn`
 * read ISSUED after the frame is still ABOUT a turn the frame already ended.
 *
 * MEASURED, local stack 2026-08-21, one ordinary composer turn: the idle
 * frame reached the tab at 00:03:59.964, the refetch that frame itself
 * triggers landed at 00:04:00.150 stamped 44ms later and still reported the
 * turn `active`, and the ledger did not record `ended_at` until 00:04:15.132
 * — the relay for that turn never arrived and a reconciliation sweep closed
 * it 15.1s late. The composer's Stop button and the turn's shimmer came back
 * 186ms after they left and stayed for fifteen seconds, with the finished
 * reply already on screen. Even in the healthy case the relay lands ~200ms
 * after the frame, which is still inside the window its own refetch lands in.
 *
 * `started_at` is what separates the two turns the rule has to tell apart: a
 * turn that began BEFORE the frame is the turn that frame ended, and a turn
 * that began after it is a NEW one the frame knows nothing about — a queued
 * prompt draining, a trigger firing, a second device sending. That one keeps
 * the ledger's full authority, with no delay and no window.
 *
 * A row with no start instant (a legacy `activeTurn`) cannot be ranked
 * against the frame at all, and inventing an order there would hide a live
 * turn. The ledger keeps it.
 */
export function endedByRuntime(
  candidate: SessionTurn,
  idleFrame: WorkingStreamInput | null,
  server: WorkingServerInput | null,
): boolean {
  if (!idleFrame) return false;
  const startedAt = instant(candidate.started_at);
  if (startedAt === null || startedAt >= idleFrame.atMs) return false;
  const lastEnded = server?.lastEnded;
  const endedAt = instant(lastEnded?.ended_at);
  if (
    lastEnded &&
    endedAt !== null &&
    Math.abs(endedAt - idleFrame.atMs) <= 1_000 &&
    lastEnded.turn_token !== candidate.turn_token
  )
    return false;
  return true;
}
