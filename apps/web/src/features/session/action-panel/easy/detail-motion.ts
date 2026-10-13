/**
 * The Easy detail's motion contracts, as pure data: the shared slide and
 * crossfade timings, the detail card's enter/exit variants and the terminal
 * layer's per-edge targets. `DetailLayer` applies them; the tests read them
 * without a DOM.
 */
import type { TargetAndTransition, Transition } from 'motion/react';

/**
 * Motion: the detail arrives from the right and the home slides a short way
 * left — a partial parallax, not a full swap, so the home reads as *behind*
 * the detail rather than gone. 260ms on a soft ease-out; the eye should follow
 * the movement without waiting on it.
 */
const EASE = [0.22, 1, 0.36, 1] as const;
const DURATION = 0.26;
export const SLIDE_TRANSITION = { duration: DURATION, ease: EASE } as const;

/**
 * Motion: paging to a sibling deliverable is not a re-arrival — the card
 * already IS there, only what's inside it changed. So the slide never plays
 * again; the header+body+nav just crossfade, fast enough to read as a swap
 * rather than a transition (130ms, ease-out — quicker than the 260ms open/
 * close slide, per the doctrine that exits/swaps stay subtler than entrances).
 */
export const CROSSFADE_TRANSITION = { duration: 0.13, ease: 'easeOut' } as const;

/**
 * The detail card's enter/exit targets, as dynamic variants over one custom
 * boolean: `swap` — the terminal layer is on the OTHER side of this edge
 * (the card is replacing it, or being replaced by it).
 *
 * A swap is a sibling exchange inside the same visual frame, so it borrows
 * the nav-crossfade language, not the arrival slide. And because both layers
 * are fully opaque cards, only ONE of them may fade or the home bleeds
 * through the midpoint: the terminal — painted above the card by DOM order —
 * owns the whole 130ms fade (see `terminalLayerMotion`), while the card just
 * appears/disappears at full opacity underneath at the right moment: enter
 * lands instantly under the fading-out terminal; exit holds until the
 * fading-in terminal fully covers it, then leaves.
 *
 * `swap` reaches the variants two ways: the element's own `custom` (stamped
 * from `Detail.swapIn`, read at mount for the enter) and `AnimatePresence`'s
 * `custom` (the live `terminalOpen`, which motion swaps in for the exit —
 * the element's last-rendered props predate the state flip that removed it).
 *
 * Exported for tests; pure so the choreography is checkable without a DOM.
 */
export function detailCardVariants(reduce: boolean) {
  const slide = reduce ? ({ duration: 0 } as const) : SLIDE_TRANSITION;
  return {
    hidden: (swap: boolean): TargetAndTransition =>
      swap
        ? {
            opacity: 0,
            transition: { duration: 0, delay: reduce ? 0 : CROSSFADE_TRANSITION.duration },
          }
        : reduce
          ? { opacity: 0, transition: { duration: 0 } }
          : { x: '100%', transition: slide },
    visible: (swap: boolean): TargetAndTransition => ({
      x: 0,
      opacity: 1,
      transition: swap ? { duration: 0 } : slide,
    }),
  };
}

/**
 * The terminal layer's animate target + transition for its four edges. The
 * layer is keep-alive (never unmounted — it owns a live PTY WebSocket), so
 * instead of `AnimatePresence` it converges on one of two resting states —
 * open `{x: 0, opacity: 1}` / closed `{x: '100%', opacity: 0}` — and the
 * `swap` flag picks which property carries the motion between them:
 *
 * - home ↔ terminal (`swap` false): the same 260ms slide the detail card
 *   plays — going one level deeper is one motion language, whatever the
 *   layer. Opacity snaps while the layer is off-panel (clipped, invisible
 *   anyway): instantly to 1 before a slide-in, to 0 only AFTER a slide-out.
 * - detail ↔ terminal (`swap` true): the 130ms crossfade, which this layer
 *   carries alone (see `detailCardVariants`). x teleports while invisible —
 *   instantly into place before a fade-in, off-panel only after a fade-out.
 *
 * Reduced motion keeps the comprehension fade on swaps but snaps the slides
 * (movement is what reduced motion asks to lose, not state changes).
 *
 * Exported for tests; pure for the same reason as `detailCardVariants`.
 */
export function terminalLayerMotion(
  open: boolean,
  swap: boolean,
  reduce: boolean,
): { target: TargetAndTransition; transition: Transition } {
  const target: TargetAndTransition = open ? { x: 0, opacity: 1 } : { x: '100%', opacity: 0 };
  if (swap || reduce) {
    const fade = reduce ? ({ duration: 0 } as const) : CROSSFADE_TRANSITION;
    return {
      target,
      transition: open
        ? { ...fade, x: { duration: 0 } }
        : { ...fade, x: { duration: 0, delay: reduce ? 0 : CROSSFADE_TRANSITION.duration } },
    };
  }
  return {
    target,
    transition: open
      ? { ...SLIDE_TRANSITION, opacity: { duration: 0 } }
      : { ...SLIDE_TRANSITION, opacity: { duration: 0, delay: DURATION } },
  };
}
