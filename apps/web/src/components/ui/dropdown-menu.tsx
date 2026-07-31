'use client';

import { cn } from '@/lib/utils';
import { floatingZ, useDialogDepth } from '@/lib/z-stack';
// import { CaretRightIcon as ChevronRight, CircleIcon as Circle } from '@phosphor-icons/react';
import {
  CheckIcon as Check,
  CaretRightIcon as ChevronRight,
  CircleIcon as Circle,
} from '@phosphor-icons/react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import * as React from 'react';
import { triggerVariants, type TriggerVariantProps } from './trigger-variants';

/**
 * ONE recipe for every row in a dropdown.
 *
 * Four different components render a "row" here — Item, SubTrigger,
 * CheckboxItem and RadioItem — and each used to hardcode its own spacing,
 * radius, focus colour, type and transition. They had drifted, so which
 * component you reached for silently changed how the row looked:
 *
 *   Item          rounded-md  px-2.5 py-1.5  focus:bg-border/50   text-foreground/80
 *   SubTrigger    rounded-sm  px-2   py-1.5  focus:bg-accent      (inherited colour)
 *   CheckboxItem  rounded-sm  pl-8   py-1.5  focus:bg-accent      (inherited colour)
 *   RadioItem     rounded-sm  px-2   py-1.5  focus:bg-accent      (inherited colour)
 *
 * A submenu trigger therefore sat 2px left of its sibling items, with a
 * different corner and a different text colour — a menu mixing the two could
 * never line its icons up in one column.
 *
 * Two further bugs this closes:
 *
 * 1. The size prop's font-size was dead. `size="sm"` set `text-xs`, but the
 *    `variant === 'default'` clause that ran after it set `text-sm`, and
 *    tailwind-merge takes the last one. So default rows ignored their size's
 *    type while destructive rows — which set no font-size — honoured it. A
 *    `variant="destructive" size="sm"` row rendered 12px next to its 14px
 *    neighbours. That is why "Log out" looked smaller than every row above it.
 *
 * 2. `transition-all duration-500`. `transition-all` animates every animatable
 *    property on a state change instead of the one that actually moves, and
 *    half a second is far past the budget for a menu opened dozens of times a
 *    day — the hover highlight visibly trailed the cursor. Colour only, 150ms.
 */
type MenuRowSize = 'sm' | 'md' | 'lg';
type MenuRowTone = 'default' | 'destructive';

/** Padding and type per step. Radius and gap stay fixed so columns line up. */
const MENU_ROW_SIZE: Record<MenuRowSize, string> = {
  sm: 'px-2.5 py-1.5 text-sm',
  md: 'px-3 py-2 text-sm',
  lg: 'px-3.5 py-2.5 text-base',
};

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
function menuRow(size: MenuRowSize, tone: MenuRowTone, className?: string) {
  return cn(MENU_ROW_BASE, MENU_ROW_SIZE[size], MENU_ROW_TONE[tone], className);
}

/**
 * Shared by Content and SubContent — a submenu panel should be indistinguishable
 * from the menu that opened it.
 *
 * `hover:text-foreground` used to sit here, on the panel. Hovering anywhere in
 * the menu recoloured every row at once, fighting the per-row hover the rows
 * define themselves. Removed; colour is a row concern.
 */
const MENU_PANEL =
  'bg-background text-sidebar-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 border-border min-w-[14rem] overflow-hidden rounded-[calc(var(--radius)+0.2rem)] border p-1 shadow-lg ease-out';

const DropdownMenu = DropdownMenuPrimitive.Root;

const DropdownMenuTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Trigger>,
  Omit<React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Trigger>, 'size'> &
    TriggerVariantProps
>(({ className, variant, size, asChild, ...props }, ref) => (
  <DropdownMenuPrimitive.Trigger
    ref={ref}
    asChild={asChild}
    // With `asChild` the child owns its styling — merging ours would double it.
    className={asChild ? className : cn(triggerVariants({ variant, size }), className)}
    {...props}
  />
));
DropdownMenuTrigger.displayName = DropdownMenuPrimitive.Trigger.displayName;

const DropdownMenuGroup = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Group>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Group ref={ref} className={cn('p-1', className)} {...props} />
));
DropdownMenuGroup.displayName = DropdownMenuPrimitive.Group.displayName;

const DropdownMenuPortal = DropdownMenuPrimitive.Portal;

const DropdownMenuSub = DropdownMenuPrimitive.Sub;

const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

/**
 * Takes the same `size` and `inset` props as `DropdownMenuItem`, because a
 * submenu trigger is a row like any other and has to line up with its siblings.
 *
 * The caret is `size-3.5` against the leading icon's `size-4`: it is an
 * affordance, not content, and matching the icon's weight makes it compete with
 * the label. `text-muted-foreground` for the same reason.
 */
const DropdownMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> & {
    inset?: boolean;
    size?: MenuRowSize;
  }
