/**
 * The pure half of the action navigator — index arithmetic, live-follow mode
 * transitions, timestamp formatting, and the keyboard-suppression predicate.
 *
 * Split out for the same reason as `easy-panel-logic.ts`: every rule here is a
 * behaviour that regressed at least once in the original panel, and each is
 * cheaper to pin as a pure function than by mounting a panel and a DOM.
 */

import type { ToolPart } from '@/ui';

export type FollowMode = 'live' | 'manual';

/** Keep an index inside a list that grew or shrank while it was held. */
export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(0, index), count - 1);
}

/**
 * Stepping forward onto the LAST action re-arms live-follow: the user has
 * caught up with the stream, so new actions should carry them along rather
 * than stranding them one behind and requiring a second click per action.
 */
export function nextIndex(current: number, count: number): { index: number; mode: FollowMode } {
  const index = Math.min(count - 1, current + 1);
  return { index, mode: index >= count - 1 ? 'live' : 'manual' };
}

/** Stepping back always pins manual — otherwise live-follow yanks the user
 *  forward again on the next streamed action, mid-read. */
export function prevIndex(current: number): { index: number; mode: 'manual' } {
  return { index: Math.max(0, current - 1), mode: 'manual' };
}

/**
 * Wall-clock time the action ran — end if it finished, else start, so a
 * running action still reads as "started at". Same-day actions show the time
 * alone; older ones earn the date, because in a resumed session "2:14 PM"
 * with no day is a lie the user cannot detect.
 *
 * `now` is a parameter, not `new Date()`, so the same-day boundary is testable
 * without freezing the clock.
 */
export function actionTimeLabel(part: ToolPart | undefined, now: Date): string {
  const time = (part?.state as { time?: { start?: number; end?: number } } | undefined)?.time;
  const ms = time?.end ?? time?.start;
  if (typeof ms !== 'number') return '';
  const d = new Date(ms);
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
}

/**
 * Whether a keydown target owns its own arrow keys. The composer, any code or
 * rich-text editor, and the scrubber thumb all do — stepping the navigator
 * from inside one of them would move the caret AND the action, which reads as
 * the app fighting the user.
 */
export function isEditableTarget(el: HTMLElement | null): boolean {
  if (!el) return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.isContentEditable ||
    !!el.closest('.cm-editor') ||
    !!el.closest('.ProseMirror') ||
    !!el.closest('[data-slot="slider"]')
  );
}
