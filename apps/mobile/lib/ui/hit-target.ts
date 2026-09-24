/**
 * Touch-target sizing. Apple HIG and Material both ask for a 44pt (48dp)
 * minimum. Small visual boxes keep their size and grow their touch area with
 * `hitSlop` instead.
 *
 * Pure (no React Native import) so `bun test` can pin the numbers.
 */

/** The minimum touch target on every platform, in points. */
export const MIN_TOUCH_TARGET = 44;

export type HitSlopInsets = { top: number; bottom: number; left: number; right: number };

/** Slop on each side that grows a `box`-point edge to `min` points. */
export function slopToReach(box: number, min: number = MIN_TOUCH_TARGET): number {
  return Math.max(0, Math.ceil((min - box) / 2));
}

/** Phone box sizes of `Button` (`components/ui/button.tsx` `size` variants). */
export const BUTTON_BOX = {
  default: { height: 40 },
  sm: { height: 36 },
  lg: { height: 44 },
  xl: { height: 48 },
  icon: { height: 40, width: 40 },
  'icon-md': { height: 36, width: 36 },
  'icon-sm': { height: 28, width: 28 },
} as const;

export type ButtonSize = keyof typeof BUTTON_BOX;

/**
 * The hit slop a `Button` gets when the caller passes none.
 *
 * - Square icon sizes grow to 44pt on every side (`icon` 2pt, `icon-md` 4pt).
 * - `icon-sm` (28pt, the chat-message actions) grows 8pt above and below but
 *   only 4pt at the sides: those actions sit 2pt apart, and a wider slop would
 *   take taps from the neighbour's visible box.
 * - Text sizes grow vertically only; their width comes from the label.
 *
 * A `Button` whose `className` overrides its box (`h-auto w-auto`) still gets
 * this default; pass an explicit `hitSlop` there.
 */
export function defaultButtonHitSlop(size: ButtonSize | null | undefined): HitSlopInsets | undefined {
  const key: ButtonSize = size ?? 'default';
  if (key === 'icon-sm') return { top: 8, bottom: 8, left: 4, right: 4 };
  const box = BUTTON_BOX[key];
  const vertical = slopToReach(box.height);
  const horizontal = 'width' in box ? slopToReach(box.width) : 0;
  if (vertical === 0 && horizontal === 0) return undefined;
  return { top: vertical, bottom: vertical, left: horizontal, right: horizontal };
}
