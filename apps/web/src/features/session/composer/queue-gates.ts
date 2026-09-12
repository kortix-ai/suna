/**
 * The gates the parked-queue list (the one built by Cmd/Ctrl+Enter, above the
 * composer — see `send-intent.ts`) consults about ITSELF: is it full, is it
 * held, what does its header say, and where does a "move to top" drag land.
 *
 * These are UI-only. The server owns whether a prompt runs
 * (`send-blockers.ts`'s comment on the admission gate applies here too) — none
 * of this decides whether to send anything, only how the list already sitting
 * in the composer explains its own state to the person looking at it.
 */

/**
 * How many rows the parked queue holds before it refuses another.
 *
 * A hard ceiling, not a soft warning: past this many parked prompts the list
 * itself becomes the thing the user has to scroll and manage, which is the
 * opposite of "park it and keep typing." Ten is enough headroom for a burst of
 * corrections without turning the composer into a second inbox.
 */
export const QUEUE_MAX_DEPTH = 10;

/** Is the parked queue full — should Cmd/Ctrl+Enter refuse to add another row? */
export function queueIsAtCap(depth: number): boolean {
  return depth >= QUEUE_MAX_DEPTH;
}

/**
 * The refusal shown at the cap, as a CATALOG KEY.
 *
 * Names both ways out — send one, remove one — instead of just "Queue full",
 * because the user staring at ten parked rows has no way to guess which of the
 * two is faster without being told.
 *
 * A key, not a sentence: this file is imported by a nine-locale UI, and a
 * string constant here is a string constant on nine screens. Every reader
 * resolves it through `hardcodedUi.i18nComplete` — the same catalog the toast
 * in `session-chat.tsx` already reads it from.
 */
export const QUEUE_FULL_HINT_KEY = 'textd7c6dee0138e';

/**
 * The states a turn can be in, as the composer needs to know them.
 *
 * `stopping` is its own state, not folded into `running`, because a queue
 * header that already said "runs after this turn" during `running` must keep
 * saying it while the stop is still in flight — the turn has not ended, so
 * nothing has changed yet.
 */
export type QueueRunState = 'idle' | 'running' | 'awaiting_input' | 'stopping' | 'error';

export type QueueBlockedReason = 'paused' | 'error' | 'awaiting_input' | 'run_active';

/**
 * Why the parked queue is not draining right now, or `null` if it would drain
 * the moment the current turn ends.
 *
 * Ranked by how much the user can do about it, most total first:
 *
 *   - `paused`         — the user pressed Stop. Nothing drains until they
 *     press Resume, no matter what the run state underneath says.
 *   - `error`           — the last turn failed. The queue stays held so a
 *     failed answer cannot silently pull the next parked prompt into the same
 *     hole.
 *   - `awaiting_input`  — a structured question is on screen; draining past it
 *     would answer the wrong prompt (mirrors `active_question` in
 *     `send-blockers.ts`).
 *   - `run_active`      — a turn (`running` or `stopping`) is simply still
 *     going.
 *
 * `paused` outranks `error` on purpose: pressing Stop mid-turn can itself
 * leave `runState` at `'error'` (the turn ended abnormally), and a user who
 * just pressed Stop needs to see "paused" and a Resume action, not "last run
 * failed" — the failed-run wording belongs to a run that stopped on its own.
 */
export function queueDrainBlockedReason(input: {
  runState: QueueRunState;
  paused: boolean;
}): QueueBlockedReason | null {
  if (input.paused) return 'paused';
  if (input.runState === 'error') return 'error';
  if (input.runState === 'awaiting_input') return 'awaiting_input';
  if (input.runState === 'running' || input.runState === 'stopping') return 'run_active';
  return null;
}

/**
 * The parked-queue header's wording, as a CATALOG KEY.
 *
 * Reuses `queueDrainBlockedReason`'s precedence exactly — the header is the
 * human-readable face of that same decision, and the two disagreeing (e.g. the
 * header saying "runs after this turn" while the reason is actually `paused`)
 * is precisely the stale-header bug this shares one ranking to prevent.
 *
 * KEYS, not sentences. Every one of these strings is on screen in nine locales
 * and each takes a `{count}`, so they belong in `hardcodedUi.i18nComplete`
 * where a translator can reach them. The ranking stays here, which is the part
 * that must not be duplicated.
 */
export const QUEUE_HEADER_LABEL_KEYS: Record<QueueBlockedReason | 'idle', string> = {
  /** '{count} queued · paused' */
  paused: 'texta38c0e22c3d8',
  /** '{count} queued · last run failed' */
  error: 'text046a3f8e6983',
  /** '{count} queued · waiting on your approval' */
  awaiting_input: 'text4d054a0518a8',
  /** '{count} queued · runs after this turn' */
  run_active: 'text21e1343e21bf',
  /** '{count} queued' */
  idle: 'texta1602ae91079',
};

export function queueHeaderLabelKey(input: {
  runState: QueueRunState;
  paused: boolean;
}): string {
  return QUEUE_HEADER_LABEL_KEYS[queueDrainBlockedReason(input) ?? 'idle'];
}

/**
 * The one-click action the header offers next to its label, or `null` when
 * there is nothing for the user to do but wait.
 *
 * `paused` still outranks `error` here for the same reason as
 * `queueDrainBlockedReason`: a paused-by-Stop queue needs Resume, not Retry,
 * even on a run state that would otherwise read as failed.
 */
export function queueHeaderAction(input: {
  runState: QueueRunState;
  paused: boolean;
}): 'resume' | 'retry' | null {
  if (input.paused) return 'resume';
  if (input.runState === 'error') return 'retry';
  return null;
}

/**
 * How many parked rows before the list opens collapsed by default.
 *
 * Lower than `QUEUE_MAX_DEPTH` on purpose: by four rows the list is already
 * taller than what a composer wants to sit above at rest, well before it is
 * anywhere near full.
 */
export const QUEUE_COLLAPSE_AT_DEPTH = 4;

/** Should the parked-queue list render collapsed the first time this depth is seen? */
export function queueStartsCollapsed(depth: number): boolean {
  // ALWAYS, at any depth. The queue opens as one line showing the prompt that
  // goes next; the rest is one click away. It used to open expanded below
  // `QUEUE_COLLAPSE_AT_DEPTH`, which pushed the composer down by a row for
  // every prompt parked — the box you are typing in moved while you typed.
  // `QUEUE_COLLAPSE_AT_DEPTH` is kept as the depth the list is worth scrolling
  // at, which is what the scroll box is sized from.
  void depth;
  return true;
}

/**
 * The reordered id list after dragging `id` to the top of the parked queue, or
 * `null` when there is nothing to do.
 *
 * `null` covers two cases the same way: `id` missing from `orderedIds`, and
 * `id` already at index 0. Both are a no-op, and collapsing them into one
 * `null` return (rather than throwing on the first or silently no-op'ing a
 * fresh array on the second) matters because a caller that fires a reorder
 * request whenever this returns non-null must never send one for a row that
 * never moved — the server has nothing to persist and the drag would look like
 * it re-triggered itself.
 */
export function nextQueueOrderAfterMoveToTop(
  orderedIds: readonly string[],
  id: string,
): string[] | null {
  const index = orderedIds.indexOf(id);
  if (index <= 0) return null;
  const rest = orderedIds.filter((existingId) => existingId !== id);
  return [id, ...rest];
}
