'use client';

import { Command as CommandPrimitive } from 'cmdk';
import { useTranslations } from '@/i18n/use-translations';
import * as React from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { floatingZ, useDialogDepth } from '@/lib/z-stack';
import { Kbd, KbdGroup } from './kbd';

const CMDK_SHARED_CLASSES = [
  '[&_[cmdk-group]]:px-1.5',
  '[&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0',
].join(' ');

/**
 * `data-nav` records which input moved the highlight last: `pointer` or
 * `keyboard`. `CommandItem` reads it to pick ONE highlight source.
 *
 * cmdk 0.2.1 selects a row on every `pointermove` through its store, so
 * `data-selected` moves only after React re-renders the whole list. In the ⌘K
 * palette that re-render trails the cursor: the row you left stays lit until
 * it lands, which reads as a hover transition. In pointer mode the row paints
 * from CSS `:hover` alone — the same instant highlight the sidebar session
 * rows use. Keyboard mode keeps `data-selected`, because arrow keys have no
 * `:hover` to follow.
 *
 * Written straight to the DOM node, not React state: a state update here would
 * re-render the list on every pointer move, which is the lag this removes.
 * cmdk calls a caller's `onKeyDown` before its own handler and spreads
 * `onPointerMove` onto the root, so both reach the same element.
 */
function Command({
  className,
  onKeyDown,
  onPointerMove,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        'bg-popover text-popover-foreground flex h-full w-full flex-col overflow-hidden rounded-md',
        className,
      )}
      onKeyDown={(event) => {
        event.currentTarget.dataset.nav = 'keyboard';
        onKeyDown?.(event);
      }}
      onPointerMove={(event) => {
        if (event.pointerType === 'mouse' || event.pointerType === 'pen') {
          event.currentTarget.dataset.nav = 'pointer';
        }
        onPointerMove?.(event);
      }}
      {...props}
    />
  );
}

