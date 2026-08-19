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
import { MENU_LABEL, MENU_PANEL, MENU_SEPARATOR, menuRow, type MenuRowSize } from './menu-recipe';
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
 */
const SELECT_PANEL = cn(MENU_PANEL, 'max-h-96 min-w-56 overflow-hidden');

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
    className={cn('flex cursor-default items-center justify-center py-1', className)}
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
    className={cn('flex cursor-default items-center justify-center py-1', className)}
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
            // 'p-1',
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
    /**
     * `md` (`px-3 py-2`) is the select's default rather than the dropdown's
     * `sm`: an option is a form target the pointer travels to, not an action in
     * a menu the pointer is already inside. Same scale, one step apart.
     */
    size?: MenuRowSize;
    /** Renders below children in the dropdown only — not in the trigger. */
    description?: React.ReactNode;
  }
  // The removed `variant="secondary"` had no call sites in the app. It carried
  // its own radius (`rounded-[0.4rem]`), its own padding and `transition-all
  // duration-500`, so any row that ever used it would have broken the column.
>(({ className, children, size = 'md', description, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      menuRow(size, 'default'),
      description &&
        'items-start [&>[data-slot=select-item-indicator]]:top-2 [&>[data-slot=select-item-indicator]]:translate-y-0',
      className,
    )}
    {...props}
  >
    <span
      data-slot="select-item-indicator"
      className="absolute right-3 flex h-3.5 w-3.5 items-center justify-center"
    >
      <SelectPrimitive.ItemIndicator>
        <Check className="size-4 shrink-0" />
      </SelectPrimitive.ItemIndicator>
    </span>

    {description ? (
      <div className="flex min-w-0 flex-col gap-0.5">
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        <span className="text-muted-foreground max-w-[260px] text-[11px] leading-snug whitespace-normal">
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
