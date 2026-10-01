'use client';

import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import * as React from 'react';

import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  SIDEBAR_COOKIE_MAX_AGE,
  SIDEBAR_COOKIE_NAME,
  SIDEBAR_KEYBOARD_SHORTCUT,
  SIDEBAR_RESIZE_STEP_COARSE_PX,
  SIDEBAR_RESIZE_STEP_PX,
  SIDEBAR_UNDOCK_MS,
  SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_ICON,
  SidebarContext,
  resolveInstant,
  useOptionalSidebar,
  useSidebar,
  type SidebarContextProps,
  type SidebarToggleOptions,
} from '@/components/ui/sidebar-context';
import { createPeekController } from '@/components/ui/sidebar-peek';
import {
  SIDEBAR_MAX_WIDTH_PX,
  SIDEBAR_WIDTH_COOKIE_NAME,
  SIDEBAR_WIDTH_PX,
  clampSidebarWidth,
  maxSidebarWidth,
  parseSidebarWidthCookie,
} from '@/components/ui/sidebar-width';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { Sidebar, SidebarTrigger, SidebarEdgePeek, SidebarRail, SidebarInset } from '@/components/ui/sidebar-panel';

function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const isMobile = useIsMobile();
  const [openMobile, setOpenMobile] = React.useState(false);

  // This is the internal state of the sidebar.
  // We use openProp and setOpenProp for control from outside the component.
  const [_open, _setOpen] = React.useState(defaultOpen);
  const open = openProp ?? _open;
  const setOpen = React.useCallback(
    (value: boolean | ((value: boolean) => boolean)) => {
      const openState = typeof value === 'function' ? value(open) : value;
      if (setOpenProp) {
        // Controlled: whoever owns the state owns its persistence. The
        // settings shell (`features/accounts/hub/account-settings-shell.tsx`)
        // controls its sidebar precisely so a collapse there does not land in
        // this cookie and hide the project sidebar on the next app load.
        setOpenProp(openState);
        return;
      }
      _setOpen(openState);

      // This sets the cookie to keep the sidebar state.
      document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
    },
    [setOpenProp, open],
  );

  // Helper to toggle the sidebar.
  //
  // ⌘B — and any Enter/Space activation of a toggle button — is a
  // keyboard-initiated action on a surface the user hits many times a day, and
  // those get NO motion. The frequency rule is not about the number of
  // milliseconds; it is about the hand expecting the panel to already be there
  // when the fingers come off the keys.
  const [instantToggle, setInstantToggle] = React.useState(false);
  const toggleSidebar = React.useCallback(
    (options?: SidebarToggleOptions) => {
      setInstantToggle(resolveInstant(options));
      return isMobile ? setOpenMobile((open) => !open) : setOpen((open) => !open);
    },
    [isMobile, setOpen, setOpenMobile],
  );

  // Release the instant flag once the browser has painted the snapped frame, so
  // the NEXT pointer-driven toggle animates again. Double rAF, not a timeout: a
  // `setTimeout(0)` can land before the paint, which would re-declare the
  // transition while the transform is still mid-change and animate the very
  // toggle that asked not to be animated.
  React.useEffect(() => {
    if (!instantToggle) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setInstantToggle(false));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [instantToggle]);

  // Edge-peek flyout state — hover intent lives in a plain controller so the
  // open/close delays are testable without React or wall-clock timers.
  const [peek, setPeek] = React.useState(false);
  const peekController = React.useMemo(() => createPeekController(setPeek), []);
  React.useEffect(() => () => peekController.cancel(), [peekController]);
  React.useEffect(() => {
    if (open || isMobile) peekController.cancel();
  }, [open, isMobile, peekController]);

  // Tracks whether the pointer is currently over the panel/edge zone so a
  // menu closing can decide whether to re-arm the flyout's close timer.
  const pointerOverRef = React.useRef(false);
  const peekEnter = React.useCallback(() => {
    pointerOverRef.current = true;
    peekController.enter();
  }, [peekController]);
  const peekLeave = React.useCallback(() => {
    pointerOverRef.current = false;
    peekController.leave();
  }, [peekController]);
  const holdPeek = React.useCallback(
    (held: boolean) => peekController.hold(held, () => pointerOverRef.current),
    [peekController],
  );

  // ── Resizable width ────────────────────────────────────────────────────
  // `null` means "use the default"; a number is the user's persisted choice.
  // Read straight out of the cookie in the initializer so a resized sidebar
  // never paints at 256px first and then jumps — the wrapper below carries
  // `suppressHydrationWarning` because that read makes the client's first
  // style attribute legitimately differ from the server's.
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  const [width, setWidthState] = React.useState<number | null>(() =>
    typeof document === 'undefined' ? null : parseSidebarWidthCookie(document.cookie),
  );

  const setWidth = React.useCallback((next: number) => {
    const clamped = clampSidebarWidth(next, window.innerWidth);
    // Write the committed value to the node BEFORE the state update, and never
    // clear the override. A drag leaves an inline `--sidebar-width` on the
    // wrapper; removing it here would paint one frame at the default 20rem if
    // React defers the re-render past the next paint. Writing the same value
    // React is about to render makes the hand-off unobservable.
    wrapperRef.current?.style.setProperty('--sidebar-width', `${clamped}px`);
    setWidthState(clamped);
    document.cookie = `${SIDEBAR_WIDTH_COOKIE_NAME}=${clamped}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
  }, []);

  // Live drag feedback without a React render per pointermove. The gap and the
  // panel both size off this one variable, so writing it on the wrapper node
  // IS the update. (Custom properties inherit, so this does cost a style
  // recalc down the tree — acceptable for a drag the user is watching, and the
  // reason it is not used for anything else.)
  const previewWidth = React.useCallback((next: number) => {
    wrapperRef.current?.style.setProperty('--sidebar-width', `${next}px`);
  }, []);

  // The ratio cap is a live rule, not a write-time one: a stored 416px must
  // not survive the window being dragged down to 900px. Runs once on mount too,
  // which is what re-clamps a value persisted at a wider viewport.
  React.useEffect(() => {
    const capToViewport = () =>
      setWidthState((current) => {
        if (current === null) return current;
        const capped = Math.min(current, maxSidebarWidth(window.innerWidth));
        return capped === current ? current : capped;
      });
    capToViewport();
    window.addEventListener('resize', capToViewport);
    return () => window.removeEventListener('resize', capToViewport);
  }, []);

  // Adds a keyboard shortcut to toggle the sidebar.
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === SIDEBAR_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        toggleSidebar({ instant: true });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleSidebar]);

  // We add a state so that we can do data-state="expanded" or "collapsed".
  // This makes it easier to style the sidebar with Tailwind classes.
  const state = open ? 'expanded' : 'collapsed';

  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({
      state,
      open,
      setOpen,
      isMobile,
      openMobile,
      setOpenMobile,
      toggleSidebar,
      instantToggle,
      peek,
      peekEnter,
      peekLeave,
      holdPeek,
      width: width ?? SIDEBAR_WIDTH_PX,
      setWidth,
      previewWidth,
    }),
    [
      state,
      open,
      setOpen,
      isMobile,
      openMobile,
      setOpenMobile,
      toggleSidebar,
      instantToggle,
      peek,
      peekEnter,
      peekLeave,
      holdPeek,
      width,
      setWidth,
      previewWidth,
    ],
  );

  return (
    <SidebarContext.Provider value={contextValue}>
      <TooltipProvider delayDuration={0}>
        <div
          data-slot="sidebar-wrapper"
          suppressHydrationWarning
          style={
            {
              '--sidebar-width': width === null ? SIDEBAR_WIDTH : `${width}px`,
              '--sidebar-width-icon': SIDEBAR_WIDTH_ICON,
              ...style,
            } as React.CSSProperties
          }
          className={cn(
            'group/sidebar-wrapper has-data-[variant=inset]:bg-background flex min-h-svh w-full',
            className,
          )}
          {...props}
          ref={wrapperRef}
        >
          {children}
        </div>
      </TooltipProvider>
    </SidebarContext.Provider>
  );
}

function SidebarInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return (
    <Input
      data-slot="sidebar-input"
      data-sidebar="input"
      className={cn('bg-background h-8 w-full shadow-none', className)}
      {...props}
    />
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-header"
      data-sidebar="header"
      className={cn('flex flex-col gap-2 p-2', className)}
      {...props}
    />
  );
}

function SidebarFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-footer"
      data-sidebar="footer"
      className={cn('flex flex-col gap-2 p-2', className)}
      {...props}
    />
  );
}

function SidebarSeparator({ className, ...props }: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="sidebar-separator"
      data-sidebar="separator"
      className={cn('bg-background-border mx-2 w-auto', className)}
      {...props}
    />
  );
}

function SidebarContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn(
        'flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]:overflow-hidden',
        className,
      )}
      {...props}
    />
  );
}

function SidebarGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-group"
      data-sidebar="group"
      className={cn('relative flex w-full min-w-0 flex-col p-2', className)}
      {...props}
    />
  );
}

function SidebarGroupLabel({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<'div'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'div';

  return (
    <Comp
      data-slot="sidebar-group-label"
      data-sidebar="group-label"
      className={cn(
        'text-sidebar-foreground/70 ring-sidebar-ring flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium outline-hidden transition-[margin,opacity] duration-200 ease-linear focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0',
        'group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0',
        className,
      )}
      {...props}
    />
  );
}

function SidebarGroupAction({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="sidebar-group-action"
      data-sidebar="group-action"
      className={cn(
        'text-sidebar-foreground ring-sidebar-ring hover:bg-hover hover:text-sidebar-accent-foreground absolute top-3.5 right-3 flex aspect-square w-5 items-center justify-center rounded-md p-0 outline-hidden transition-transform focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0',
        // Increases the hit area of the button on mobile.
        'after:absolute after:-inset-2 md:after:hidden',
        'group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...props}
    />
  );
}

function SidebarGroupContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-group-content"
      data-sidebar="group-content"
      className={cn('w-full text-sm', className)}
      {...props}
    />
  );
}

function SidebarMenu({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      data-slot="sidebar-menu"
      data-sidebar="menu"
      className={cn('flex w-full min-w-0 flex-col gap-px', className)}
      {...props}
    />
  );
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      className={cn('group/menu-item relative', className)}
      {...props}
    />
  );
}

const sidebarMenuButtonVariants = cva(
  // No hover transition. Sidebar rows are hit tens–hundreds of times a day;
  // animating bg/color makes the highlight lag the pointer (Raycast rule).
  "peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-none cursor-pointer shadow-none group-has-data-[sidebar=menu-action]/menu-item:pr-8 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! hover:bg-hover hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-kortix-base focus-visible:ring-[0.6px] active:bg-active active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive data-[active=true]:bg-active data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground data-[state=open]:hover:bg-hover data-[state=open]:hover:text-sidebar-accent-foreground [&>span:last-child]:truncate [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 px-3 font-medium [&_svg]:size-4!",
  {
    variants: {
      variant: {
        default: 'text-muted-foreground hover:bg-sidebar-row hover:text-sidebar-foreground',
        outline:
          'bg-background shadow-[0_0_0_1px_var(--sidebar-border)] hover:bg-hover hover:text-sidebar-accent-foreground hover:shadow-[0_0_0_1px_var(--sidebar-accent)]',
        success:
          'bg-kortix-green/10 text-kortix-green hover:bg-kortix-green/20 hover:text-kortix-green active:bg-kortix-green/25 active:text-kortix-green data-[active=true]:bg-kortix-green/15 data-[active=true]:text-kortix-green data-[state=open]:hover:bg-kortix-green/20 data-[state=open]:hover:text-kortix-green dark:bg-kortix-green/15 dark:text-kortix-green dark:hover:bg-kortix-green/25 dark:hover:text-kortix-green dark:active:bg-kortix-green/30 dark:active:text-kortix-green dark:data-[active=true]:bg-kortix-green/20 dark:data-[active=true]:text-kortix-green dark:data-[state=open]:hover:bg-kortix-green/25 dark:data-[state=open]:hover:text-kortix-green',
        primary:
          'bg-foreground text-background font-medium justify-center border-none hover:bg-foreground/90 hover:text-background',
      },
      size: {
        default: 'h-8 text-sm',
        sm: 'h-7 text-xs',
        lg: 'h-12 text-sm group-data-[collapsible=icon]:p-0!',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function SidebarMenuButton({
  asChild = false,
  isActive = false,
  variant = 'default',
  size = 'default',
  tooltip,
  className,
  ...props
}: React.ComponentProps<'button'> & {
  asChild?: boolean;
  isActive?: boolean;
  tooltip?: string | React.ComponentProps<typeof TooltipContent>;
} & VariantProps<typeof sidebarMenuButtonVariants>) {
  const Comp = asChild ? Slot.Root : 'button';
  const { isMobile, state } = useSidebar();

  const button = (
    <Comp
      data-slot="sidebar-menu-button"
      data-sidebar="menu-button"
      data-size={size}
      data-active={isActive}
      className={cn(sidebarMenuButtonVariants({ variant, size }), className)}
      {...props}
    />
  );

  if (!tooltip) {
    return button;
  }

  if (typeof tooltip === 'string') {
    tooltip = {
      children: tooltip,
    };
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent
        side="right"
        align="center"
        hidden={state !== 'collapsed' || isMobile}
        {...tooltip}
      />
    </Tooltip>
  );
}

function SidebarMenuAction({
  className,
  asChild = false,
  showOnHover = false,
  ...props
}: React.ComponentProps<'button'> & {
  asChild?: boolean;
  showOnHover?: boolean;
}) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="sidebar-menu-action"
      data-sidebar="menu-action"
      className={cn(
        'text-sidebar-foreground ring-sidebar-ring peer-hover/menu-button:text-sidebar-accent-foreground hover:bg-hover hover:text-sidebar-accent-foreground absolute top-1.5 right-1 flex aspect-square w-5 items-center justify-center rounded-md p-0 outline-hidden transition-transform focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0',
        // Increases the hit area of the button on mobile.
        'after:absolute after:-inset-2 md:after:hidden',
        'peer-data-[size=sm]/menu-button:top-1',
        'peer-data-[size=default]/menu-button:top-1.5',
        'peer-data-[size=lg]/menu-button:top-2.5',
        'group-data-[collapsible=icon]:hidden',
        showOnHover &&
          'peer-data-[active=true]/menu-button:text-sidebar-accent-foreground group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 data-[state=open]:opacity-100 md:opacity-0',
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenuBadge({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-menu-badge"
      data-sidebar="menu-badge"
      className={cn(
        'text-sidebar-foreground pointer-events-none absolute right-1 flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-xs font-medium tabular-nums select-none',
        'peer-hover/menu-button:text-sidebar-accent-foreground peer-data-[active=true]/menu-button:text-sidebar-accent-foreground',
        'peer-data-[size=sm]/menu-button:top-1',
        'peer-data-[size=default]/menu-button:top-1.5',
        'peer-data-[size=lg]/menu-button:top-2.5',
        'group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenuSkeleton({
  className,
  showIcon = false,
  ...props
}: React.ComponentProps<'div'> & {
  showIcon?: boolean;
}) {
  // Random width between 50 to 90%.
  const width = React.useMemo(() => {
    return `${Math.floor(Math.random() * 40) + 50}%`;
  }, []);

  return (
    <div
      data-slot="sidebar-menu-skeleton"
      data-sidebar="menu-skeleton"
      className={cn('flex h-8 items-center gap-2 rounded-md px-2', className)}
      {...props}
    >
      {showIcon && <Skeleton className="size-4 rounded-md" data-sidebar="menu-skeleton-icon" />}
      <Skeleton
        className="h-4 max-w-(--skeleton-width) flex-1"
        data-sidebar="menu-skeleton-text"
        style={
          {
            '--skeleton-width': width,
          } as React.CSSProperties
        }
      />
    </div>
  );
}

function SidebarMenuSub({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      data-slot="sidebar-menu-sub"
      data-sidebar="menu-sub"
      className={cn(
        'border-sidebar-border mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-l px-2.5 py-0.5',
        'group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenuSubItem({ className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      data-slot="sidebar-menu-sub-item"
      data-sidebar="menu-sub-item"
      className={cn('group/menu-sub-item relative', className)}
      {...props}
    />
  );
}

function SidebarMenuSubButton({
  asChild = false,
  size = 'md',
  isActive = false,
  className,
  ...props
}: React.ComponentProps<'a'> & {
  asChild?: boolean;
  size?: 'sm' | 'md';
  isActive?: boolean;
}) {
  const Comp = asChild ? Slot.Root : 'a';

  return (
    <Comp
      data-slot="sidebar-menu-sub-button"
      data-sidebar="menu-sub-button"
      data-size={size}
      data-active={isActive}
      className={cn(
        'text-sidebar-foreground ring-sidebar-ring hover:bg-hover hover:text-sidebar-accent-foreground active:bg-active active:text-sidebar-accent-foreground [&>svg]:text-sidebar-accent-foreground flex h-7 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-md px-2 outline-hidden focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0',
        'data-[active=true]:bg-active data-[active=true]:text-sidebar-accent-foreground',
        size === 'sm' && 'text-xs',
        size === 'md' && 'text-sm',
        'group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...props}
    />
  );
}

export {
  Sidebar,
  SidebarContent,
  SidebarContext,
  SidebarEdgePeek,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useOptionalSidebar,
  useSidebar,
};

export type { SidebarToggleOptions };
