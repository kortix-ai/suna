import { extractGatewayErrorDetails } from '@/ui';
import type { SessionLogTurn } from '@kortix/sdk';

type PersistedFailure = {
  message_id?: string | null;
  error?: { message?: string | null } | null;
};

/** The sentence a turn-ledger failure shows: the gateway's, not its `429: {…}` body. */
export function persistedFailureText(error: PersistedFailure['error']): string | undefined {
  const raw = error?.message;
  if (!raw) return undefined;
  return extractGatewayErrorDetails(raw)?.message || raw;
}

/**
 * Is a turn-ledger failure already on screen as a transcript turn? A ledger
 * row carries no message id for some channel turns, so it repeats a turn that
 * shows the same error.
 */
export function failureShownByTurn(
  failure: PersistedFailure,
  turns: ReadonlyArray<Pick<SessionLogTurn, 'id' | 'error'>>,
): boolean {
  if (turns.some((turn) => turn.id === failure.message_id)) return true;
  if (failure.message_id) return false;
  const text = persistedFailureText(failure.error);
  return Boolean(text) && turns.some((turn) => turn.error?.message === text);
}

/**
 * Did a later turn replace a ledger failure that is not in the transcript? An
 * edit rewinds the failed message and sends a new one, and the ledger still
 * lists the old failure, so the row stayed under the new turn. A failure with
 * no transcript turn sent after it (an admission rejection) still shows.
 */
export function failureSupersededByTurn(
  failure: PersistedFailure & { ended_at?: string | null },
  turns: ReadonlyArray<Pick<SessionLogTurn, 'user'>>,
): boolean {
  const endedMs = failure.ended_at ? Date.parse(failure.ended_at) : Number.NaN;
  if (!Number.isFinite(endedMs)) return false;
  return turns.some((turn) => {
    const created = turn.user.created_at ? Date.parse(turn.user.created_at) : Number.NaN;
    return Number.isFinite(created) && created > endedMs;
  });
}
