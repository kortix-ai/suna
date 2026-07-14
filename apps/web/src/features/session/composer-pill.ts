/**
 * Shared trigger affordance for every pill-style control in the composer
 * toolbar — agent selector, model selectors, variant selector, and the
 * project-home branch/sandbox pills. One source of truth so height, radius,
 * text size, hover, and press feedback never drift between them (2026-07-14
 * agent/model selector UX pass).
 *
 * `active:scale-[0.96]` only animates smoothly when `transform` is in the
 * transition's property list — `transition-colors` alone (Tailwind's
 * `color, background-color, border-color, …` set) leaves the press
 * un-animated, which is the exact drift this constant fixes at every call
 * site.
 */
export const COMPOSER_PILL_TRIGGER_CLASS =
  'text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-[color,background-color,transform] duration-200 active:scale-[0.96]';

/** Applied on top of {@link COMPOSER_PILL_TRIGGER_CLASS} while the pill's
 *  popover is open. */
export const COMPOSER_PILL_ACTIVE_CLASS = 'bg-primary/[0.06] text-foreground';

/** Applied on top of {@link COMPOSER_PILL_TRIGGER_CLASS} when the pill is
 *  disabled/locked — keeps it hoverable (no native `disabled`) so a `Hint`
 *  tooltip can still explain why, per the make-interfaces-feel-better
 *  guidance on never fully suppressing affordance context. */
export const COMPOSER_PILL_DISABLED_CLASS =
  'hover:text-muted-foreground cursor-not-allowed opacity-70 hover:bg-transparent';
