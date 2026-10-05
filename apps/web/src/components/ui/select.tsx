'use client';

import { cn } from '@/lib/utils';
import { floatingZ, useDialogDepth } from '@/lib/z-stack';
import {
  CheckIcon as Check,
  CaretDownIcon as ChevronDown,
  CaretUpIcon as ChevronUp,
} from '@phosphor-icons/react';
import * as SelectPrimitive from '@radix-ui/react-select';
import * as React from 'react';
import {
  MENU_INDICATOR,
  MENU_INDICATOR_ICON,
  MENU_INSET_END,
  MENU_LABEL,
  MENU_PANEL_STATIC,
  MENU_SEPARATOR,
  menuRow,
  type MenuRowSize,
} from './menu-recipe';
import {
  TRIGGER_CARET_CLASS,
  TRIGGER_ICON_SIZE,
  triggerVariants,
  type TriggerVariantProps,
} from './trigger-variants';

/**
 * A select is a menu: the same floating surface holding the same rows, and it
 * shares both with the dropdown and context menu through `./menu-recipe`.
 *
 * Local to a select: `max-h-96` plus the scroll buttons, because the option
 * list is data-length and a dropdown's is authored; and `min-w-56`, because a
 * select is anchored to a trigger it should not visibly undercut.
 *
 * No enter/exit animation, the same as `DropdownMenuContent`: the list paints
 * on the frame it mounts and unmounts on the frame it closes. See
 * `dropdown-menu.tsx` for why.
 */
const SELECT_PANEL = cn(MENU_PANEL_STATIC, 'max-h-96 min-w-56 overflow-hidden');

const Select = SelectPrimitive.Root;

const SelectGroup = SelectPrimitive.Group;

const SelectValue = SelectPrimitive.Value;

export type SelectTriggerProps = Omit<
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>,
  'size'
> &
  TriggerVariantProps & {
    arrow?: boolean;
  };

const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  SelectTriggerProps
>(({ className, children, variant, size, arrow = true, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(triggerVariants({ variant, size }), className)}
    {...props}
  >
    {children}
    {arrow && (
      <SelectPrimitive.Icon asChild>
        <ChevronDown className={cn(TRIGGER_CARET_CLASS, TRIGGER_ICON_SIZE[size ?? 'sm'])} />
      </SelectPrimitive.Icon>
    )}
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectScrollUpButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollUpButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton
    ref={ref}
    className={cn(
      'flex cursor-default items-center justify-center py-1', // cursor-default: hover-scroll area, not a control.
      className,
    )}
    {...props}
  >
    <ChevronUp className="size-4" />
  </SelectPrimitive.ScrollUpButton>
));
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName;

const SelectScrollDownButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollDownButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton
    ref={ref}
    className={cn(
      'flex cursor-default items-center justify-center py-1', // cursor-default: hover-scroll area, not a control.
      className,
    )}
    {...props}
  >
    <ChevronDown className="size-4" />
  </SelectPrimitive.ScrollDownButton>
));
SelectScrollDownButton.displayName = SelectPrimitive.ScrollDownButton.displayName;

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = 'popper', style, ...props }, ref) => {
  const depth = useDialogDepth();

  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        className={cn(
          SELECT_PANEL,
          position === 'popper' &&
            'data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1',
          className,
        )}
        style={{ zIndex: floatingZ(depth), ...style }}
        position={position}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            position === 'popper' &&
              'h-(--radix-select-trigger-height) w-full min-w-[calc(var(--radix-select-trigger-width)-8px)]',
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectLabel = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
  // Was `pl-8 text-sm font-semibold` — the `pl-8` reserved a left gutter for a
  // leading check that this select does not have (its indicator is at
  // `right-3`), so the label sat indented past every option under it.
  <SelectPrimitive.Label ref={ref} className={cn(MENU_LABEL, className)} {...props} />
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;

const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item> & {
    /** Row height step — see `MENU_ROW_SIZE` in `./menu-recipe`. */
    size?: MenuRowSize;
    /** Renders below children in the dropdown only — not in the trigger. */
    description?: React.ReactNode;
  }
>(({ className, children, size = 'sm', description, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    // `MENU_INSET_END` reserves the trailing slot on every row, checked or
    // not, so a long label truncates before the check instead of running
    // under it, and the check column is the same x on every row.
    className={cn(
      menuRow(size, 'default'),
      MENU_INSET_END,
      description && 'items-start',
      className,
    )}
    {...props}
  >
    <span
      data-slot="select-item-indicator"
      // Absolute inside a flex row: its static position follows the row's
      // `items-*`, so it centres on a one-line row. On a described row it tops
      // out, and `mt-0.5` centres the ~15px slot on the 20px first line.
      className={cn(MENU_INDICATOR, 'absolute right-2', description && 'mt-0.5')}
    >
      <SelectPrimitive.ItemIndicator>
        <Check className={MENU_INDICATOR_ICON} />
      </SelectPrimitive.ItemIndicator>
    </span>

    {description ? (
      <div className="flex min-w-0 flex-col gap-0.5">
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        <span className="text-muted-foreground max-w-64 text-xs whitespace-normal">
          {description}
        </span>
      </div>
    ) : (
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    )}
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

const SelectSeparator = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator ref={ref} className={cn(MENU_SEPARATOR, className)} {...props} />
));
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
