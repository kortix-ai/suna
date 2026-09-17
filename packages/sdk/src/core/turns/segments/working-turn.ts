import { showTurnBusyIndicator } from './turn-busy-visibility';

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
 *  1. The working projection names a turn. This is the server's current turn
 *     or this tab's fresh send receipt. It outranks incomplete transcript
 *     metadata because message completion can arrive one frame late.
 *  2. The newest turn that has any assistant content. If its newest
 *     assistant message is still open (no `time.completed`), that is the
 *     working turn — the agent is visibly writing there. Older turns with an
 *     open assistant message are husks (a box that died mid-turn); the
 *     newest turn with content outranks them.
 *  3. Otherwise the NEWEST pending turn. OpenCode parents the next step to
 *     the latest user message and answers every queued message before it in
 *     that same step — so that is where the shimmer lands, and the ones
 *     before it are already taken (bright, no indicator of their own).
 *  4. No pending turns: the newest turn with content (its step just ended;
 *     the next one has not opened yet — the indicator stays put instead of
 *     flickering).
 *
 * `null` for an empty transcript — and for a transcript with no assistant
 * content at all whose every prompt the server is still holding: there is no
 * turn the agent is on, only pending ones.
 */

interface TurnLike {
  userMessage: { info: { id: string } };
  assistantMessages: ReadonlyArray<{
    info: { time?: { completed?: number } | object; error?: unknown };
  }>;
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

/** A completed assistant message can be an intermediate step of an active
 * turn. The working turn yields its row only on evidence: pending delivery, or
 * a projection naming a different active turn. A null active id is a gap
 * between readings; suppressing on it moved Thinking below queued bubbles. */
export function shouldSuppressWorkingTurnBusy(input: {
  hasPendingTurns: boolean;
  newestAssistantCompleted: boolean;
  workingTurnId: string;
  activeTurnId: string | null;
  pendingDelivery: boolean;
  /** A queued prompt after this turn is being delivered to the runtime now. */
  deliveringBelow?: boolean;
}): boolean {
  if (!input.hasPendingTurns || !input.newestAssistantCompleted) return false;
  return (
    input.pendingDelivery ||
    !!input.deliveringBelow ||
    (input.activeTurnId !== null && input.activeTurnId !== input.workingTurnId)
  );
}

interface QueuedTurnInput {
  pendingTurnIds: ReadonlySet<string>;
  /** Every id an inbox prompt can render under. */
  pendingPromptIds: { has(id: string): boolean };
}

/** Ids a prompt the inbox is delivering right now can render under. */
interface DeliveringTurnInput {
  deliveringPromptIds: { has(id: string): boolean };
}

/** The transcript's `pending` bubble rule for a turn nobody is working on. */
function isQueuedTurn(turn: TurnLike, input: QueuedTurnInput): boolean {
  const id = turn.userMessage.info.id;
  return (
    input.pendingTurnIds.has(id) ||
    (turn.assistantMessages.length === 0 && input.pendingPromptIds.has(id))
  );
}

/**
 * Where the fallback Thinking row goes when no turn draws its own. A prompt
 * the inbox is delivering is the work in progress, so the row sits directly
 * under its bubble. Otherwise it follows the last turn before the first queued
 * bubble, so it never sits under prompts the agent has not reached. `null` puts
 * it at the transcript's end: nothing is queued, or the queue starts the
 * transcript.
 */
export function fallbackBusyRowAfterTurnId(
  input: QueuedTurnInput & DeliveringTurnInput & { turns: ReadonlyArray<TurnLike> },
): string | null {
  const delivering = input.turns.find((turn) =>
    input.deliveringPromptIds.has(turn.userMessage.info.id),
  );
  if (delivering) return delivering.userMessage.info.id;
  const firstQueued = input.turns.findIndex((turn) => isQueuedTurn(turn, input));
  if (firstQueued <= 0) return null;
  return input.turns[firstQueued - 1].userMessage.info.id;
}

/**
 * Has the server confirmed this turn is the one running? Only then does it drop
 * its pending bubble presentation before the next inbox poll. A fresh send the
 * inbox still holds is the working turn too, and keeps its tint and pending id
 * beside its Thinking row until delivery.
 */
export function turnIsConfirmedActive(input: {
  isTurnWorking: boolean;
  turnId: string;
  activeTurnId: string | null;
  pendingDelivery: boolean;
}): boolean {
  return input.isTurnWorking && !input.pendingDelivery && input.activeTurnId === input.turnId;
}

/**
 * Does the working turn draw the Thinking row itself? It does not when it has
 * no id, when a finished answer yields it to the queue, or when its reply
 * reported an error that is not being retried. Then the fallback row draws, so
 * a busy session (Stop visible) never shows zero rows.
 */
export function workingTurnDrawsBusyRow(input: {
  lastTurnWorking: boolean;
  workingTurnId: string | null;
  suppressed: boolean;
  workingTurnHasError: boolean;
  isRetrying: boolean;
}): boolean {
  if (!input.lastTurnWorking || input.workingTurnId === null || input.suppressed) return false;
  return showTurnBusyIndicator({
    working: true,
    hasError: input.workingTurnHasError,
    isRetrying: input.isRetrying,
  });
}

/**
 * The hint for an idle send this tab just made, while the projection names no
 * turn: the sent turn's CURRENT id, until that turn has an answer.
 *
 * `projectWorking` drops its receipt the moment the runtime emits anything
 * (`activityAfterIdle` → `turnId: null`) — and the first thing an idle send
 * makes the runtime emit is the echo of the user's own prompt, a
 * `message.part.updated` that lands BEFORE the assistant message exists. In
 * that window the optimistic inbox row still reads `queued`, so the
 * `unrunTurnIds` skip below classified the prompt the agent is about to answer
 * as held: the bubble dimmed for a frame and the transcript's scroll anchor
 * fell back to the previous answer — then snapped forward again when the answer
 * opened. That is the double jump on send.
 *
 * Only an IDLE send qualifies (the caller records it; a send into a running
 * turn is genuinely queued and must stay dimmed), and only while the turn is
 * unanswered — once it has an assistant message, rule 1/2 decide on their own.
 * `isSentTurn` matches the sent id OR its re-minted echo alias.
 */
export function freshSendHint(
  turns: ReadonlyArray<TurnLike>,
  isSentTurn: (userMessageId: string) => boolean,
): string | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const id = turns[i].userMessage.info.id;
    if (!isSentTurn(id)) continue;
    return turns[i].assistantMessages.length === 0 ? id : null;
  }
  return null;
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

  const hint = input.hintMessageId ?? null;
  if (hint) {
    if (newestWithContent >= 0 && turns[newestWithContent].userMessage.info.id === hint) {
      return pick(newestWithContent);
    }
    const idx = pendingIds.indexOf(hint);
    if (idx >= 0) return pick(newestWithContent + 1 + idx);
  }

  if (newestWithContent >= 0) {
    const t = turns[newestWithContent];
    const newest = t.assistantMessages[t.assistantMessages.length - 1];
    // An errored reply (an abort, a provider failure) ended its turn even when
    // its completion stamp has not reached this tab.
    if (!completedAt(newest.info) && !newest.info.error) return pick(newestWithContent);
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
  // Rule 4 has no turn to fall back to when NOTHING in the transcript has
  // assistant content and the server is holding every prompt: there is no
  // "newest turn with content". Nothing is working, and every turn is pending
  // — which is exactly what the inbox is saying. `pick(-1)` read `turns[-1]`
  // and threw `Cannot read properties of undefined (reading 'userMessage')`,
  // which the error boundary turned into "Something went wrong" over the whole
  // session view (observed on a real thread whose tail page was all unanswered
  // prompts).
  if (newestWithContent < 0) return { workingTurnId: null, pendingTurnIds: pendingIds };
  return pick(newestWithContent);
}
