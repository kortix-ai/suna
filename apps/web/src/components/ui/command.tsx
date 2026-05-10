'use client';

import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import { SearchIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

// ─── Shared cmdk class overrides ─────────────────────────────────────────────
// Applied to the inner Command element in both CommandDialog and CommandPopover
// to ensure identical visual DNA across all command-palette surfaces.

const CMDK_SHARED_CLASSES = [
  // Group horizontal padding
  '[&_[cmdk-group]]:px-1.5',
  // Collapse padding between consecutive visible groups
  '[&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0',
].join(' ');

// ─── Primitives ──────────────────────────────────────────────────────────────

function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        'bg-transparent text-popover-foreground flex h-full w-full flex-col overflow-hidden rounded-xl',
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
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string;
  description?: string;
  className?: string;
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className={cn(
          'overflow-hidden p-0 gap-0',
          // Border + depth — subtle ring highlight at top-edge catches light
          'border border-border/60 rounded-2xl ring-1 ring-inset ring-white/[0.04]',
          // Solid popover background
          'bg-popover',
          // Subtle slide-in from above
          'data-[state=open]:slide-in-from-top-[2%] data-[state=closed]:slide-out-to-top-[2%]',
          // Bump items back up inside the cmd palette — items are
          // compact-by-default everywhere else, but this is the big
          // Cmd+K surface so it gets the roomier spec.
          '[&_[data-slot=command-item]]:gap-3 [&_[data-slot=command-item]]:rounded-lg [&_[data-slot=command-item]]:px-3 [&_[data-slot=command-item]]:py-2.5 [&_[data-slot=command-item]]:text-[13.5px]',
          "[&_[data-slot=command-item]_svg:not([class*='size-'])]:size-[17px]",
          className,
        )}
        hideCloseButton
      >
        <Command shouldFilter={false} className={CMDK_SHARED_CLASSES}>
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}

/**
 * CommandPopover — same visual DNA as CommandDialog but positioned as a popover.
 * Use for inline selectors (Agent, Model) that need command-palette-style UX.
 *
 * Renders Popover as a context provider so consumers can place PopoverTrigger
 * freely inside Tooltip chains without Slot/asChild conflicts.
 *
 * Usage:
 *   <CommandPopover open={open} onOpenChange={setOpen}>
 *     <Tooltip>
 *       <TooltipTrigger asChild>
 *         <CommandPopoverTrigger>
 *           <button>...</button>
 *         </CommandPopoverTrigger>
 *       </TooltipTrigger>
 *     </Tooltip>
 *     <CommandPopoverContent side="top" className="w-[300px]">
 *       <CommandInput compact ... />
 *       <CommandList>...</CommandList>
 *       <CommandFooter>...</CommandFooter>
 *     </CommandPopoverContent>
 *   </CommandPopover>
 */
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

/**
 * Trigger for CommandPopover — wraps PopoverTrigger with asChild.
 *
 * Important: this must forward Radix trigger props + refs. Components like
 * TooltipTrigger clone their child and inject event handlers / refs; the old
 * plain function component dropped those props, which could leave Radix in a
 * ref attach/detach loop on session surfaces that nest Tooltip + Popover.
 */
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

/** Content pane for CommandPopover — PopoverContent + Command with shared styling. */
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
        'w-[300px] p-0 overflow-hidden rounded-xl',
        // Same `bg-card` token as DropdownMenuContent — every dropdown in
        // the app sits on the same material. Hairline white inner border
        // and a 1px top-edge highlight gradient catch light like a real
        // slab. Always opaque (no transparency).
        'relative bg-card text-popover-foreground',
        'border border-border/60',
        'before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-white/[0.08] before:to-transparent',
        // Smoother, more macOS-like entrance / exit (zoom-in-95 → 97 so the
        // pop is gentler, cubic-bezier(0.16, 1, 0.3, 1) easing).
        'data-[state=open]:duration-[180ms] data-[state=closed]:duration-[140ms]',
        'data-[state=open]:zoom-in-[0.97] data-[state=closed]:zoom-out-[0.97]',
        // CommandItem is at natural roomy spec (matching DropdownMenuItem)
        // by default — no item overrides needed here. Just trim the
        // surrounding chrome (input + group / heading) so popovers don't
        // feel as cavernous as the Cmd+K palette.
        '[&_[data-slot=command-input-wrapper]]:h-9 [&_[data-slot=command-input-wrapper]]:px-3 [&_[data-slot=command-input-wrapper]]:gap-2',
        '[&_[data-slot=command-input]]:h-9 [&_[data-slot=command-input]]:text-[13px]',
        '[&_[data-slot=command-list]]:py-0',
        '[&_[data-slot=command-group]]:py-1',
        '[&_[cmdk-group-heading]]:!pt-2 [&_[cmdk-group-heading]]:!pb-1 [&_[cmdk-group-heading]]:!px-2 [&_[cmdk-group-heading]]:!text-[10px] [&_[cmdk-group-heading]]:!tracking-[0.12em]',
        className,
      )}
    >
      <Command shouldFilter={shouldFilter} className={CMDK_SHARED_CLASSES}>
        {children}
      </Command>
    </PopoverContent>
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
        'flex items-center border-b border-border/50',
        compact ? 'h-11 gap-2.5 px-3.5' : 'h-[58px] gap-3 px-5',
      )}
    >
      <SearchIcon
        className={cn(
          'shrink-0 text-muted-foreground/60',
          compact ? 'size-4' : 'size-[18px]',
        )}
      />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          'placeholder:text-muted-foreground/45 text-foreground flex w-full bg-transparent outline-hidden disabled:cursor-not-allowed disabled:opacity-50',
          compact ? 'h-11 text-[13px]' : 'h-[58px] text-[15px] tracking-[-0.005em]',
          className,
        )}
        {...props}
      />
      {rightElement}
    </div>
  );
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        'max-h-[min(60vh,480px)] scroll-py-2 overflow-x-hidden overflow-y-auto scrollbar-minimal py-1',
        className,
      )}
      {...props}
    />
  );
}

