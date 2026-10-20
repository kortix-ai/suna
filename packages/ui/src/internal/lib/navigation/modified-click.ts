import type { MouseEvent } from 'react';

/**
 * True when the browser will handle this click itself instead of letting the
 * App Router navigate — cmd/ctrl-click, shift-click, alt-click, or a
 * middle-click. `next/link` makes the same check before it takes over
 * (node_modules/next/dist/client/link.js, `isModifiedEvent`) and bails out,
 * leaving the browser to open a new tab or window.
 *
 * Any side effect attached to a nav control has to make the same check. A
 * handler that fires regardless mutates the CURRENT tab's state for a
 * navigation that is happening in a different one — a switch overlay that
 * spins forever, a store repointed at something the user is not looking at.
 */
export function isModifiedClick(event: MouseEvent<HTMLElement>): boolean {
  return (
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    // 0 = primary. Radix's keyboard activation synthesises a click with
    // button 0, so Enter still counts as an ordinary activation.
    event.button !== 0
  );
}
