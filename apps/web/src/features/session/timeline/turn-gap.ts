/**
 * The vertical space before a turn — the wrapper's class, never an element.
 * Queued bubbles STACK: a pending turn right after another pending turn sits
 * close to it, like a list of what is waiting — not a turn's width apart as
 * if each had been answered in between.
 *
 * Pure and DOM-free. The flat list applies it as the turn's top margin
 * (`session-timeline-list.tsx`); the virtual list moves the same space to the
 * previous item's bottom padding (`timeline-virtual.ts`, `turnGapBelowClass`).
 */
export function turnGapClass(input: {
  index: number;
  userMessageID: string;
  previousUserMessageID: string | undefined;
  lastTurnWorking: boolean;
  pendingTurnIds: ReadonlySet<string>;
}): string {
  if (input.index === 0) return '';
  return input.lastTurnWorking &&
    input.pendingTurnIds.has(input.userMessageID) &&
    input.previousUserMessageID !== undefined &&
    input.pendingTurnIds.has(input.previousUserMessageID)
    ? 'mt-3'
    : 'mt-12';
}
