'use client';

/**
 * SplitSheet — a sheet that takes a column of the layout instead of floating
 * above it.
 *
 * `Sheet` portals a fixed panel over the page and dims everything behind it.
 * `SplitSheet` does neither. The root is a CSS grid, the page is its first
 * column, and opening the sheet adds a second column on the right. The page
 * narrows to make room. Nothing is `absolute` or `fixed`.
 *
 * Layout follows the width of the root, not the viewport (`@container`):
 * - Root ≥ 48rem: page and sheet sit side by side, split by a hairline. The
 *   sheet column is `size` wide, capped at half the root.
 * - Root < 48rem: the sheet fills the same grid cell as the page. The page stays
 *   mounted but `invisible`, so it keeps its scroll position and leaves the tab
 *   order and the accessibility tree until the sheet closes.
 *
 * Non-modal: no overlay, no focus trap, no scroll lock. A trigger moves focus
 * into the sheet. Closing returns focus to that trigger when focus was inside
 * the sheet. Escape inside the sheet closes it.
 *
 * The root needs a bounded height (`h-full` in a sized parent, or `h-dvh`).
 * The page and the sheet each scroll inside their own column.
 *
 * @example
 * ```tsx
 * <SplitSheet>
 *   <SplitSheetMain>
 *     <SplitSheetTrigger asChild>
 *       <Button size="sm" variant="secondary">Details</Button>
 *     </SplitSheetTrigger>
 *   </SplitSheetMain>
 *   <SplitSheetContent>
 *     <SplitSheetHeader>
 *       <SplitSheetTitle>Title</SplitSheetTitle>
 *       <SplitSheetDescription>Description</SplitSheetDescription>
 *     </SplitSheetHeader>
 *     <SplitSheetBody>{children}</SplitSheetBody>
 *     <SplitSheetFooter>
 *       <SplitSheetClose asChild>
 *         <Button variant="outline-ghost" size="sm">Cancel</Button>
 *       </SplitSheetClose>
 *       <Button size="sm">Save</Button>
 *     </SplitSheetFooter>
 *   </SplitSheetContent>
 * </SplitSheet>
 * ```
 *
 * Controlled:
 * ```tsx
 * <SplitSheet open={open} onOpenChange={setOpen}>...</SplitSheet>
 * ```
 */

import { XIcon } from '@phosphor-icons/react';
import { Slot } from '@radix-ui/react-slot';
import * as React from 'react';

import { cn } from '@/lib/utils';
import { hasOpenFloatingLayer } from '@/lib/z-stack';
import { Button } from './button';
import Hint from './hint';
import { triggerVariants, type TriggerVariantProps } from './trigger-variants';

export type SplitSheetSize = 'sm' | 'md' | 'lg';

/** Sheet column width, from Tailwind's container scale. The grid caps it at 50% of the root. */
const SIZE_CLASS: Record<SplitSheetSize, string> = {
  sm: '[--split-sheet-width:var(--container-xs)]', // 20rem
  md: '[--split-sheet-width:var(--container-sm)]', // 24rem
  lg: '[--split-sheet-width:var(--container-md)]', // 28rem
};

/**
 * The one decision every open/close request goes through. A controlled sheet
 * writes no state of its own: the parent's `open` prop is the only source of
 * truth. Same contract `Disclosure` adopted after its mirrored-state bug.
 */
export function resolveSplitSheetChange(state: {
  open: boolean;
  nextOpen: boolean;
  isControlled: boolean;
}): { changed: boolean; writesInternalState: boolean } {
  const changed = state.open !== state.nextOpen;
  return { changed, writesInternalState: changed && !state.isControlled };
}

type OpenRequest = {
  /** Element that asked. Focus returns to it on close. */
  from?: HTMLElement | null;
  /** Keyboard activation: open with no enter animation. */
  instant?: boolean;
  /** Move focus into the sheet once it mounts. */
  moveFocus?: boolean;
};

type SplitSheetContextValue = {
  open: boolean;
  instant: boolean;
  contentId: string;
  titleId: string;
  requestOpen: (nextOpen: boolean, request?: OpenRequest) => void;
  returnFocusRef: React.RefObject<HTMLElement | null>;
  focusOnOpenRef: React.RefObject<boolean>;
  restoreFocusRef: React.RefObject<boolean>;
};

const SplitSheetContext = React.createContext<SplitSheetContextValue | null>(null);

function useSplitSheetContext(component: string): SplitSheetContextValue {
  const context = React.useContext(SplitSheetContext);
  if (!context) throw new Error(`${component} must be rendered inside <SplitSheet>.`);
  return context;
}

/** Read or set the nearest sheet's open state from anywhere inside it. */
function useSplitSheet(): { open: boolean; setOpen: (open: boolean) => void } {
  const { open, requestOpen } = useSplitSheetContext('useSplitSheet');
  return React.useMemo(
    () => ({ open, setOpen: (nextOpen: boolean) => requestOpen(nextOpen) }),
    [open, requestOpen],
  );
}

