'use client';

/**
 * Motion vocabulary for the onboarding flow.
 *
 * Onboarding is seen once per project, which puts it in the "rare / first-time"
 * bucket where delight is allowed — but the motion still has to mean something.
 * Every value here is doing one of two jobs: telling the user which direction
 * they moved, or preventing a jarring swap.
 *
 * Direction is the whole point. The previous version drifted every step upward
 * whether the user pressed Continue or Back, so the motion actively lied about
 * where they were going. Forward now pushes content left; Back pushes it right;
 * drilling into a sub-view reuses the same grammar one level down.
 */

import type { Transition, Variants } from 'motion/react';

/** Strong ease-out (quint). The built-in `easeOut` is too weak for enter/exit. */
export const EASE_OUT = [0.23, 1, 0.32, 1] as const;

/** How far content travels. Small enough to read as a shift, not a swipe. */
const STEP_TRAVEL = 16;

export const ENTER_TRANSITION: Transition = { duration: 0.22, ease: EASE_OUT };

/** Exits run ~75% of the enter — the user has already decided, get out of the way. */
export const EXIT_TRANSITION: Transition = { duration: 0.17, ease: EASE_OUT };
export const REDUCED_TRANSITION: Transition = { duration: 0.16, ease: EASE_OUT };

/**
 * Directional slide for a step or sub-view swap.
 *
 * `custom` carries the direction: 1 = forward, -1 = backward. When motion is
 * reduced the travel collapses to 0 and only the opacity crossfade survives —
 * the fade still explains that content was replaced, so removing it entirely
 * would cost comprehension rather than just movement.
 */
export function slideVariants(reduced: boolean): Variants {
  const ahead = reduced ? 0 : STEP_TRAVEL;
  // Negating 0 yields -0, which is a distinct value to Object.is and would make
  // the reduced-motion contract awkward to assert. Pin it to a true zero.
  const behind = reduced ? 0 : -STEP_TRAVEL;
  return {
    enter: (direction: number) => ({
      opacity: 0,
      x: direction >= 0 ? ahead : behind,
    }),
    center: {
      opacity: 1,
      x: 0,
      transition: reduced ? REDUCED_TRANSITION : ENTER_TRANSITION,
    },
    exit: (direction: number) => ({
      opacity: 0,
      x: direction >= 0 ? behind : ahead,
      transition: reduced ? REDUCED_TRANSITION : EXIT_TRANSITION,
    }),
  };
}

/**
 * Layout shifts — a sibling appearing and pushing content sideways.
 *
 * A spring, not a tween, because this one is interruptible by design: the row
 * that opens the panel is a toggle, so a user can close it mid-open. Springs
 * preserve velocity across an interruption; a tween restarts from zero and
 * visibly jumps. `bounce: 0` keeps it matter-of-fact — bounce belongs to drag
 * and play, not to chrome rearranging itself.
 */
export const LAYOUT_TRANSITION: Transition = { type: 'spring', duration: 0.4, bounce: 0 };

/**
 * The finish-step seal. A spring with a trace of bounce, because this is the
 * one genuinely celebratory moment in the flow and it happens exactly once.
 * Floor is 0.6, never 0 — nothing in the world appears from nothing.
 */
export const SEAL_TRANSITION: Transition = { type: 'spring', duration: 0.5, bounce: 0.28 };
