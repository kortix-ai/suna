/**
 * How a session's FIRST prompt is drawn, from the Send press to the moment the
 * server accepts it.
 *
 * Three surfaces paint that one message in a new session's first seconds: the
 * boot shell's `OptimisticTurn`, the chat's stand-in for it, and the real turn
 * once the runtime echoes it. They used to disagree — the shell drew the bubble
 * in full colour with a waiting row under it, and the chat took over by muting
 * the text as "queued" and dropping the row on any idle frame. The message the
 * user had just sent read as disabled, then as nothing at all, while the server
 * was already running it.
 *
 * One look, one row, from Send until acceptance. These are the two decisions
 * that keeps; the rendering itself stays in `session-chat.tsx`.
 */

/**
 * Is this pending user bubble drawn in the muted "queued" tone?
 *
 * Muted means "the agent has not reached this message". That is true for a
 * prompt queued behind a running turn, and for one a Stop held before it ran.
 * It is not true for the first prompt of a session: nothing is running ahead of
 * it, and the boot shell already drew it in full colour.
 */
export function pendingBubbleIsMuted(input: {
  /** This bubble is the session's first prompt (its inbox row, or the turn a
   *  claim put it on screen under). */
  firstPrompt: boolean;
  /** The bubble is unanswered and the server still holds the prompt. */
  pending: boolean;
  /** A Stop ended the turn before a step opened under this message. */
  interruptedBeforeRun: boolean;
}): boolean {
  if (input.interruptedBeforeRun) return true;
  if (!input.pending) return false;
  return !input.firstPrompt;
}

/**
 * Is the server still holding the first prompt FOR US?
 *
 * Live means "this prompt is on its way to the runtime": queued, waiting its
 * turn, or being delivered. Two rows are not live, and neither should draw a
 * waiting row:
 * - `failed` — delivery gave up. The failure is the status.
 * - `reason: 'held'` — a Stop during boot held it (`holdSessionPrompts`). The
 *   row stays `queued`, the composer shows Send, and nothing is running.
 *   `projectQueueRows` counts held rows by the same pair.
 */
export function firstPromptRowIsLive(
  row: { state: string; reason: string | null } | undefined,
): boolean {
  if (!row) return false;
  if (row.state === 'failed') return false;
  return row.reason !== 'held';
}

/**
 * Does the chat's first-prompt stand-in draw the waiting row?
 *
 * The same rule the boot shell uses, so the row does not blink out at the
 * crossfade: a first prompt the server holds is being worked on, whatever the
 * working projection has read so far. The projection still answers for every
 * frame after the row drains and before a turn appears (`lastTurnWorking`).
 *
 * A transcript that already has a turn draws its own row (`resolveBusyRow`),
 * and two waiting rows would be a lie about how much is running.
 */
export function firstPromptStandInBusy(input: {
  /** The transcript has at least one turn on screen. */
  transcriptHasTurns: boolean;
  /** An inbox row for the first prompt exists and has not failed. */
  firstPromptLive: boolean;
  /** The delay-hidden busy value the Stop button reads. */
  lastTurnWorking: boolean;
}): boolean {
  if (input.transcriptHasTurns) return false;
  return input.firstPromptLive || input.lastTurnWorking;
}
