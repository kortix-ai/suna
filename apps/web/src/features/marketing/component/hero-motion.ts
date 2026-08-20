/**
 * Shared motion constants for the per-page hero scenes.
 *
 * Constants and one helper — deliberately not a component. Each capability
 * page owns its own scene; what they share is a tempo, so the site reads as one
 * thing while every hero stays its own object.
 *
 * The contract: a scene plays **once** on mount and then rests. Nothing loops,
 * with one sanctioned exception — a terminal caret, which carries the real
 * meaning "this prompt is live".
 */

/** The blessed ease-out. Every hero element is entering, so nothing uses ease-in. */
export const EASE_OUT = [0.23, 1, 0.32, 1] as const;

/** Per-item stagger. Doctrine range is 30–80ms. */
export const STEP = 0.05;

/** Lets the panel land before its contents start arriving. */
export const LEAD = 0.16;

/** Standard one-shot reveal for one element of a scene. */
export function reveal(delay: number, reduceMotion: boolean) {
  return {
    initial: reduceMotion ? false : { opacity: 0, y: 6 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.32, delay, ease: EASE_OUT },
  } as const;
}

/** The panel itself: the one element that also moves on the z-ish axis. */
export function panel(reduceMotion: boolean) {
  return {
    initial: reduceMotion ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.985 },
    animate: { opacity: 1, y: 0, scale: 1 },
    transition: { duration: 0.46, ease: EASE_OUT },
  } as const;
}
