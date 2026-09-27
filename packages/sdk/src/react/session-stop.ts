/**
 * The Stop primitives shared by `useSessionSend().stop()` and
 * `useSession().cancel()`.
 *
 * A leaf module on purpose: `use-session-send.ts` imports FROM `use-session.ts`,
 * so `use-session.ts` reaches these here instead of importing that file back.
 * The public names are re-exported from `use-session-send.ts`.
 */
import type { Message } from '@opencode-ai/sdk/v2/client';
import { useSessionWorkingStore } from '../browser/stores/session-working-store';
import { useSyncStore } from '../browser/stores/sync-store';
import type { MessageError } from '../browser/stores/sync-store/types';
import { holdSessionPrompts } from '../core/rest/projects-client';
import {
  abortInFlightDeliveries,
  awaitAbortSettlement,
  type AbortSettlement,
} from './use-opencode-sessions';

/**
 * Patch an "aborted" error onto the last assistant message that doesn't
 * already have one, so an "Interrupted" label can render instantly instead of
 * waiting for the SSE `session.error` round-trip. Call this immediately
 * before issuing the actual abort request.
 *
 * This deliberately writes NO status frame. It used to fabricate an idle
 * frame here, and `projectWorking` cannot tell a fabricated frame from a real
 * one — the fabrication outranked the control plane's own `/turn` answer for
 * the whole abort round-trip. The same intent now travels as an
 * `AbortReceipt` (`noteAbortReceipt`), which carries provenance and a bound
 * (`OPTIMISTIC_ABORT_MAX_MS`). The transcript-side patch below stays: it is a
 * designed optimistic echo about a MESSAGE, not a status.
 */
export function applyOptimisticAbort(sessionId: string): void {
  const store = useSyncStore.getState();
  const msgs = store.messages[sessionId];
  if (!msgs) return;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i];
    if (msg.role !== 'assistant') continue;
    // STOP at the newest assistant message, whatever state it is in. The abort
    // belongs to the turn the user just stopped, and that is the last one.
    //
    // This used to be `msg.role === 'assistant' && !msg.error`, which SKIPPED
    // an already-errored newest message and kept walking — so stopping a turn
    // whose assistant message already carried an error (an earlier interrupt,
    // or a turn that failed) stamped "Interrupted" onto a COMPLETED turn
    // further up the transcript. The marker appeared detached, above the turn
    // it belonged to, instead of at the end of it.
    if (msg.error || msg.time?.completed != null) break;
    {
      // Typed as the wider `MessageError` (not just the literal shape below)
      // so the assertion further down overlaps with `AssistantMessage.error`'s
      // real union — see `MessageError` in the sync store.
      // `reason: 'user'` — a REAL user stop, as opposed to
      // `markSessionAbortedLocally`'s `'runtime-disposed'`. Read via the
      // SDK's `abortErrorReason` (`core/http/abort-error.ts`); apps/web
      // renders this reason as the "Interrupted" checkpoint row.
      const error: MessageError = {
        name: 'AbortError',
        data: { message: 'The operation was aborted.', reason: 'user' },
      };
      // `error`'s shape (`SyntheticAbortError`) isn't part of the SDK's
      // `AssistantMessage.error` union — see `MessageError` in the sync
      // store. TS flags the direct assertion as an insufficient-overlap
      // mistake because it narrows the literal's `error` field back down to
      // `SyntheticAbortError`; route through `unknown` as TS itself suggests.
      const patched = { ...msg, error } as unknown as Message;
      store.upsertMessage(sessionId, patched);
      break;
    }
  }
}

/**
 * How long `stopWithReceipt` waits for the server-side prompt-inbox hold
 * (below) before issuing the abort anyway. Mirrors apps/web's
 * `STOP_HOLD_DEADLINE_MS` (`session-chat.tsx`) — kept as the same value for
 * the same reason: the hold call carries no client timeout of its own, and a
 * stalled socket must not delay the abort by more than a bounded amount.
 */
export const STOP_HOLD_DEADLINE_MS = 1_500;

export interface StopWithReceiptOptions {
  workingSessionId?: string;
  /**
   * Kortix project id. Required to hold the session's server-side prompt
   * inbox before the abort goes out (see below). Omit only for a host with
   * no prompt inbox for this session — the hold is skipped entirely, matching
   * this function's behavior before the inbox existed.
   */
  projectId?: string;
  /**
   * Kortix session id whose inbox to hold. The inbox is keyed by the same
   * Kortix session `GET .../turn` answers about, so this defaults to
   * `workingSessionId` (or `sessionId`), never to the OpenCode runtime id.
   */
  inboxSessionId?: string;
  /** Injectable, defaults to `holdSessionPrompts`. Lets a host or a test
   * substitute its own inbox client. */
  holdInboxPrompts?: (projectId: string, sessionId: string, held: boolean) => Promise<unknown>;
  /** Default {@link STOP_HOLD_DEADLINE_MS}. */
  holdDeadlineMs?: number;
}