>(({ className, inset, size = 'sm', children, ...props }, ref) => (
  <DropdownMenuPrimitive.SubTrigger
    ref={ref}
    className={cn('group', menuRow(size, 'default'), inset && 'pl-8', className)}
    {...props}
  >
    {children}
    <ChevronRight className="text-muted-foreground ml-auto size-3.5" />
  </DropdownMenuPrimitive.SubTrigger>
));
DropdownMenuSubTrigger.displayName = DropdownMenuPrimitive.SubTrigger.displayName;

const DropdownMenuSubContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubContent>,
  Omit<React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>, 'align'> & {
    side?: 'top' | 'bottom' | 'left' | 'right';
    align?: 'start' | 'center' | 'end';
  }
>(({ className, side, align, sideOffset = 4, style, ...props }, ref) => {
  const depth = useDialogDepth();

  return (
    <DropdownMenuPrimitive.SubContent
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        MENU_PANEL,
        className,
        side === 'top' && 'data-[side=top]:slide-in-from-bottom-2',
        side === 'bottom' && 'data-[side=bottom]:slide-in-from-top-2',
        side === 'left' && 'data-[side=left]:slide-in-from-right-2',
        side === 'right' && 'data-[side=right]:slide-in-from-left-2',
        align === 'start' && 'data-[align=start]:slide-in-from-end-2',
        align === 'center' && 'data-[align=center]:slide-in-from-center-2',
        align === 'end' && 'data-[align=end]:slide-in-from-start-2',
      )}
      style={{ zIndex: floatingZ(depth), ...style }}
      {...props}
    />
  );
});
DropdownMenuSubContent.displayName = DropdownMenuPrimitive.SubContent.displayName;

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, style, ...props }, ref) => {
  const depth = useDialogDepth();

  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(MENU_PANEL, className)}
        style={{ zIndex: floatingZ(depth), ...style }}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
});
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
    inset?: boolean;
    variant?: 'default' | 'destructive';
    size?: 'sm' | 'md' | 'lg';
  }
>(({ className, inset, variant = 'default', size = 'sm', ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(menuRow(size, variant), inset && 'pl-8', className)}
    {...props}
  />
));
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

const DropdownMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem> & {
    reverse?: boolean;
    size?: MenuRowSize;
  }
>(({ className, children, checked, reverse, size = 'sm', ...props }, ref) => (
  <DropdownMenuPrimitive.CheckboxItem
    ref={ref}
    // The check sits in the row's own padding rather than pushing the label
    // across, so a checkbox row's text starts on the same line as a plain
    // item's — `pl-8` on top of `px-2.5` would indent it past every neighbour.
    className={cn(menuRow(size, 'default'), reverse ? 'pr-7' : 'pl-7', 'relative', className)}
    checked={checked}
    {...props}
  >
    <span
      className={cn(
        'absolute flex size-3.5 items-center justify-center',
        reverse ? 'right-2.5' : 'left-2.5',
      )}
    >
      <DropdownMenuPrimitive.ItemIndicator>
        <Check className="text-muted-foreground size-3.5" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = DropdownMenuPrimitive.CheckboxItem.displayName;

const DropdownMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
  // `size` used to be 'default' | 'sm' | 'lg' here while every sibling row used
  // 'sm' | 'md' | 'lg' — the same prop name meaning two different scales, where
  // RadioItem's "sm" meant denser-than-normal and Item's "sm" meant normal. No
  // consumer passed it, so it is now the one shared scale.
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem> & {
    size?: MenuRowSize;
    side?: 'left' | 'right';
  }
>(({ className, children, size = 'sm', side = 'right', ...props }, ref) => {
  const indicator = (
    <span className="flex size-3.5 shrink-0 items-center justify-center">
      <DropdownMenuPrimitive.ItemIndicator>
        <Circle className="h-2 w-2 fill-current" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
  );

  return (
    <DropdownMenuPrimitive.RadioItem
      ref={ref}
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
    </DropdownMenuPrimitive.RadioItem>
  );
});
DropdownMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName;

const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & {
    inset?: boolean;
  }
>(({ className, inset, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    // px-2.5 matches the sm row's horizontal padding, so a group label sits on
    // the same left edge as the rows beneath it. `text-[13px]` was an arbitrary
    // one-off; named steps only.
    className={cn(
      'text-muted-foreground px-2.5 py-1 text-xs font-medium tracking-normal',
      inset && 'pl-8',
      className,
    )}
    {...props}
  />
));
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    className={cn('bg-foreground/10 -mx-1 my-1 h-px', className)}
    {...props}
  />
));
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;

const DropdownMenuShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => {
  return (
    <span className={cn('ml-auto text-xs tracking-widest opacity-60', className)} {...props} />
  );
};
DropdownMenuShortcut.displayName = 'DropdownMenuShortcut';

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
};
