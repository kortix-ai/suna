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
 *
 * ## The pill law (Task 22, spec 3d)
 *
 * Every composer pill — and every segmented-control alternative to one, e.g.
 * a `mode`-typed ACP config option's `TabsListCompact`/`TabsTriggerCompact`
 * row — follows the same four rules, so the toolbar reads as one system
 * instead of N hand-rolled controls that happen to sit next to each other:
 *
 * 1. **Shared constants, never hand-rolled copies.** Every trigger imports
 *    {@link COMPOSER_PILL_TRIGGER_CLASS} (and {@link COMPOSER_PILL_ACTIVE_CLASS} /
 *    {@link COMPOSER_PILL_DISABLED_CLASS} as needed) instead of inlining an
 *    equivalent-looking class string. A pill that looks right today but
 *    copies the classes by hand silently drifts the next time this file's
 *    height/radius/press-feedback changes — the whole point of one source of
 *    truth is that every call site actually depends on it.
 * 2. **Chevron ⇔ popover.** A `ChevronDown` (or any "there's a menu here"
 *    affordance) appears on a trigger if and only if activating it opens a
 *    popover/dropdown. A control that changes value in place (a segmented
 *    control, a toggle) never wears a chevron — that glyph is a promise
 *    about interaction shape, not decoration.
 * 3. **Click-to-cycle is banned.** No pill silently advances to "the next"
 *    value on repeated clicks. Every value change is an explicit pick — from
 *    an opened popover's list, or from a segmented control's own visible
 *    options — never an implicit cycle a user can't see coming or undo by
 *    looking.
 * 4. **Hide vs. disable-with-`Hint`.** If a capability doesn't apply to this
 *    session/agent/harness at all, the pill doesn't render — no dead control
 *    taking up toolbar space for something that was never possible here. If
 *    the capability exists but the user/state can't act on it right now
 *    (locked session, missing permission, in-flight request), the pill stays
 *    visible and disabled, wrapped in a `Hint` that explains why — never
 *    fully suppressed, so the toolbar never silently loses an affordance the
 *    user just saw working a moment ago.
 */
export const COMPOSER_PILL_TRIGGER_CLASS =
  'text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-[color,background-color,transform] duration-200 active:scale-[0.96]';

/** Applied on top of {@link COMPOSER_PILL_TRIGGER_CLASS} while the pill's
 *  popover is open. */
export const COMPOSER_PILL_ACTIVE_CLASS = 'bg-primary/[0.06] text-foreground';

/**
 * A toolbar zone whose pills scroll horizontally on phones instead of
 * squishing or pushing the primary actions (send/stop/voice) out of the
 * card — used by BOTH sides of the composer toolbar: the left
 * attach/agent/model cluster and the right secondary zone (context ring +
 * `toolbarSlot`, which can carry several wide pills: ACP config options on
 * live sessions, Branch/Sandbox pickers on project home). Safe because every
 * pill popover is portalled (`popover.tsx`), so the scroll container never
 * clips them; from `sm:` up it reverts to a visible-overflow row.
 */
export const COMPOSER_TOOLBAR_SCROLL_ZONE_CLASS =
  'flex min-w-0 items-center gap-0 overflow-x-auto [scrollbar-width:none] sm:overflow-visible [&::-webkit-scrollbar]:hidden';

/** Applied on top of {@link COMPOSER_PILL_TRIGGER_CLASS} when the pill is
 *  disabled/locked — keeps it hoverable (no native `disabled`) so a `Hint`
 *  tooltip can still explain why, per the make-interfaces-feel-better
 *  guidance on never fully suppressing affordance context. */
export const COMPOSER_PILL_DISABLED_CLASS =
  'hover:text-muted-foreground cursor-not-allowed opacity-70 hover:bg-transparent';
