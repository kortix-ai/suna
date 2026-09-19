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

/**
 * What a retrying assistant reply holds, given the `/turn` read behind it.
 *
 * During a provider retry the transcript is the only proof the turn is open,
 * and the server's open turn token confirms the turn was not finalized. The
 * two consumers need different reads of that token:
 *
 * - `holdsStop` feeds the Stop button and the busy row. It needs a FRESH read
 *   (`serverOpenTurnFresh`). The token is age-free, so a tab whose `/turn`
 *   reads stopped landing kept Stop on screen for the life of the page.
 * - `blocksCommand` feeds the `/` command refusal. It keeps the age-free token:
 *   a command goes straight to the runtime with no admission gate, and a stale
 *   read is no evidence that the retrying turn ended.
 */
export function retryingAssistantGates(input: {
  retryingAssistantTurn: boolean;
  serverOpenTurnToken: string | null;
  serverOpenTurnFresh: boolean | undefined;
}): { holdsStop: boolean; blocksCommand: boolean } {
  return {
    holdsStop: input.retryingAssistantTurn && input.serverOpenTurnFresh === true,
    blocksCommand: input.retryingAssistantTurn && input.serverOpenTurnToken !== null,
  };
}
