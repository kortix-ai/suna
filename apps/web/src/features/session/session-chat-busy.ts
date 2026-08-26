/**
 * Is the session busy, for every surface a user can act on — the Stop button,
 * the turn shimmer, the question/permission composer locks, and the send
 * anchoring.
 *
 * `hasRetryingAssistant` is a separate term rather than a refinement of
 * `isServerBusy` because during a provider backoff the runtime's own status
 * frame is stale by construction: OpenCode emits `session.error` only AFTER its
 * internal retry ladder is exhausted, so no later `busy` or `retry` frame
 * follows to correct the slot. The transcript is the only observer that still
 * proves the turn is open.
 */
export function resolveEffectiveBusy(input: {
  isServerBusy: boolean;
  isOptimisticCompacting: boolean;
  hasRetryingAssistant: boolean;
}): boolean {
  return input.isServerBusy || input.isOptimisticCompacting || input.hasRetryingAssistant;
}
