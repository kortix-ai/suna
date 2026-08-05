'use client';

import {
  MessageScroller as MessageScrollerPrimitive,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from '@shadcn/react/message-scroller';
import * as React from 'react';
// Phosphor, not lucide. `@phosphor-icons/react` is the only icon set in this
// app (see src/lib/icons); `session-chat.tsx` already imported `CaretDownIcon`
// for the FAB this button replaces, so the glyph is unchanged.
import { CaretDownIcon } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

function MessageScrollerProvider(
  props: React.ComponentProps<typeof MessageScrollerPrimitive.Provider>,
) {
  return <MessageScrollerPrimitive.Provider {...props} />;
}

function MessageScroller({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Root>) {
  return (
    <MessageScrollerPrimitive.Root
      data-slot="message-scroller"
      className={cn(
        'group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden',
        className,
      )}
      {...props}
    />
  );
}

function MessageScrollerViewport({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Viewport>) {
  return (
    <MessageScrollerPrimitive.Viewport
      data-slot="message-scroller-viewport"
      // `scrollbar-hide`, not the upstream `scroll-fade-b scrollbar-thin
      // scrollbar-gutter-stable ... data-autoscrolling:scrollbar-none`. None of
      // those four utilities exist in this app — globals.css loads only
      // `@plugin 'tailwind-scrollbar-hide'` — so upstream's set compiles to
      // nothing while silently promising a gutter and a fade. `scrollbar-hide`
      // is what the transcript's scroll container already used, so the
      // migration is pixel-identical.
      //
      // They also cannot be corrected from the call site: tailwind-merge has no
      // group for these custom utilities, so a `scrollbar-hide` passed in
      // `className` would be APPENDED to `scrollbar-thin`, not replace it.
      //
      // No `contain-content` either (upstream has it). `contain: content`
      // implies paint containment, which makes this element the containing
      // block for every `position: fixed` descendant. The transcript renders
      // arbitrary tool output, so that is a behavior change the migration has
      // no reason to take on.
      className={cn(
        'scrollbar-hide size-full min-h-0 min-w-0 overflow-y-auto overscroll-contain',
        className,
      )}
      {...props}
    />
  );
}

function MessageScrollerContent({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Content>) {
  return (
    <MessageScrollerPrimitive.Content
      data-slot="message-scroller-content"
      className={cn('flex h-max min-h-full flex-col gap-8', className)}
      {...props}
    />
  );
}

function MessageScrollerItem({
  className,
  scrollAnchor = false,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Item>) {
  return (
    <MessageScrollerPrimitive.Item
      data-slot="message-scroller-item"
      scrollAnchor={scrollAnchor}
      // `content-visibility: auto` + `contain-intrinsic-size` is upstream's own
      // windowing for a NON-virtualized list. A caller that is already
      // virtualized must override both — a ResizeObserver then measures the
      // 10rem placeholder instead of the row, and every measured height is a
      // lie. `cn` is tailwind-merge, and both are arbitrary properties, so a
      // `[content-visibility:visible] [contain-intrinsic-size:none]` in
      // `className` replaces them rather than stacking. See transcript-list.tsx.
      className={cn(
        'min-w-0 shrink-0 [contain-intrinsic-size:auto_10rem] [content-visibility:auto]',
        className,
      )}
      {...props}
    />
  );
}

function MessageScrollerButton({
  direction = 'end',
  className,
  children,
  render,
  variant = 'secondary',
  size = 'icon-sm',
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Button> &
  Pick<React.ComponentProps<typeof Button>, 'variant' | 'size'>) {
  return (
    <MessageScrollerPrimitive.Button
      data-slot="message-scroller-button"
      data-direction={direction}
      data-variant={variant}
      data-size={size}
      direction={direction}
      className={cn(
        // `start-1/2`, not upstream's `inset-s-1/2`. Tailwind v4 has no
        // `inset-s-*` utility, so that class compiled to nothing and the FAB
        // sat at the viewport's left edge with `-translate-x-1/2` pulling it
        // half off screen. `z-20` matches the FAB this replaces, which had to
        // outrank the minimap rail's `z-10`.
        'border-border bg-background text-foreground hover:bg-muted hover:text-foreground absolute start-1/2 z-20 -translate-x-1/2 transition-[translate,scale,opacity] duration-200 data-[active=false]:pointer-events-none data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=false]:duration-400 data-[active=false]:ease-[cubic-bezier(0.7,0,0.84,0)] data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100 data-[active=true]:ease-[cubic-bezier(0.23,1,0.32,1)] data-[direction=end]:bottom-4 data-[direction=end]:data-[active=false]:translate-y-full data-[direction=start]:top-4 data-[direction=start]:data-[active=false]:-translate-y-full rtl:translate-x-1/2 data-[direction=start]:[&_svg]:rotate-180',
        className,
      )}
      render={render ?? <Button variant={variant} size={size} />}
      {...props}
    >
      {children ?? (
        <>
          <CaretDownIcon className="size-4" />
          <span className="sr-only">
            {direction === 'end' ? 'Scroll to end' : 'Scroll to start'}
          </span>
        </>
      )}
    </MessageScrollerPrimitive.Button>
  );
}

export {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
};