type SplitSheetProps = React.ComponentProps<'div'> & {
  /** Controlled. Omit entirely (not `false`) for an uncontrolled sheet. */
  open?: boolean;
  /** Uncontrolled starting value. Ignored when `open` is provided. */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Sheet column width when the root is wide enough to split. */
  size?: SplitSheetSize;
};

function SplitSheet({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  size = 'md',
  className,
  children,
  ...props
}: SplitSheetProps) {
  const isControlled = openProp !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const open = isControlled ? openProp : uncontrolledOpen;
  const [instant, setInstant] = React.useState(false);

  const baseId = React.useId();
  const returnFocusRef = React.useRef<HTMLElement | null>(null);
  const focusOnOpenRef = React.useRef(false);
  const restoreFocusRef = React.useRef(false);

  const requestOpen = React.useCallback(
    (nextOpen: boolean, request: OpenRequest = {}) => {
      const { changed, writesInternalState } = resolveSplitSheetChange({
        open,
        nextOpen,
        isControlled,
      });
      if (!changed) return;
      if (request.from) returnFocusRef.current = request.from;
      if (nextOpen) {
        focusOnOpenRef.current = request.moveFocus ?? false;
        setInstant(request.instant ?? false);
      }
      if (writesInternalState) setUncontrolledOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [open, isControlled, onOpenChange],
  );

  // The panel flags `restoreFocusRef` as it unmounts with focus inside it.
  // Without this, focus falls to <body> and the next Tab starts from the top.
  React.useEffect(() => {
    if (open || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    const target = returnFocusRef.current;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }, [open]);

  const context = React.useMemo<SplitSheetContextValue>(
    () => ({
      open,
      instant,
      contentId: `${baseId}-content`,
      titleId: `${baseId}-title`,
      requestOpen,
      returnFocusRef,
      focusOnOpenRef,
      restoreFocusRef,
    }),
    [open, instant, baseId, requestOpen],
  );

  return (
    <SplitSheetContext.Provider value={context}>
      <div
        data-slot="split-sheet"
        data-state={open ? 'open' : 'closed'}
        className={cn('@container/split-sheet h-full min-h-0 w-full', SIZE_CLASS[size], className)}
        {...props}
      >
        {/* A container query cannot read its own element, so the grid sits one level below the container. */}
        <div
          data-slot="split-sheet-grid"
          className={cn(
            'grid h-full min-h-0 grid-cols-1 grid-rows-1',
            open && '@3xl/split-sheet:grid-cols-[minmax(0,1fr)_min(var(--split-sheet-width),50%)]',
          )}
        >
          {children}
        </div>
      </div>
    </SplitSheetContext.Provider>
  );
}

/** The page. Always the first column; it scrolls on its own. */
function SplitSheetMain({ className, ...props }: React.ComponentProps<'div'>) {
  const { open } = useSplitSheetContext('SplitSheetMain');

  return (
    <div
      data-slot="split-sheet-main"
      className={cn(
        'col-start-1 row-start-1 min-h-0 min-w-0 overflow-y-auto',
        // Narrow root: the sheet covers this cell. `invisible` keeps the page
        // mounted with its scroll position and hides it from keyboard and AT.
        open && '@max-3xl/split-sheet:invisible',
        className,
      )}
      {...props}
    />
  );
}

type SplitSheetTriggerProps = Omit<React.ComponentProps<'button'>, 'ref'> &
  TriggerVariantProps & { asChild?: boolean };

/** Toggles the sheet. Call `event.preventDefault()` in `onClick` to handle the click yourself. */
function SplitSheetTrigger({
  asChild = false,
  variant,
  size,
  className,
  type,
  onClick,
  ...props
}: SplitSheetTriggerProps) {
  const { open, contentId, requestOpen } = useSplitSheetContext('SplitSheetTrigger');
  const Comp = asChild ? Slot : 'button';

  return (
    <Comp
      {...props}
      type={asChild ? type : (type ?? 'button')}
      data-slot="split-sheet-trigger"
      data-state={open ? 'open' : 'closed'}
      aria-expanded={open}
      aria-controls={open ? contentId : undefined}
      // With `asChild` the child owns its styling — merging ours would double it.
      className={asChild ? className : cn(triggerVariants({ variant, size }), className)}
      onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        requestOpen(!open, {
          from: event.currentTarget,
          // `detail === 0` is an Enter/Space activation. Keyboard is never animated.
          instant: event.detail === 0,
          moveFocus: true,
        });
      }}
    />
  );
}

type SplitSheetCloseProps = Omit<React.ComponentProps<'button'>, 'ref'> & { asChild?: boolean };

function SplitSheetClose({ asChild = false, type, onClick, ...props }: SplitSheetCloseProps) {
  const { requestOpen } = useSplitSheetContext('SplitSheetClose');
  const Comp = asChild ? Slot : 'button';

  return (
    <Comp
      data-slot="split-sheet-close"
      {...props}
      type={asChild ? type : (type ?? 'button')}
      onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        requestOpen(false);
      }}
    />
  );
}

