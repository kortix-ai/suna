/**
 * Motion vocabulary — ported from fluidfunctionalism.com. The three spring
 * presets are *all* the easings the app should use. If you find yourself
 * reaching for a cubic-bezier, you probably want `springs.moderate`.
 *
 * Uses Motion v12+'s duration/bounce spring API (not the older mass/stiffness
 * form), which is more predictable to reason about: `duration` is the visible
 * settle time, `bounce` is the overshoot ratio (0 = critically damped).
 */
export const springs = {
  /** Color, opacity, snap-fast state changes. Practically instant but smooth. */
  fast: { type: 'spring' as const, duration: 0.08, bounce: 0 },
  /** Active-state backdrops, layout shifts, dialog open. The default. */
  moderate: { type: 'spring' as const, duration: 0.16, bounce: 0.15 },
  /** Larger reveals — full-page panels, hero metrics, big numbers. */
  slow: { type: 'spring' as const, duration: 0.24, bounce: 0.15 },
} as const;

/**
 * Variable-font weight axis values. Use as `font-variation-settings` (NOT
 * `font-weight` — the variable axis is continuously interpolatable, the
 * discrete property is not). Geist supports the `wght` axis.
 *
 * Convention: `normal` everywhere, `medium` (450, sub-perceptible) on hover
 * to signal interactivity, `semibold` (550) for active states, `bold` (700)
 * reserved for emphasis.
 */
export const fontWeights = {
  normal: "'wght' 400",
  medium: "'wght' 450",
  semibold: "'wght' 550",
  bold: "'wght' 700",
} as const;

/**
 * CSS transition shorthand for the FF "thicken on hover" pattern.
 * Apply on the interactive element; combine with `style={{ fontVariationSettings: hovered ? fontWeights.medium : fontWeights.normal }}`
 * or use the utility classes below.
 */
export const motionTransitions = {
  /** Snappy color/state transitions (80ms). */
  fast: 'transition-[color,background-color,opacity,font-variation-settings,stroke-width] duration-80',
  /** Layout-sized transitions (160ms). */
  moderate:
    'transition-[color,background-color,opacity,font-variation-settings,transform,stroke-width] duration-150',
} as const;

export type SpringPreset = keyof typeof springs;

/**
 * Class string applied to items inside menus/lists that use the proximity-style
 * highlight backdrop (DropdownMenuItem, ContextMenuItem, etc). Strips the
 * default focus background (the backdrop handles it now) and lifts items above
 * the absolute-positioned backdrop. No font-weight or scale change — the
 * backdrop is the entire signal.
 */
export const menuItemMotion =
  'relative z-10 ' +
  'focus:bg-transparent data-[state=open]:bg-transparent data-[state=checked]:bg-transparent ' +
  '[&_svg]:transition-[stroke-width,color] [&_svg]:duration-150 ' +
  'focus:[&_svg]:[stroke-width:2] data-[state=checked]:[&_svg]:[stroke-width:2]';