/**
 * Stop, with this tab's own abort receipt filed around it.
 *
 * The mirror of `sendWithReceipt`, for the mirror-image failure: the cancel
 * needs a round trip through the control plane and the daemon (~1.6s measured)
 * before turn authority is released, so every `/turn` read issued inside that
 * window still reports the doomed turn — including the one the optimistic idle
 * frame itself triggers. Without the receipt the composer swapped Send back to
 * Stop about 120ms after the click and stayed there for the whole abort. See
 * `AbortReceipt`.
 *
 * It also holds the session's server-side prompt inbox BEFORE issuing the
 * abort, the same pairing apps/web's `handleStop` does by hand
 * (`session-chat.tsx`). A prompt sent mid-turn is forwarded into OpenCode's
 * live queue the moment it is admitted, so at stop time the inbox can hold a
 * row OpenCode already has. The abort drops OpenCode's in-memory queue; the
 * reaper then sees that row unanswered and redelivers it — due now — unless
 * the hold already marked it stop-paused. AWAITED (bounded by
 * `holdDeadlineMs`) so the ordering is a fact, not a race: without it, Stop
 * aborts the turn and is followed a beat later by exactly the message the
 * user pressed Stop to get ahead of. A failed hold is caught, never
 * rethrown — it must not cost the user their abort — and skipped entirely
 * when no `projectId` is given.
 *
 * `runAbort` is taken as a callback (normally `() =>
 * abortMutation.mutateAsync(sessionId)`) so the pairing is testable without
 * rendering a hook — the same shape `awaitAbortSettlement` already uses.
 */
export async function stopWithReceipt(
  sessionId: string,
  runAbort: () => Promise<void>,
  options: StopWithReceiptOptions = {},
): Promise<AbortSettlement> {
  const workingSessionId = options.workingSessionId ?? sessionId;
  const store = useSessionWorkingStore.getState();
  // Nothing is coming for ANY send once the user has pressed Stop — the one
  // place the unnamed clear is the correct one.
  store.clearSendReceipt(workingSessionId);
  store.noteAbortReceipt(workingSessionId, Date.now());
  applyOptimisticAbort(sessionId);
  // T9: stop a delivery still retrying its boot/wake backoff BEFORE the abort
  // request goes out, so it can never land after this point.
  abortInFlightDeliveries(sessionId);

  if (options.projectId) {
    const inboxSessionId = options.inboxSessionId ?? workingSessionId;
    const hold = options.holdInboxPrompts ?? holdSessionPrompts;
    const deadlineMs = options.holdDeadlineMs ?? STOP_HOLD_DEADLINE_MS;
    await Promise.race([
      hold(options.projectId, inboxSessionId, true).catch((error) => {
        // Caught, never rethrown — see the doc comment above.
        console.warn('[useSessionSend] failed to hold the prompt inbox on stop', error);
      }),
      new Promise((resolve) => setTimeout(resolve, deadlineMs)),
    ]);
  }

  const settlement = awaitAbortSettlement(runAbort);
  // `awaitAbortSettlement` never rejects — it resolves with how the abort ended:
  // acknowledged, failed, or TIMED OUT. Only the first two are answers.
  //
  // `settledAtMs` means "the instant from which a server read can see this
  // abort's effect", and a timeout is precisely the case where nobody said that.
  // Settling on it wrote 5s of clock into an evidence field: `abortFloor` in
  // `projectWorking` dropped from Infinity to a real instant, the next `/turn`
  // read — issued while the cancel was still in flight, `abortOpenCodeSession`
  // retries twice — cleared it, and the Stop button came back mid-cancel. The
  // receipt is left unsettled instead and `OPTIMISTIC_ABORT_MAX_MS` bounds it,
  // which is the bound that exists for exactly this case.
  void settlement.then((result) => {
    if (result?.status === 'timed-out') return;
    useSessionWorkingStore.getState().settleAbortReceipt(workingSessionId, Date.now());
  });
  return settlement;
}

export interface CancelSessionTurnArgs {
  /** Kortix project id — addresses the session's prompt inbox. */
  projectId: string;
  /** Kortix session id — the key `GET .../turn`, the receipts and the inbox use. */
  sessionId: string;
  /** OpenCode runtime session id the abort goes to. */
  runtimeSessionId: string;
  /** False until the session's runtime is bound; then nothing can be aborted. */
  runtimeActionReady: boolean;
  runAbort: () => Promise<void>;
  /** Test seam; defaults to `holdSessionPrompts` (inside `stopWithReceipt`). */
  holdInboxPrompts?: (projectId: string, sessionId: string, held: boolean) => Promise<unknown>;
}

/**
 * The body of `useSession().cancel()`: the same Stop as
 * `useSessionSend().stop()`.
 *
 * `stopWithReceipt` files the abort receipt, cancels a delivery still in its
 * boot backoff, holds the session's prompt inbox (bounded), and only then
 * aborts. Without the hold, a prompt the user queued during the turn is
 * redelivered the moment the abort drops the runtime's queue, and Stop starts
 * the next turn instead of stopping.
 *
 * Internal: `useSession` is the public surface.
 */
export function cancelSessionTurn(args: CancelSessionTurnArgs): Promise<AbortSettlement> {
  if (!args.runtimeActionReady) return Promise.resolve({ status: 'skipped' });
  return stopWithReceipt(args.runtimeSessionId, args.runAbort, {
    workingSessionId: args.sessionId,
    inboxSessionId: args.sessionId,
    ...(args.projectId ? { projectId: args.projectId } : {}),
    ...(args.holdInboxPrompts ? { holdInboxPrompts: args.holdInboxPrompts } : {}),
  });
}
