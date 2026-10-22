/**
 * "Is this session working?" when the SERVER answers it (R5.2/R5.3).
 *
 * The session stream's `kortix.control.turn` frame carries the server's own
 * verdict (`working`): a live turn the runtime has not reported ended, or a
 * prompt on its way to the runtime. The server decides it once for every
 * client, so this tab adds only what the server cannot know yet: its own send
 * and its own Stop, each for a short, bounded window.
 *
 * `projectWorking` (`./working`) stays for the fallback path, when the stream
 * is down and the tab polls `GET .../turn` instead.
 */

import type { WorkingProjection, SendReceipt, AbortReceipt } from './working';
import { OPTIMISTIC_ABORT_MAX_MS, OPTIMISTIC_RECEIPT_MAX_MS } from './working';

/** The server's verdict, as `kortix.control.turn` carries it. */
export interface SessionWorkingVerdict {
  state: 'working' | 'idle';
  since: string | null;
  turn_token: string | null;
  pending_delivery: boolean;
}

/**
 * How long after the server ACCEPTED a send (or a Stop) a frame that does not
 * reflect it yet is still believed to predate it. A frame computed before the
 * write can land after the POST answered; past this window it cannot.
 */
export const SERVER_WORKING_SEND_GRACE_MS = 2_000;

export interface ServerWorkingInput {
  working: SessionWorkingVerdict;
  /** This tab's clock when the frame arrived. */
  atMs: number;
  optimistic: SendReceipt | null;
  abort: AbortReceipt | null;
  nowMs: number;
}

function predates(atMs: number, settledAtMs: number | null | undefined): boolean {
  return settledAtMs == null || atMs < settledAtMs + SERVER_WORKING_SEND_GRACE_MS;
}

export function projectServerWorking(input: ServerWorkingInput): WorkingProjection {
  const { working, atMs, optimistic, abort, nowMs } = input;
  const serverWorking = working.state === 'working';
  const sinceMs = working.since ? Date.parse(working.since) : Number.NaN;

  if (
    abort &&
    serverWorking &&
    nowMs - abort.atMs < OPTIMISTIC_ABORT_MAX_MS &&
    predates(atMs, abort.settledAtMs)
  ) {
    return {
      state: 'idle',
      source: 'optimistic',
      turnId: null,
      since: abort.atMs,
      serverOpenTurnToken: working.pending_delivery ? null : working.turn_token,
    };
  }
  if (
    optimistic &&
    !serverWorking &&
    nowMs - optimistic.atMs < OPTIMISTIC_RECEIPT_MAX_MS &&
    predates(atMs, optimistic.acceptedAtMs)
  ) {
    return {
      state: 'working',
      source: 'optimistic',
      turnId: optimistic.turnId === undefined ? optimistic.messageId : optimistic.turnId,
      since: optimistic.atMs,
      serverOpenTurnToken: null,
    };
  }
  return {
    state: working.state,
    ...(serverWorking && working.pending_delivery ? { pendingDelivery: true as const } : {}),
    source: 'server',
    turnId: working.turn_token,
    since: Number.isFinite(sinceMs) ? sinceMs : atMs,
    serverOpenTurnToken: serverWorking && !working.pending_delivery ? working.turn_token : null,
  };
}

/** When a receipt stops deciding, so a host re-projects then. Null: never. */
export function serverWorkingExpiryAtMs(input: {
  optimistic: SendReceipt | null;
  abort: AbortReceipt | null;
}): number | null {
  const deadlines: number[] = [];
  const { optimistic, abort } = input;
  if (optimistic) {
    deadlines.push(optimistic.atMs + OPTIMISTIC_RECEIPT_MAX_MS);
    if (optimistic.acceptedAtMs != null) deadlines.push(optimistic.acceptedAtMs + SERVER_WORKING_SEND_GRACE_MS);
  }
  if (abort) {
    deadlines.push(abort.atMs + OPTIMISTIC_ABORT_MAX_MS);
    if (abort.settledAtMs != null) deadlines.push(abort.settledAtMs + SERVER_WORKING_SEND_GRACE_MS);
  }
  return deadlines.length > 0 ? Math.min(...deadlines) : null;
}
