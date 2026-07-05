'use client';

// Vendored extend.ai viewers (e.g. pdf-viewer.tsx) are written against
// extend.ai's own `ScrollArea`, which wraps `@base-ui/react/scroll-area` and
// exposes a richer prop surface (`orientation`, `scrollFade`,
// `viewportClassName`, `viewportProps`, `viewportRef`) than this repo's
// shadcn/Radix-based `@/components/ui/scroll-area`. Rather than pull in
// `@base-ui/react` or widen the app-wide scroll-area component, this shim
// reimplements just the props the vendored viewers actually use on top of
// the `@radix-ui/react-scroll-area` primitive already used elsewhere in the
// app, so the vendor diff in pdf-viewer.tsx stays a single import swap.
import * as React from 'react';
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';

import { cn } from '@/lib/utils';

type ScrollAreaCompatProps = Omit<
  React.ComponentProps<typeof ScrollAreaPrimitive.Root>,
  'children'
> & {
  children?: React.ReactNode;
  orientation?: 'vertical' | 'horizontal' | 'both';
  /** Cosmetic-only in this shim (no CSS mask fade); accepted for API parity. */
  scrollFade?: boolean;
  viewportClassName?: string;
  viewportProps?: React.ComponentProps<typeof ScrollAreaPrimitive.Viewport>;
  viewportRef?: React.Ref<HTMLDivElement>;
};

export function ScrollArea({
  className,
  children,
  orientation = 'both',
  scrollFade: _scrollFade,
  viewportClassName,
  viewportProps,
  viewportRef,
  ...props
}: ScrollAreaCompatProps) {
  const { className: viewportPropsClassName, ...restViewportProps } = viewportProps ?? {};

  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn('relative overflow-hidden', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        {...restViewportProps}
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        className={cn(
          'focus-visible:ring-ring/50 size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:outline-1 [&>div]:!block',
          viewportPropsClassName,
          viewportClassName,
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {orientation !== 'horizontal' ? <ScrollBar orientation="vertical" /> : null}
      {orientation !== 'vertical' ? <ScrollBar orientation="horizontal" /> : null}
      {orientation === 'both' ? <ScrollAreaPrimitive.Corner /> : null}
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        'flex touch-none p-px transition-colors select-none',
        orientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent',
        orientation === 'horizontal' && 'h-2.5 flex-col border-t border-t-transparent',
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="bg-border relative flex-1 cursor-grab rounded-full active:cursor-grabbing"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}
