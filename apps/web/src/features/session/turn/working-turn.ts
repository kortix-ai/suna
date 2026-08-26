/**
 * WHICH turn is the one the agent is working on.
 *
 * It used to be "the last one", by definition — and that was true until a
 * prompt could be queued mid-turn. Now the transcript can end with one or
 * more user messages the agent has not reached yet: OpenCode persists a
 * queued prompt as a user message the moment the server forwards it, and
 * the agent picks it up between steps, minutes later. During that window
 * the LAST turn is a bubble with nothing under it, and the turn that is
 * actually streaming (with its "Thinking" burst, its tool calls) sits one
 * or more turns UP. Pinning the working indicator to the last turn painted
 * "Figuring out what's next…" under a message nobody had started, and left
 * the live turn looking settled.
 *
 * The rule, in order:
 *
 *  1. The newest turn that has any assistant content. If its newest
 *     assistant message is still open (no `time.completed`), that is the
 *     working turn — the agent is visibly writing there. Older turns with an
 *     open assistant message are husks (a box that died mid-turn); the
 *     newest turn with content outranks them.
 *  2. Otherwise every turn after it is a PENDING turn — a user message with
 *     no answer yet. The server's own answer (`WorkingProjection.turnId`,
 *     the wire id of the prompt that opened the running turn, or this tab's
 *     receipt) picks between "still on the previous turn, between two
 *     steps" and "a fresh send that opened this turn" when it names one of
 *     them.
 *  3. Otherwise the NEWEST pending turn. OpenCode parents the next step to
 *     the latest user message and answers every queued message before it in
 *     that same step — so that is where the shimmer lands, and the ones
 *     before it are already taken (bright, no indicator of their own).
 *  4. No pending turns: the newest turn with content (its step just ended;
 *     the next one has not opened yet — the indicator stays put instead of
 *     flickering).
 *
 * `null` only for an empty transcript.
 */

interface TurnLike {
  userMessage: { info: { id: string } };
  assistantMessages: ReadonlyArray<{ info: { time?: { completed?: number } | object } }>;
}

const completedAt = (info: { time?: object }): number | undefined =>
  (info.time as { completed?: number } | undefined)?.completed;

export interface WorkingTurnResolution {
  /** The user message id of the working turn, or null for no turns. */
  workingTurnId: string | null;
  /** User message ids of the turns AFTER the working one that have no
   *  assistant content — prompts the agent has not reached. */
  pendingTurnIds: string[];
}

export function resolveWorkingTurn(input: {
  turns: ReadonlyArray<TurnLike>;
  /** `WorkingProjection.turnId` — the server's or the receipt's answer for
   *  which prompt opened the running turn. Often null (triggers, `/` commands). */
  hintMessageId: string | null | undefined;
  /**
   * User message ids whose prompt the SERVER still holds in its inbox —
   * `queued`, `waiting`, or `delivering`. Each is a turn the agent provably has
   * not reached, so none of them may be chosen as the working turn by the
   * transcript-only fallback below.
   *
   * Optional: a caller with no inbox (a sub-session, a test) gets the old
   * transcript-only answer.
   */
  unrunTurnIds?: ReadonlySet<string>;
}): WorkingTurnResolution {
  const { turns } = input;
  if (turns.length === 0) return { workingTurnId: null, pendingTurnIds: [] };

  let newestWithContent = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].assistantMessages.length > 0) {
      newestWithContent = i;
      break;
    }
  }

  const pendingIds = turns.slice(newestWithContent + 1).map((t) => t.userMessage.info.id);

  const pick = (index: number): WorkingTurnResolution => ({
    workingTurnId: turns[index].userMessage.info.id,
    pendingTurnIds: turns.slice(index + 1).map((t) => t.userMessage.info.id),
  });

  if (newestWithContent >= 0) {
    const t = turns[newestWithContent];
    const newest = t.assistantMessages[t.assistantMessages.length - 1];
    if (!completedAt(newest.info)) return pick(newestWithContent);
  }

  const hint = input.hintMessageId ?? null;
  if (hint) {
    if (newestWithContent >= 0 && turns[newestWithContent].userMessage.info.id === hint) {
      return pick(newestWithContent);
    }
    const idx = pendingIds.indexOf(hint);
    if (idx >= 0) return pick(newestWithContent + 1 + idx);
  }

  // Rule 3, with the one fact the transcript cannot hold: the SERVER still has
  // this prompt in its inbox, so the agent provably has not reached it.
  //
  // Picking the newest pending turn is right when the transcript is all we
  // have — OpenCode parents its next step to the latest user message. It is
  // WRONG for a prompt the control plane is still holding: `GET .../prompts`
  // lists it `queued` / `waiting (older_prompt_pending)` / `delivering`, which
  // is the server saying, in as many words, that it has not run yet.
  //
  // MEASURED, local stack 2026-08-26 (session 65216cc6): two sends 700ms
  // apart, the first not yet streaming. `GET .../prompts` reported the second
  // `queued`, then `waiting: older_prompt_pending`, then `delivering` — while
  // the transcript rendered it at full opacity with no "Queued" label, because
  // it had been made the WORKING turn here. The working projection's hint is
  // null in that window (the inbox, not the ledger, is what decides `working`
  // right after a send — `projectWorking`), so nothing else could correct it.
  //
  // Skipping the held ones only moves the shimmer; it never hides a turn. When
  // every pending turn is held, the working indicator falls back to the newest
  // turn with content (rule 4) and all of them read as queued — which is
  // exactly the state the server is describing.
  const unrun = input.unrunTurnIds;
  if (pendingIds.length > 0) {
    for (let i = turns.length - 1; i > newestWithContent; i--) {
      if (!unrun?.has(turns[i].userMessage.info.id)) return pick(i);
    }
  }
  return pick(newestWithContent);
}
