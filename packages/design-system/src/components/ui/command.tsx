'use client';

import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import { SearchIcon } from 'lucide-react';

import { cn } from '../../lib/utils';
import { MenuHighlight } from '../motion/menu-highlight';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './dialog';

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        'flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground',
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
  showCloseButton = false,
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
        className={cn(
          'overflow-hidden border border-border/40 bg-popover p-0 sm:max-w-[520px] sm:rounded-2xl',
          className,
        )}
        showCloseButton={showCloseButton}
      >
        <Command
          className={cn(
            'bg-popover',
            '[&_[cmdk-input-wrapper]]:h-12 [&_[cmdk-input-wrapper]]:px-4 [&_[cmdk-input-wrapper]]:gap-2.5',
            '[&_[cmdk-input-wrapper]_svg]:size-3.5 [&_[cmdk-input-wrapper]_svg]:text-muted-foreground/60 [&_[cmdk-input-wrapper]_svg]:opacity-100',
            '[&_[cmdk-input]]:h-12 [&_[cmdk-input]]:text-[14px] [&_[cmdk-input]]:font-sans',
            '[&_[cmdk-group]]:px-1.5 [&_[cmdk-group]]:pb-0.5',
            '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:font-sans [&_[cmdk-group-heading]]:text-[0.62rem] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.18em] [&_[cmdk-group-heading]]:text-muted-foreground/70',
            '[&_[cmdk-item]]:rounded-lg [&_[cmdk-item]]:px-2.5 [&_[cmdk-item]]:py-1.5 [&_[cmdk-item]]:gap-2.5 [&_[cmdk-item]]:font-sans [&_[cmdk-item]]:text-[0.875rem] [&_[cmdk-item]]:text-muted-foreground',
            "[&_[cmdk-item][data-selected='true']]:text-foreground",
            "[&_[cmdk-item][data-selected='true']_svg]:text-foreground",
            '[&_[cmdk-item]_svg]:size-3.5',
          )}
        >
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div
      data-slot="command-input-wrapper"
      cmdk-input-wrapper=""
      className="flex h-12 items-center gap-2.5 border-b border-border/40 px-4"
    >
      <SearchIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          'flex h-12 w-full bg-transparent font-sans text-[14px] outline-hidden placeholder:text-muted-foreground/60 disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        'relative max-h-[440px] scroll-py-2 overflow-x-hidden overflow-y-auto px-1 py-1.5',
        className,
      )}
      {...props}
    >
      <MenuHighlight
        highlightSelector="[data-selected='true']"
        className="rounded-lg bg-muted-foreground/10"
      />
      {children}
    </CommandPrimitive.List>
  );
}

function CommandEmpty({ ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="py-10 text-center font-sans text-sm text-muted-foreground"
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
      className={cn('overflow-hidden px-2 pb-1 text-foreground', className)}
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
      className={cn('mx-2 my-1 h-px bg-border/50', className)}
      {...props}
    />
  );
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "relative z-10 flex cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 py-1.5 font-sans text-[0.875rem] text-muted-foreground outline-hidden transition-colors data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-40 data-[selected=true]:text-foreground data-[selected=true]:[&_svg]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 [&_svg:not([class*='text-'])]:text-muted-foreground",
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
      className={cn('ml-auto flex items-center gap-1', className)}
      {...props}
    />
  );
}

function CommandFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="command-footer"
      className={cn(
        'flex items-center justify-between gap-4 border-t border-border/40 bg-muted/40 px-4 py-2 font-sans text-[0.68rem] text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
  CommandFooter,
};
