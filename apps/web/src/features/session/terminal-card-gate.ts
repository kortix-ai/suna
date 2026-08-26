/**
 * May a terminal card be painted for this session?
 *
 * The `/start` envelope already publishes the answer. `retriable` says the
 * server will re-attempt on its own; `boot.actively_starting` says a provider
 * operation is running right now. Neither had a reader on the two most
 * reachable terminal branches, so a wake cooldown — which the server answers as
 * `{stage:'starting', retriable:true}` — rendered "Couldn't start session".
 *
 * `retriable: null` means the owner has not answered yet. Absence is not
 * negation: withhold the card rather than assume the worst.
 */
export function shouldPaintTerminalCard(input: {
  hasFailure: boolean;
  retriable: boolean | null;
  activelyStarting: boolean;
}): boolean {
  if (!input.hasFailure) return false;
  if (input.activelyStarting) return false;
  if (input.retriable !== false) return false;
  return true;
}