/** The sheet column. Renders nothing while closed. Always include a `SplitSheetTitle`. */
function SplitSheetContent(props: Omit<React.ComponentProps<'aside'>, 'ref'>) {
  const { open } = useSplitSheetContext('SplitSheetContent');
  return open ? <SplitSheetPanel {...props} /> : null;
}

function SplitSheetPanel({
  className,
  onKeyDown,
  ...props
}: Omit<React.ComponentProps<'aside'>, 'ref'>) {
  const { instant, contentId, titleId, requestOpen, focusOnOpenRef, restoreFocusRef } =
    useSplitSheetContext('SplitSheetContent');
  const panelRef = React.useRef<HTMLElement>(null);

  React.useLayoutEffect(() => {
    const panel = panelRef.current;
    restoreFocusRef.current = false;
    if (panel && focusOnOpenRef.current) {
      focusOnOpenRef.current = false;
      panel.focus({ preventScroll: true });
    }
    return () => {
      // Layout cleanup runs before React detaches the panel, so focus is still readable.
      if (panel?.contains(document.activeElement)) restoreFocusRef.current = true;
    };
  }, [focusOnOpenRef, restoreFocusRef]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.key !== 'Escape') return;
    // Escape inside a portaled menu or select bubbles here through the React
    // tree. That Escape belongs to the menu, not the sheet — the guard `Modal` uses.
    if (!event.currentTarget.contains(event.target as Node) || hasOpenFloatingLayer()) return;
    event.preventDefault();
    requestOpen(false);
  };

  return (
    <aside
      aria-labelledby={titleId}
      {...props}
      ref={panelRef}
      id={contentId}
      tabIndex={-1}
      data-slot="split-sheet-content"
      data-state="open"
      data-instant={instant ? '' : undefined}
      onKeyDown={handleKeyDown}
      className={cn(
        'bg-popover col-start-1 row-start-1 flex min-h-0 min-w-0 flex-col outline-none',
        '@3xl/split-sheet:col-start-2 @3xl/split-sheet:border-l',
        // Enter only. The column itself snaps: animating grid tracks re-wraps
        // the page on every frame. Reduced motion keeps the fade, drops the slide.
        // `duration-(--duration-moderate)`, not `duration-moderate`: Tailwind 4 has
        // no `--duration-*` theme namespace, so the bare token class emits no CSS.
        'transition-[opacity,translate] duration-(--duration-moderate) ease-out starting:opacity-0 motion-safe:starting:translate-x-2',
        'data-instant:transition-none',
        className,
      )}
    />
  );
}

type SplitSheetHeaderProps = React.ComponentProps<'div'> & {
  showCloseButton?: boolean;
  closeLabel?: string;
};

function SplitSheetHeader({
  className,
  children,
  showCloseButton = true,
  closeLabel = 'Close',
  ...props
}: SplitSheetHeaderProps) {
  return (
    <div
      data-slot="split-sheet-header"
      className={cn('flex shrink-0 items-start gap-3 border-b px-4 py-3', className)}
      {...props}
    >
      {/* Min height tracks the close button: a lone title centers on it, title + description top-align. */}
      <div className="flex min-h-8 min-w-0 flex-1 flex-col justify-center gap-0.5 pointer-coarse:min-h-11">
        {children}
      </div>
      {showCloseButton ? (
        <Hint label={closeLabel} side="bottom" sideOffset={4}>
          <SplitSheetClose asChild>
            <Button
              variant="ghost"
              size="icon-base"
              aria-label={closeLabel}
              className="-mr-1.5 shrink-0 pointer-coarse:size-11"
            >
              <XIcon className="size-4" />
            </Button>
          </SplitSheetClose>
        </Hint>
      ) : null}
    </div>
  );
}

function SplitSheetTitle({ className, ...props }: React.ComponentProps<'h2'>) {
  const { titleId } = useSplitSheetContext('SplitSheetTitle');

  return (
    <h2
      id={titleId}
      data-slot="split-sheet-title"
      className={cn('text-foreground text-sm font-medium text-pretty wrap-break-word', className)}
      {...props}
    />
  );
}

function SplitSheetDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="split-sheet-description"
      className={cn('text-muted-foreground text-xs text-pretty wrap-break-word', className)}
      {...props}
    />
  );
}

function SplitSheetBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="split-sheet-body"
      className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5', className)}
      {...props}
    />
  );
}

function SplitSheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="split-sheet-footer"
      className={cn(
        'flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-4 py-3',
        className,
      )}
      {...props}
    />
  );
}

export {
  SplitSheet,
  SplitSheetBody,
  SplitSheetClose,
  SplitSheetContent,
  SplitSheetDescription,
  SplitSheetFooter,
  SplitSheetHeader,
  SplitSheetMain,
  SplitSheetTitle,
  SplitSheetTrigger,
  useSplitSheet,
};
export type { SplitSheetProps };
