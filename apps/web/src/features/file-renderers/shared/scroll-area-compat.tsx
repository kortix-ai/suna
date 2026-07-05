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
  /**
   * Cosmetic-only in this shim: Radix's custom overlay scrollbar doesn't
   * reflow layout the way a native scrollbar does, so there's no gutter to
   * reserve. Accepted for API parity with extend.ai's base-ui ScrollArea.
   */
  scrollbarGutter?: boolean;
  viewportClassName?: string;
  viewportProps?: React.ComponentProps<typeof ScrollAreaPrimitive.Viewport>;
  viewportRef?: React.Ref<HTMLDivElement>;
};

/**
 * Both ref channels must reach the viewport node: extend's viewers pass their
 * own `ref` inside `viewportProps` (the xlsx grid's scroll/paint pipeline
 * dead-locks at 0×0 if it never attaches) while callers also pass a separate
 * `viewportRef` for toolbar scroll actions. A plain `ref={viewportRef}` after
 * the spread silently discards the former.
 */
export function mergeRefs<T>(
  ...refs: Array<React.Ref<T> | null | undefined>
): React.RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === 'function') ref(node);
      else (ref as React.MutableRefObject<T | null>).current = node;
    }
  };
}

export function ScrollArea({
  className,
  children,
  orientation = 'both',
  scrollFade: _scrollFade,
  scrollbarGutter: _scrollbarGutter,
  viewportClassName,
  viewportProps,
  viewportRef,
  ...props
}: ScrollAreaCompatProps) {
  const {
    className: viewportPropsClassName,
    ref: viewportPropsRef,
    ...restViewportProps
  } = viewportProps ?? {};

  const mergedViewportRef = React.useMemo(
    () => mergeRefs<HTMLDivElement>(viewportPropsRef, viewportRef),
    [viewportPropsRef, viewportRef],
  );

  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn('relative overflow-hidden', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        {...restViewportProps}
        ref={mergedViewportRef}
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
