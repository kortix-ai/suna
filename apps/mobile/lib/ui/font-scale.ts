/**
 * Dynamic Type caps for text inside a fixed-height control.
 *
 * A `Button` pill keeps its height (`h-9`, `h-11`) at every text size, so a
 * label that grows past the box overflows it. The cap lets the label grow
 * until its line box fills the control, and no further. Text outside a
 * fixed-height box is never capped.
 *
 * Pure (no React Native import) so `bun test` can pin the numbers.
 */

import { BUTTON_BOX } from './hit-target';

/** Largest font scale at which a `lineHeight` line still fits a `box`-point control. */
export function maxFontScaleForBox(box: number, lineHeight: number): number {
  // Floor to 0.05 so rounding never pushes the line past the box.
  return Math.max(1, Math.floor((box / lineHeight) * 20) / 20);
}

/** Label line heights by `Button` size (`buttonTextVariants`: `text-sm` 20pt, `text-base` 24pt). */
const BUTTON_LABEL_LINE_HEIGHT = { sm: 20, default: 20, lg: 24, xl: 24 } as const;

/**
 * `maxFontSizeMultiplier` for a label inside a text `Button`, by size.
 * Pass it on the `<Text>` child: `<Text maxFontSizeMultiplier={BUTTON_LABEL_MAX_FONT_SCALE.sm}>`.
 */
export const BUTTON_LABEL_MAX_FONT_SCALE = {
  sm: maxFontScaleForBox(BUTTON_BOX.sm.height, BUTTON_LABEL_LINE_HEIGHT.sm),
  default: maxFontScaleForBox(BUTTON_BOX.default.height, BUTTON_LABEL_LINE_HEIGHT.default),
  lg: maxFontScaleForBox(BUTTON_BOX.lg.height, BUTTON_LABEL_LINE_HEIGHT.lg),
  xl: maxFontScaleForBox(BUTTON_BOX.xl.height, BUTTON_LABEL_LINE_HEIGHT.xl),
} as const;
