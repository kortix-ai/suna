/**
 * Programmatic focus that never scrolls ancestors into view.
 *
 * A plain `.focus()` makes the browser scroll EVERY scrollable ancestor —
 * including `overflow: hidden` ones, which accept a programmatic
 * `scrollLeft` — to reveal the focused element. The session panel focuses
 * elements while they're still translated off-panel by an enter animation
 * (the detail card slides in from `x: 100%`), so that reveal shoved a
 * permanent sideways scroll onto the panel's `overflow-hidden` wrappers:
 * with the keep-alive terminal layer parked at `translateX(100%)`, the
 * overflow never shrinks back and the layout stayed shifted with no
 * scrollbar to undo it.
 *
 * Every focus aimed at (or inside) an animated layer must go through here.
 */
export function focusWithoutScroll(
  el: { focus?: (opts?: FocusOptions) => void } | null | undefined,
): void {
  el?.focus?.({ preventScroll: true });
}