function CommandDialog({
  title,
  description,
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
  const t = useTranslations('commandPalette');

  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title ?? t('title')}</DialogTitle>
        <DialogDescription>{description ?? t('description')}</DialogDescription>
      </DialogHeader>
      <DialogContent
        // `data-[state=closed]:animate-none!` on the panel AND the overlay: the
        // palette closes on the frame you dismiss it, with no exit animation.
        // `DialogContent` and `DialogOverlay` both play a 200ms `animate-out`
        // (fade, plus a zoom to 95% on the panel), and Radix Presence keeps the
        // node mounted until `animationend` — so Escape, a selected command,
        // or an outside click left the palette on screen for 200ms after it
        // was done. With `animation-name: none`, Presence unmounts at once.
        // `!` because tailwind-merge does not know `animate-out` (it comes from
        // tw-animate-css) and keeps both classes; without it, the winner would
        // be whichever utility Tailwind happens to emit last.
        //
        // `data-[state=open]:animate-none!` does the same for the way in. The
        // stock 200ms fade + zoom from 95% made ⌘K — opened dozens of times a
        // day, almost always from the keyboard — read as late and as growing
        // out of the page. The palette now paints complete on the first frame.
        className={cn(
          'p-0 shadow-[0_0_50px_0] shadow-black/10 data-[state=open]:animate-none! data-[state=closed]:animate-none! border',
          className,
        )}
        hideCloseButton={!showCloseButton}
        overlayClassName="bg-black/20 backdrop-blur-[1px] data-[state=open]:animate-none! data-[state=closed]:animate-none!"
      >
        {/* `loop`: ↑ on the first row lands on the last, ↓ on the last lands on
            the first — the list is a ring, so the far end is one key away. */}
        <Command
          loop
          className="[&_[cmdk-group-heading]]:text-muted-foreground bg-popover **:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12"
        >
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function CommandInput({
  className,
  compact,
  leftElement,
  rightElement,

  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & {
  compact?: boolean;
  /** Sits before the text field: a search glyph, or a sub-page's back chip. */
  leftElement?: React.ReactNode;
  rightElement?: React.ReactNode;
}) {
  return (
    <div
      data-slot="command-input-wrapper"
      className={cn(
        'border-border flex items-center border-b',
        compact ? 'h-11 gap-2.5 px-4' : 'h-10 gap-3 px-4',
      )}
    >
      {leftElement}
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          'placeholder:text-muted-foreground flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50',
          compact ? 'h-11' : 'h-10',
          className,
        )}
        {...props}
      />
      {rightElement}
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
        'text-foreground [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:text-foreground overflow-hidden p-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[13px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:tracking-normal',
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
      // `hover:` mirrors the cmdk `data-[selected=true]` styling on purpose:
      // cmdk paints its highlight from a JS pointermove -> select loop, and a
      // page where anything swallows pointermove (observed on dev.kortix.com)
      // renders NO hover feedback at all while clicks keep working. CSS :hover
      // is driven by browser hit-testing, so the row under the cursor is
      // always highlighted; when cmdk's pointer selection works the two states
      // coincide on the same row.
      //
      // `data-[selected=true]` is scoped to NOT pointer mode (`data-nav` on the
      // `Command` root — see there). With a mouse, `:hover` is the only
      // highlight, so it follows the cursor on the frame it moves instead of
      // waiting for cmdk's re-render. With the keyboard, `data-selected` is.
      // A caller that restyles the selected row must write the same
      // `[&:not([data-nav=pointer]_*)]:data-[selected=true]:` prefix, so
      // tailwind-merge replaces this class instead of stacking a second one.
      className={cn(
        // `bg-hover`: the fill of a project sidebar session row on hover.
        // That row paints `--card` on the canvas; in light mode `--hover`
        // (ink @ 4.5%) over the white popover blends to the same #f3f3f3–
        // #f4f4f4. `bg-card` itself cannot be used here: dark-theme `--card`
        // and `--accent` ARE `--popover` (all surface-1), so it would paint
        // invisibly on this panel. `--hover` is translucent ink, so it reads
        // on any surface in both themes. It replaced `bg-primary/10`, which
        // read too dark next to the sidebar rows.
        'hover:bg-hover hover:text-foreground transition-none',
        '[&:not([data-nav=pointer]_*)]:data-[selected=true]:bg-hover [&:not([data-nav=pointer]_*)]:data-[selected=true]:text-foreground',
        "[&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Rich hover detail for a `CommandItem` — wrap the item, pass the detail as
 * `content`, and a card floats out beside the row after a short hover (or on
 * keyboard focus). Renders the bare item untouched when `content` is empty,
 * so callers can wrap every row and only rows with something to say get a
 * card. Unlike the stock `HoverCardContent` (`z-50`), this one stacks via the
 * dialog z-ladder, so it stays ABOVE the command popover it lives in.
 */
function CommandItemHoverCard({
  content,
  side = 'right',
  align = 'start',
  sideOffset = 4,
  openDelay = 150,
  closeDelay = 100,
  className,
  children,
}: {
  content: React.ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  openDelay?: number;
  closeDelay?: number;
  className?: string;
  children: React.ReactNode;
}) {
  const depth = useDialogDepth();
  if (!content) return <>{children}</>;
  return (
    <HoverCard openDelay={openDelay} closeDelay={closeDelay}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        data-slot="command-item-hover-card"
        side={side}
        align={align}
        sideOffset={sideOffset}
        style={{ zIndex: floatingZ(depth) + 1 }}
        className={cn('w-60 rounded-md border p-3 shadow-md', className)}
      >
        {content}
      </HoverCardContent>
    </HoverCard>
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
        'text-muted-foreground flex items-center gap-4 border-t px-4 py-2 text-xs',
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
        'bg-sidebar text-sidebar-foreground hover:text-foreground relative w-[300px] overflow-hidden rounded-lg border p-0 shadow-xs ease-out',
        'border-border',
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
  CommandItemHoverCard,
  CommandKbd,
  CommandList,
  CommandPopover,
  CommandPopoverContent,
  CommandPopoverTrigger,
  CommandSeparator,
  CommandShortcut,
};
