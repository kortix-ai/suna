'use client';

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
  type SidebarContextProps,
  type SidebarToggleOptions,
  resolveInstant,
  useOptionalSidebar,
  useSidebar,
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
import { TooltipProvider } from '@/components/ui/tooltip';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { Sidebar, SidebarTrigger, SidebarEdgePeek, SidebarRail, SidebarInset } from '@/components/ui/sidebar-panel';
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@/components/ui/sidebar-menu-primitives';

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