function CommandEmpty({
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="py-10 text-center text-sm text-muted-foreground/60"
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
        'text-foreground overflow-hidden py-1.5',
        '[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.1em] [&_[cmdk-group-heading]]:text-muted-foreground/50',
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
      className={cn('bg-border/40 mx-3 my-1 h-px', className)}
      {...props}
    />
  );
}

function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        // Matches the natural DropdownMenuItem spec (Billing / Settings
        // look) — same gap-2 rounded-lg px-2 py-1.5 text-sm size-4
        // icons. Both surfaces feel like one family. CommandDialog
        // (Cmd+K palette) bumps these back up via descendant rules.
        'relative flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-foreground/80 outline-hidden select-none transition-colors duration-75',
        'data-[selected=true]:bg-foreground/[0.06] data-[selected=true]:text-foreground',
        "data-[selected=true]:[&_svg:not([class*='text-'])]:text-foreground/80",
        "[&_svg:not([class*='text-'])]:text-muted-foreground/65",
        'data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-40',
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

// Pretty-print a shortcut token (e.g. "Ctrl" → "⌃", "Cmd" → "⌘", "Shift" → "⇧").
// Leaves letter/digit keys and anything unrecognized untouched.
const SHORTCUT_TOKEN_GLYPHS: Record<string, string> = {
  ctrl: '⌃',
  control: '⌃',
  cmd: '⌘',
  command: '⌘',
  meta: '⌘',
  shift: '⇧',
  alt: '⌥',
  option: '⌥',
  opt: '⌥',
  enter: '↵',
  return: '↵',
  esc: 'esc',
  escape: 'esc',
  tab: '⇥',
  backspace: '⌫',
  delete: '⌦',
  space: '␣',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
};

function formatShortcutToken(token: string): string {
  const key = token.trim().toLowerCase();
  return SHORTCUT_TOKEN_GLYPHS[key] ?? token.trim();
}

function CommandShortcut({
  className,
  children,
  ...props
}: React.ComponentProps<'span'>) {
  // Split "Ctrl+J" → ["Ctrl", "J"] so each key renders as its own chip.
  const tokens =
    typeof children === 'string'
      ? children.split('+').map((t) => t.trim()).filter(Boolean)
      : null;

  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        'ml-auto inline-flex items-center gap-1',
        className,
      )}
      {...props}
    >
      {tokens
        ? tokens.map((t, i) => (
            <kbd
              key={`${t}-${i}`}
              className="inline-flex items-center justify-center h-[18px] min-w-[18px] px-1.5 rounded-[5px] bg-foreground/[0.04] border border-border/40 text-[10.5px] font-medium text-muted-foreground/60 leading-none font-sans"
            >
              {formatShortcutToken(t)}
            </kbd>
          ))
        : children}
    </span>
  );
}

/**
 * Footer bar for command palette surfaces — shows keyboard hints.
 * Used identically in CommandDialog and CommandPopover.
 */
function CommandFooter({
  className,
  children,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="command-footer"
      className={cn(
        'flex items-center gap-4 border-t border-border/50 bg-foreground/[0.015] px-4 py-2.5 text-[11px] text-muted-foreground/55',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/** Inline keyboard hint badge — consistent across all command surfaces. */
function CommandKbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center h-[18px] min-w-[18px] px-1.5 rounded-[5px] bg-foreground/[0.04] border border-border/40 text-[10.5px] font-medium text-muted-foreground/60 leading-none font-sans">
      {children}
    </kbd>
  );
}

export {
  Command,
  CommandDialog,
  CommandPopover,
  CommandPopoverTrigger,
  CommandPopoverContent,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
  CommandFooter,
  CommandKbd,
};
