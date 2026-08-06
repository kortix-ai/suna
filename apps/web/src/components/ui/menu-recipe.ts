import { cn } from '@/lib/utils';

/**
 * ONE recipe for every row in every menu.
 *
 * `dropdown-menu.tsx` used to own this. Its four row components — Item,
 * SubTrigger, CheckboxItem and RadioItem — had each hardcoded their own
 * spacing, radius, focus colour and type, drifted apart, and been reconciled
 * into a single recipe. `context-menu.tsx` was still running the stock shadcn
 * styling, so the same menu rendered two different ways depending on whether
 * you reached it by click or by right-click:
 *
 *   dropdown Item   rounded-md  px-2.5 py-1.5  focus:bg-primary/10  text-foreground/80
 *   context  Item   rounded-sm  px-2   py-1.5  focus:bg-accent      (inherited colour)
 *
 * Duplicating the recipe into the second file would recreate exactly the drift
 * the first file's comment describes. It lives here instead, imported by both.
 *
 * A menu row is a row regardless of what opened it, so there is deliberately
 * no per-menu escape hatch in this module. Anything that genuinely differs
 * between the two menus — panel width, transform origin, scroll behaviour —
 * stays in the component file that owns it.
 */
export type MenuRowSize = 'sm' | 'md' | 'lg';
export type MenuRowTone = 'default' | 'destructive';

/** Padding and type per step. Radius and gap stay fixed so columns line up. */
const MENU_ROW_SIZE: Record<MenuRowSize, string> = {
  sm: 'px-2.5 py-1.5 text-sm',
  md: 'px-3 py-2 text-sm',
  lg: 'px-3.5 py-2.5 text-base',
};

/**
 * `transition-colors`, not `transition-all`: a hover highlight only needs its
 * background and text to move, and 150ms keeps the highlight under the cursor
 * rather than trailing it.
 */
const MENU_ROW_BASE =
  'relative flex w-full cursor-default items-center gap-2 rounded-md font-normal outline-none select-none transition-colors duration-150 ease-out data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0';

/**
 * Keyboard focus and pointer hover resolve to the same treatment on purpose —
 * Radix marks the keyboard-focused row `data-highlighted`, and a row you
 * arrowed onto should look exactly like a row you hovered.
 */
const MENU_ROW_TONE: Record<MenuRowTone, string> = {
  default:
    'text-foreground/80 hover:bg-primary/10 hover:text-foreground focus:bg-primary/10 focus:text-foreground data-highlighted:bg-primary/10 data-highlighted:text-foreground data-[state=open]:bg-primary/10 data-[state=open]:text-foreground',
  destructive:
    'text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive',
};

/** `className` last so a caller can still override any of it. */
export function menuRow(size: MenuRowSize, tone: MenuRowTone, className?: string) {
  return cn(MENU_ROW_BASE, MENU_ROW_SIZE[size], MENU_ROW_TONE[tone], className);
}

/**
 * The floating surface. Every panel that opens over the page wears it:
 * `DropdownMenuContent` / `SubContent`, `ContextMenuContent` / `SubContent`,
 * `SelectContent`, `PopoverContent`.
 *
 * They are the same object — a hairline-bordered card lifted off the canvas —
 * and they had four different descriptions of it:
 *
 *   dropdown  bg-background  radius calc(--radius+0.2rem)  shadow-lg  p-1
 *   context   bg-popover     radius --radius-md            shadow-md  p-1
 *   select    bg-background  radius calc(--radius+0.2rem)  shadow-lg  p-1  + hover:text-foreground
 *   popover   bg-popover     radius --radius-lg            (none)     p-4
 *
 * `bg-popover` is the resolved answer. In light mode `--popover` and
 * `--background` are both `oklch(1 0 0)`, so nothing moves; in dark mode
 * `--popover` is `oklch(0.1913)` against a `oklch(0.1398)` canvas, and
 * `globals.css` describes it as "top surface, separated by hairline + shadow" —
 * which is this element's entire job. On `bg-background` a dark-mode dropdown
 * was the same colour as the page behind it.
 *
 * Popover also had no shadow at all, so it sat flat on the canvas while the
 * menus lifted. `shadow-lg` for all of them.
 *
 * Four things are deliberately absent, because each is dictated by what the
 * panel holds rather than by what it is:
 *
 * - **Padding.** A list of rows uses `p-1` (see `MENU_PANEL`); a popover holds
 *   prose and controls and uses `p-4`.
 * - **Width.** Every menu call site passes its own (`w-40`, `w-48`, `w-64`),
 *   and `width` and `min-width` are separate tailwind-merge groups, so a shared
 *   `min-w-[14rem]` would survive and silently override a caller's `w-40`.
 * - **Overflow.** A context menu's root panel scrolls; the rest clip. `overflow`,
 *   `overflow-x` and `overflow-y` are three separate tailwind-merge groups, so a
 *   shared `overflow-hidden` would survive alongside a later `overflow-y-auto`
 *   and the winner would come down to Tailwind's generated property order.
 * - **Transform origin.** Anchored panels scale out of their trigger, and the
 *   Radix variable that carries it is named per primitive.
 *
 * No `hover:text-foreground` here either — select had it. On the panel it
 * recoloured every row at once whenever the pointer entered, fighting the
 * per-row hover the rows define themselves. Colour is a row concern.
 */
export const FLOATING_PANEL =
  'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 border-border rounded-[calc(var(--radius)+0.1rem)] border shadow-md  ease-out';

/** The floating surface holding a list of rows: dropdown, context menu, select. */
export const MENU_PANEL = cn(FLOATING_PANEL, 'p-1');

/** Group label: `px-2.5` matches the sm row, so labels and rows share a left edge. */
export const MENU_LABEL = 'text-muted-foreground px-2.5 py-1 text-xs font-medium tracking-normal';

export const MENU_SEPARATOR = 'bg-foreground/10 -mx-1 my-1 h-px';

export const MENU_SHORTCUT = 'ml-auto text-xs tracking-widest opacity-60';
