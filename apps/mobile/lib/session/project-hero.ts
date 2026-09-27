/**
 * project-hero — the size of the Kortix symbol on an empty project surface
 * (project home, and a new chat with no messages).
 *
 * The symbol is the whole hero: there is no sentence under it (Jay,
 * 2026-09-21). It scales with the window so it reads as large on every phone,
 * and shrinks while the keyboard is up, when the area above the composer is
 * about half the screen.
 *
 * Pure data and pure functions only: `bun test` cannot load native modules.
 */

const HERO_WIDTH_RATIO = 0.3;
const HERO_MIN_SIZE = 88;
const HERO_MAX_SIZE = 150;

/**
 * Scale of the symbol while the keyboard is fully up: 121pt rests at 76pt on a
 * 402pt phone. The symbol renders at its resting size and scales down, so it
 * stays sharp at both ends.
 */
export const HERO_KEYBOARD_SCALE = 0.625;

/** Resting size of the symbol, in points, for a window of this width. */
export function heroLogoSize(windowWidth: number): number {
  if (!(windowWidth > 0)) return HERO_MIN_SIZE;
  return Math.min(HERO_MAX_SIZE, Math.max(HERO_MIN_SIZE, Math.round(windowWidth * HERO_WIDTH_RATIO)));
}
