'use client';

import { Command as CommandPrimitive } from 'cmdk';
import * as React from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { Kbd, KbdGroup } from './kbd';

const CMDK_SHARED_CLASSES = [
  '[&_[cmdk-group]]:px-1.5',
  '[&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0',
].join(' ');

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        'bg-popover text-popover-foreground flex h-full w-full flex-col overflow-hidden rounded-md',
        className,
      )}
      {...props}
    />
  );
}

function CommandDialog({
  title = 'Command Palette',
  description = 'Search for a command to run...',
  children,
  className,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string;
  description?: string;
  className?: string;
  showCloseButton?: boolean;
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className={cn('p-0 shadow-[0_0_24px_0] shadow-black/50', className)}
        hideCloseButton={!showCloseButton}
        overlayClassName="bg-black/40 backdrop-blur-[1px]"
      >
        <Command className="[&_[cmdk-group-heading]]:text-muted-foreground **:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 bg-popover [&_[cmdk-input]]:h-12">
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function CommandInput({
  className,
  compact,
  rightElement,

  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & {
  compact?: boolean;
  rightElement?: React.ReactNode;
}) {
  return (
    <div
      data-slot="command-input-wrapper"
      className={cn(
        'border-border/50 flex items-center border-b',
        compact ? 'h-11 gap-2.5 px-4' : 'h-9 gap-3 px-4',
      )}
    >
      {/* <SearchIcon className="size-4 shrink-0 opacity-50" /> */}
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          'placeholder:text-muted-foreground flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50',
          compact ? 'h-11' : 'h-10',
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn('max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto', className)}
      {...props}
    />
  );
}

function CommandEmpty({ ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="py-6 text-center text-sm"
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        'text-foreground [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:text-foreground overflow-hidden p-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[13px] [&_[cmdk-group-heading]]:font-medium',
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn('bg-border -mx-1 h-px', className)}
      {...props}
    />
  );
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function CommandShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn('text-muted-foreground ml-auto text-xs tracking-widest', className)}
      {...props}
    />
  );
}

function CommandFooter({ className, children, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="command-footer"
      className={cn(
        'text-muted-foreground flex items-center gap-4 border-t px-4 py-3 text-xs',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

function CommandKbd({ children }: { children: React.ReactNode }) {
  return (
    <KbdGroup>
      <Kbd>{children}</Kbd>
    </KbdGroup>
  );
}

function CommandPopover({
  open,
  onOpenChange,
  children,
  modal = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  modal?: boolean;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange} modal={modal}>
      {children}
    </Popover>
  );
}

const CommandPopoverTrigger = React.forwardRef<
  React.ElementRef<typeof PopoverTrigger>,
  Omit<React.ComponentPropsWithoutRef<typeof PopoverTrigger>, 'asChild'>
>(function CommandPopoverTrigger({ children, ...props }, ref) {
  return (
    <PopoverTrigger ref={ref} asChild {...props}>
      {children}
    </PopoverTrigger>
  );
});

function CommandPopoverContent({
  children,
  side = 'top',
  align = 'start',
  sideOffset = 8,
  className,
  shouldFilter = false,
}: {
  children: React.ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  className?: string;
  shouldFilter?: boolean;
}) {
  return (
    <PopoverContent
      side={side}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        'w-[300px] overflow-hidden rounded-2xl p-0',
        'bg-card text-popover-foreground relative',
        'border-border/60 border',
        'before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-white/[0.08] before:to-transparent',
        'data-[state=closed]:duration-[140ms] data-[state=open]:duration-[180ms]',
        'data-[state=open]:zoom-in-[0.97] data-[state=closed]:zoom-out-[0.97]',
        '[&_[data-slot=command-input-wrapper]]:h-9 [&_[data-slot=command-input-wrapper]]:gap-2 [&_[data-slot=command-input-wrapper]]:px-3',
        '[&_[data-slot=command-input]]:h-9 [&_[data-slot=command-input]]:text-sm',
        '[&_[data-slot=command-list]]:py-0',
        '[&_[data-slot=command-group]]:py-1',
        '[&_[cmdk-group-heading]]:!px-2 [&_[cmdk-group-heading]]:!pt-2 [&_[cmdk-group-heading]]:!pb-1 [&_[cmdk-group-heading]]:!text-xs [&_[cmdk-group-heading]]:!tracking-[0.12em]',
        className,
      )}
    >
      <Command shouldFilter={shouldFilter} className={CMDK_SHARED_CLASSES}>
        {children}
      </Command>
    </PopoverContent>
  );
}

export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandKbd,
  CommandList,
  CommandPopover,
  CommandPopoverContent,
  CommandPopoverTrigger,
  CommandSeparator,
  CommandShortcut,
};
