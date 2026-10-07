import { extractGatewayErrorDetails, getTurnError, type Turn } from '@/ui';

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
export function failureShownByTurn(failure: PersistedFailure, turns: Turn[]): boolean {
  if (turns.some((turn) => turn.userMessage.info.id === failure.message_id)) return true;
  if (failure.message_id) return false;
  const text = persistedFailureText(failure.error);
  return Boolean(text) && turns.some((turn) => getTurnError(turn) === text);
}

/**
 * Did a later turn replace a ledger failure that is not in the transcript? An
 * edit rewinds the failed message and sends a new one, and the ledger still
 * lists the old failure, so the row stayed under the new turn. A failure with
 * no transcript turn sent after it (an admission rejection) still shows.
 */
export function failureSupersededByTurn(
  failure: PersistedFailure & { ended_at?: string | null },
  turns: Turn[],
): boolean {
  const endedMs = failure.ended_at ? Date.parse(failure.ended_at) : Number.NaN;
  if (!Number.isFinite(endedMs)) return false;
  return turns.some((turn) => {
    const created = turn.userMessage.info.time?.created;
    return typeof created === 'number' && created > endedMs;
  });
}
