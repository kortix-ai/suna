import type { TimelineVirtualApi } from './timeline/timeline-virtual';

/** Where a jumped-to turn lands: this far under the viewport top. */
export const JUMP_TOP_OFFSET = 24;

/**
 * Jump the transcript to one turn — ⌘K "jump to message" and the minimap.
 *
 * A jump is READER intent to leave the end, so `leaveEnd` runs FIRST. Under
 * the virtual list the target is usually not in the DOM: `scrollToTurn`
 * scrolls to its index and mounts it, which is a layout change — and
 * `use-auto-scroll`'s settle rule puts a *following* viewport back at the end
 * after any layout change. Without leaving "follow" first the jump starts
 * (scrollTop moves a few px) and is snapped back within a frame — seen live:
 * 2689 → 2685 → 2689 in 120 ms. The flat list never exposed this because all
 * turns were mounted and a jump changed no layout.
 *
 * Returns false when there is nothing to jump to; `leaveEnd` is not called
 * then — a no-op jump must not disturb auto-follow.
 */
const escapeAttr = (value: string): string =>
  typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, (c) => `\\${c}`);

export function jumpToTurn(input: {
  id: string;
  behavior: ScrollBehavior;
  api: Pick<TimelineVirtualApi, 'scrollToTurn'> | null | undefined;
  scrollEl: HTMLDivElement;
  contentEl: HTMLDivElement;
  leaveEnd: (why: string) => void;
}): boolean {
  const { id, behavior, api, scrollEl, contentEl, leaveEnd } = input;
  // Virtual list: the virtualizer scrolls to the index and mounts the turn.
  // Leave the end the moment it accepts — the settle that would snap back runs
  // on the LATER layout change, so this same tick is early enough, and a turn
  // the virtualizer does not know never disturbs follow.
  if (api?.scrollToTurn(id, { align: 'start', behavior })) {
    leaveEnd('jump');
    return true;
  }
  const target = contentEl.querySelector<HTMLElement>(`[data-turn-id="${escapeAttr(id)}"]`);
  if (!target) return false;
  leaveEnd('jump');
  const offset =
    target.getBoundingClientRect().top -
    scrollEl.getBoundingClientRect().top +
    scrollEl.scrollTop -
    JUMP_TOP_OFFSET;
  scrollEl.scrollTo({ top: Math.max(0, offset), behavior });
  return true;
}
