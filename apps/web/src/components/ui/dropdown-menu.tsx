'use client';

import { cn } from '@/lib/utils';
import { floatingZ, useDialogDepth } from '@/lib/z-stack';
import { CheckIcon as Check, CaretRightIcon as ChevronRight } from '@phosphor-icons/react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import * as React from 'react';
import {
  MENU_LABEL,
  MENU_PANEL,
  MENU_SEPARATOR,
  MENU_SHORTCUT,
  menuRow,
  type MenuRowSize,
} from './menu-recipe';
import { triggerVariants, type TriggerVariantProps } from './trigger-variants';

/**
 * The row recipe, the panel and the label/separator/shortcut classes live in
 * `./menu-recipe`, shared with `context-menu.tsx` — see that file for why the
 * four row components here (Item, SubTrigger, CheckboxItem, RadioItem) are no
 * longer allowed to style themselves.
 *
 * A dropdown is anchored to a trigger, so its panel is at least as wide as a
 * typical trigger. A right-click menu has no trigger width to match and floors
 * itself lower.
 */
const DROPDOWN_PANEL = cn(MENU_PANEL, 'min-w-[14rem] overflow-hidden');

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
>(({ className, side, align, sideOffset = 5, style, ...props }, ref) => {
  const depth = useDialogDepth();

  return (
    <DropdownMenuPrimitive.SubContent
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        DROPDOWN_PANEL,
        className,
        "rounded-lg",
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
        className={cn(DROPDOWN_PANEL, className)}
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
  /**
   * A check, not a dot, and the same check `DropdownMenuCheckboxItem` uses.
   *
   * This was `<Circle className="h-2 w-2 fill-current" />`, which could not
   * work: Phosphor's CircleIcon is a stroked outline, so `fill-current` painted
   * nothing, and `MENU_ROW_BASE`'s `[&_svg]:size-4` — a descendant selector —
   * outranked the `h-2 w-2` sitting on the icon itself. The mark rendered as a
   * hollow ring. No consumer had ever rendered a RadioItem, so nobody saw it.
   */
  const indicator = (
    <span className="flex size-3.5 shrink-0 items-center justify-center">
      <DropdownMenuPrimitive.ItemIndicator>
        <Check className="text-muted-foreground size-3.5" />
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
    className={cn(MENU_LABEL, inset && 'pl-8', className)}
    {...props}
  />
));
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator ref={ref} className={cn(MENU_SEPARATOR, className)} {...props} />
));
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;

const DropdownMenuShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => {
  return <span className={cn(MENU_SHORTCUT, className)} {...props} />;
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
