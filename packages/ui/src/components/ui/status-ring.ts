/**
 * The one circle every status glyph in the app is drawn on.
 *
 * Three components render this ring — `Loading` (`variant="ring"`),
 * `TodoStatusIcon`, and `PlanRing` — and they used to disagree about it. All
 * three were nominally `size-4`, and all three painted something different:
 *
 *   pending todo   viewBox 16   r 6.3  stroke 1.5   → 14.1px disc, 1.50px stroke
 *   completed todo viewBox 256  r 104  (filled)     → 13.0px disc  (Phosphor)
 *   spinner        viewBox 24   r 10   stroke 4     → 16.0px disc, 2.67px stroke
 *   plan ring      viewBox 24   r 9.9  stroke 2     → 15.8px disc, 1.33px stroke
 *
 * Same class, four sizes, three weights. That is why the check read small and
 * the spinner read fat next to each other. Sharing these numbers is what makes
 * the states interchangeable: swap one glyph for another and only the *meaning*
 * changes — the ink never moves.
 *
 * Lives in `components/ui` rather than beside the todo code because `Loading`
 * is a ui primitive and a primitive must not import from a feature.
 */
export const STATUS_RING = {
  /** Square viewBox. 16 so one user unit is one CSS pixel at `size-4`. */
  BOX: 16,
  CENTER: 8,
  /** Ring centreline. */
  RADIUS: 6.3,
  STROKE: 1.5,
  /** Dash pattern of the `pending` ring, in user units: a 3-long tick against a
   *  6.4 pitch. This is also the plan ring's texture — see `plan-card.tsx`. */
  DASH: 3,
  GAP: 3.4,
} as const;

/** Where the ring's ink actually ends: centreline + half the stroke. A filled
 *  state uses this as its radius, so a disc and a ring occupy the same circle
 *  rather than the disc sitting visibly inside it. */
export const STATUS_RING_OUTER_RADIUS = STATUS_RING.RADIUS + STATUS_RING.STROKE / 2; // 7.05

/** Dash pitch, in user units. */
export const STATUS_RING_PITCH = STATUS_RING.DASH + STATUS_RING.GAP; // 6.4
