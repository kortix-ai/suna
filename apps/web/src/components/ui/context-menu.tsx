'use client';

import { CheckIcon as Check, CaretRightIcon as ChevronRight } from '@phosphor-icons/react';
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';
import * as React from 'react';

import { cn } from '@/lib/utils';
import { floatingZ, useDialogDepth } from '@/lib/z-stack';
import {
  MENU_LABEL,
  MENU_PANEL,
  MENU_SEPARATOR,
  MENU_SHORTCUT,
  menuRow,
  type MenuRowSize,
} from './menu-recipe';

/**
 * A right-click menu is the same menu as a click menu. It shares the row
 * recipe, panel, label, separator and shortcut in `./menu-recipe` with
 * `dropdown-menu.tsx`, so a `Rename` row looks identical whichever way the
 * user reached it. Before this, the two menus disagreed on radius (sm vs md),
 * horizontal padding (2 vs 2.5), highlight colour (`accent` vs `primary/10`)
 * and resting text colour — and the file browser shows both.
 *
 * Three things stay local, because they are genuinely different:
 *
 * 1. **Width floor** — a dropdown matches its trigger, so it floors at 14rem.
 *    A context menu opens at the pointer with nothing to match, and every call
 *    site here passes its own width (`w-40`, `w-48`, `w-64`). A 14rem floor
 *    would override `w-40`, so this menu floors at 8rem.
 *
 * 2. **Transform origin** — the panel scales out of the point that was
 *    right-clicked (`--radix-context-menu-content-transform-origin`) rather
 *    than its own centre. The menu appearing to grow from the cursor is the
 *    whole spatial story of a context menu.
 *
 * 3. **Scroll** — `Content` caps at the available viewport height and scrolls,
 *    while `SubContent` clips like a dropdown. A context menu opened near the
 *    bottom edge of the window has no room to grow downward; clipping it would
 *    hide the last rows with no way to reach them.
 *
 * No trigger styling. `DropdownMenuTrigger` applies `triggerVariants` because
 * a dropdown trigger is a button; a context-menu trigger is the region you
 * right-click and must stay visually untouched.
 */
const CONTEXT_PANEL = cn(
  MENU_PANEL,
  'min-w-[8rem] origin-(--radix-context-menu-content-transform-origin)',
);

const ContextMenu = ContextMenuPrimitive.Root;

const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

const ContextMenuPortal = ContextMenuPrimitive.Portal;

const ContextMenuSub = ContextMenuPrimitive.Sub;

const ContextMenuRadioGroup = ContextMenuPrimitive.RadioGroup;

const ContextMenuGroup = ContextMenuPrimitive.Group;

/**
 * Takes the same `size` and `inset` props as `ContextMenuItem`, because a
 * submenu trigger is a row like any other and has to line up with its siblings.
 *
 * The caret is `size-3.5` against the leading icon's `size-4`: it is an
 * affordance, not content, and matching the icon's weight makes it compete with
 * the label. `text-muted-foreground` for the same reason.
 */
const ContextMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger> & {
    inset?: boolean;
    size?: MenuRowSize;
  }
>(({ className, inset, size = 'sm', children, ...props }, ref) => (
  <ContextMenuPrimitive.SubTrigger
    ref={ref}
    data-slot="context-menu-sub-trigger"
    className={cn(menuRow(size, 'default'), inset && 'pl-8', className)}
    {...props}
  >
    {children}
    <ChevronRight className="text-muted-foreground ml-auto size-3.5" />
  </ContextMenuPrimitive.SubTrigger>
));
ContextMenuSubTrigger.displayName = ContextMenuPrimitive.SubTrigger.displayName;

const ContextMenuSubContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>
  // `sideOffset={4}` matches the dropdown. Radix defaults a submenu to 0, which
  // butts the two panels edge to edge and reads as one wider panel with a seam
  // down it; 4px of daylight keeps them legible as parent and child. Radix's
  // safe-polygon pointer tracking covers the gap, so the submenu does not close
  // while the cursor crosses it.
>(({ className, sideOffset = 4, style, ...props }, ref) => {
  const depth = useDialogDepth();

  return (
    <ContextMenuPrimitive.SubContent
      ref={ref}
      sideOffset={sideOffset}
      data-slot="context-menu-sub-content"
      className={cn(CONTEXT_PANEL, 'overflow-hidden', className)}
      style={{ zIndex: floatingZ(depth), ...style }}
      {...props}
    />
  );
});
ContextMenuSubContent.displayName = ContextMenuPrimitive.SubContent.displayName;

const ContextMenuContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, style, ...props }, ref) => {
  const depth = useDialogDepth();

  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        ref={ref}
        data-slot="context-menu-content"
        className={cn(
          CONTEXT_PANEL,
          'max-h-(--radix-context-menu-content-available-height) overflow-x-hidden overflow-y-auto',
          className,
        )}
        style={{ zIndex: floatingZ(depth), ...style }}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
});
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName;

const ContextMenuItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
    inset?: boolean;
    variant?: 'default' | 'destructive';
    size?: MenuRowSize;
  }
>(({ className, inset, variant = 'default', size = 'sm', ...props }, ref) => (
  <ContextMenuPrimitive.Item
    ref={ref}
    data-slot="context-menu-item"
    className={cn(menuRow(size, variant), inset && 'pl-8', className)}
    {...props}
  />
));
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName;

const ContextMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.CheckboxItem> & {
    reverse?: boolean;
    size?: MenuRowSize;
  }
>(({ className, children, checked, reverse, size = 'sm', ...props }, ref) => (
  <ContextMenuPrimitive.CheckboxItem
    ref={ref}
    data-slot="context-menu-checkbox-item"
    // The check sits in the row's own padding rather than pushing the label
    // across, so a checkbox row's text starts on the same line as a plain
    // item's — `pl-8` on top of `px-2.5` would indent it past every neighbour.
    className={cn(menuRow(size, 'default'), reverse ? 'pr-7' : 'pl-7', className)}
    checked={checked}
    {...props}
  >
    <span
      className={cn(
        'absolute flex size-3.5 items-center justify-center',
        reverse ? 'right-2.5' : 'left-2.5',
      )}
    >
      <ContextMenuPrimitive.ItemIndicator>
        <Check className="text-muted-foreground size-3.5" />
      </ContextMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </ContextMenuPrimitive.CheckboxItem>
));
ContextMenuCheckboxItem.displayName = ContextMenuPrimitive.CheckboxItem.displayName;

const ContextMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.RadioItem> & {
    size?: MenuRowSize;
    side?: 'left' | 'right';
  }
>(({ className, children, size = 'sm', side = 'right', ...props }, ref) => {
  /**
   * A check, not a dot, and the same check `ContextMenuCheckboxItem` uses.
   *
   * This was `<CircleIcon className="size-2 fill-current" />`, which could not
   * work: Phosphor's CircleIcon is a stroked outline, so `fill-current` painted
   * nothing, and the row recipe's `[&_svg]:size-4` — a descendant selector —
   * outranked the `size-2` sitting on the icon itself. The mark rendered as a
   * hollow ring. No consumer renders a RadioItem, so nobody saw it.
   */
  const indicator = (
    <span className="flex size-3.5 shrink-0 items-center justify-center">
      <ContextMenuPrimitive.ItemIndicator>
        <Check className="text-muted-foreground size-3.5" />
      </ContextMenuPrimitive.ItemIndicator>
    </span>
  );

  return (
    <ContextMenuPrimitive.RadioItem
      ref={ref}
      data-slot="context-menu-radio-item"
      className={cn(menuRow(size, 'default'), className)}
      {...props}
    >
      {side === 'left' ? (
        <>
          {indicator}
          <span className="min-w-0 flex-1">{children}</span>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1">{children}</span>
          {indicator}
        </>
      )}
    </ContextMenuPrimitive.RadioItem>
  );
});
ContextMenuRadioItem.displayName = ContextMenuPrimitive.RadioItem.displayName;

const ContextMenuLabel = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Label> & {
    inset?: boolean;
  }
>(({ className, inset, ...props }, ref) => (
  <ContextMenuPrimitive.Label
    ref={ref}
    data-slot="context-menu-label"
    className={cn(MENU_LABEL, inset && 'pl-8', className)}
    {...props}
  />
));
ContextMenuLabel.displayName = ContextMenuPrimitive.Label.displayName;

const ContextMenuSeparator = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Separator
    ref={ref}
    data-slot="context-menu-separator"
    className={cn(MENU_SEPARATOR, className)}
    {...props}
  />
));
ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName;

const ContextMenuShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => {
  return (
    <span data-slot="context-menu-shortcut" className={cn(MENU_SHORTCUT, className)} {...props} />
  );
};
ContextMenuShortcut.displayName = 'ContextMenuShortcut';

export {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuPortal,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
};
