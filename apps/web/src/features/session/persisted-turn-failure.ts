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
