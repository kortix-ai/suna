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

  if (pendingIds.length > 0) return pick(turns.length - 1);
  return pick(newestWithContent);
}
