'use client';

import * as React from 'react';
import { useEffect, useRef, type RefObject } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import {
  Activity,
  FolderOpen,
  Globe,
  Home,
  Loader2,
  Search,
  Settings,
  ShieldAlert,
  SquarePen,
  Terminal as TerminalIcon,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import {
  fontWeights,
  springs,
  useProximityHover,
  useRegisterProximityItem,
} from '@kortix/design-system';

import { Kbd } from '@/components/ui/kbd';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { InstanceSwitcherPopover } from '@/components/sidebar/instance-switcher-popover';
import { SessionList } from '@/components/sidebar/session-list';
import { UserMenu } from '@/components/sidebar/user-menu';
import { useAdminRole } from '@/hooks/admin';
import { useAuth } from '@/components/AuthProvider';
import { useCreateOpenCodeSession } from '@/hooks/opencode/use-opencode-sessions';
import { useDocumentModalStore } from '@/stores/use-document-modal-store';
import { useIsMobile } from '@/hooks/utils';
import {
  buildInstancePath,
  getActiveInstanceIdFromCookie,
  getCurrentInstanceIdFromPathname,
  normalizeAppPathname,
} from '@/lib/instance-routes';

const FLOATING_SHELL_OVERRIDE =
  '[&_[data-sidebar=sidebar]]:!bg-transparent ' +
  '[&_[data-sidebar=sidebar]]:!border-0 ' +
  '[&_[data-sidebar=sidebar]]:!shadow-none ' +
  '[&_[data-sidebar=sidebar]]:!rounded-none';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
}

const WORKSPACE_NAV: NavItem[] = [
  { href: '/dashboard', label: 'Home', icon: Home },
  { href: '/files', label: 'Files', icon: FolderOpen },
  { href: '/terminal', label: 'Terminal', icon: TerminalIcon },
  { href: '/browser', label: 'Browser', icon: Globe },
  { href: '/services', label: 'Services', icon: Activity },
  { href: '/tools', label: 'Tools', icon: Wrench },
];

const ACCOUNT_NAV: NavItem[] = [
  { href: '/settings/credentials', label: 'Settings', icon: Settings },
  { href: '/admin', label: 'Admin', icon: ShieldAlert, adminOnly: true },
];

function isPathnameActive(pathname: string, href: string): boolean {
  if (href === '/dashboard') return pathname === '/dashboard' || pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return true;
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const router = useRouter();
  const rawPathname = usePathname() ?? '';
  const pathname = normalizeAppPathname(rawPathname);
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();

  const { data: adminRoleData } = useAdminRole();
  const isAdmin = adminRoleData?.isAdmin ?? false;

  const { user: authUser } = useAuth();
  const user = React.useMemo(
    () => ({
      name:
        authUser?.user_metadata?.name ||
        authUser?.email?.split('@')[0] ||
        'User',
      email: authUser?.email ?? '',
      avatar:
        authUser?.user_metadata?.avatar_url ||
        authUser?.user_metadata?.picture ||
        '',
      isAdmin,
    }),
    [authUser, isAdmin],
  );

  const currentInstanceId =
    getCurrentInstanceIdFromPathname(rawPathname) || getActiveInstanceIdFromCookie();

  const createSession = useCreateOpenCodeSession();
  const handleNewSession = React.useCallback(async () => {
    try {
      const session = await createSession.mutateAsync();
      const target = currentInstanceId
        ? buildInstancePath(currentInstanceId, `/sessions/${session.id}`)
        : `/sessions/${session.id}`;
      router.push(target);
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('focus-session-textarea'));
      });
      if (isMobile) setOpenMobile(false);
    } catch {
      router.push(
        currentInstanceId
          ? buildInstancePath(currentInstanceId, '/dashboard')
          : '/dashboard',
      );
      if (isMobile) setOpenMobile(false);
    }
  }, [createSession, router, isMobile, setOpenMobile, currentInstanceId]);

  const isDocumentModalOpen = useDocumentModalStore((s) => s.isOpen);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isDocumentModalOpen) return;
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === 'j' || e.key === 'n' || e.key === 'N')
      ) {
        e.preventDefault();
        void handleNewSession();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isDocumentModalOpen, handleNewSession]);

  const workspaceItems = WORKSPACE_NAV;
  const accountItems = ACCOUNT_NAV.filter((item) => !item.adminOnly || isAdmin);

  return (
    <Sidebar
      variant="floating"
      collapsible="icon"
      className={cn(FLOATING_SHELL_OVERRIDE, props.className)}
      {...props}
    >
      <SidebarHeader className="gap-2 px-2 pt-2 pb-1 group-data-[collapsible=icon]:px-1">
        <div className="group-data-[collapsible=icon]:hidden">
          <InstanceSwitcherPopover />
        </div>

        <div className="px-1 group-data-[collapsible=icon]:hidden">
          <SidebarSearch />
        </div>
      </SidebarHeader>

      <SidebarContent className="px-1.5 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']">
        <CompactRail
          handleNewSession={handleNewSession}
          isCreating={createSession.isPending}
          pathname={pathname}
        />

        <div className="flex h-full min-h-0 flex-col group-data-[collapsible=icon]:hidden">
          <NewSessionButton
            onClick={handleNewSession}
            disabled={createSession.isPending}
          />

          <SectionLabel>Workspace</SectionLabel>
          <ProximityNavGroup items={workspaceItems} pathname={pathname} />

          <SidebarSessions />

          <div className="pt-2">
            <SectionLabel>Account</SectionLabel>
            <ProximityNavGroup items={accountItems} pathname={pathname} />
          </div>
        </div>
      </SidebarContent>

      <SidebarFooter className="px-2 pb-2.5 group-data-[collapsible=icon]:px-1">
        <UserMenu user={user} />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}

function CompactRail({
  handleNewSession,
  isCreating,
  pathname,
}: {
  handleNewSession: () => void;
  isCreating: boolean;
  pathname: string;
}) {
  const items: NavItem[] = [...WORKSPACE_NAV, ...ACCOUNT_NAV];
  return (
    <div className="hidden flex-col items-center gap-0.5 px-1 pt-1 group-data-[collapsible=icon]:flex">
      <RailIconButton
        icon={isCreating ? <Loader2 className="size-4 animate-spin" /> : <SquarePen className="size-4" />}
        label="New session"
        onClick={handleNewSession}
        disabled={isCreating}
      />
      <div className="my-1 h-px w-full bg-sidebar-border/60" />
      {items.map((item) => {
        const active = isPathnameActive(pathname, item.href);
        const Icon = item.icon;
        return (
          <RailIconButton
            key={item.href}
            icon={<Icon className="size-4" />}
            label={item.label}
            href={item.href}
            isActive={active}
          />
        );
      })}
    </div>
  );
}

function RailIconButton({
  icon,
  label,
  onClick,
  href,
  isActive,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  href?: string;
  isActive?: boolean;
  disabled?: boolean;
}) {
  const className = cn(
    'flex h-8 w-8 items-center justify-center rounded-lg transition-colors duration-150',
    isActive
      ? 'bg-sidebar-accent text-foreground'
      : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
    disabled && 'cursor-not-allowed opacity-50',
  );
  const inner = href ? (
    <Link href={href} className={className} aria-label={label}>
      {icon}
    </Link>
  ) : (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={className}
      aria-label={label}
    >
      {icon}
    </button>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{inner}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={12} className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function NewSessionButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  const [isMac, setIsMac] = React.useState(true);
  useEffect(() => {
    setIsMac(isMacPlatform());
  }, []);

  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { activeIndex, itemRects, sessionRef, handlers, registerItem, measureItems } =
    useProximityHover<HTMLDivElement>(containerRef, { axis: 'y' });

  useRegisterProximityItem(
    registerItem,
    0,
    buttonRef as unknown as RefObject<HTMLElement | null>,
  );

  useEffect(() => {
    measureItems();
  }, [measureItems]);

  const hoverRect = activeIndex !== null ? itemRects[activeIndex] : null;

  return (
    <div ref={containerRef} className="relative" {...handlers}>
      <AnimatePresence>
        {hoverRect && !disabled ? (
          <motion.div
            key={`new-hover-${sessionRef.current}`}
            aria-hidden
            className="pointer-events-none absolute left-0 right-0 rounded-lg bg-sidebar-accent/60"
            initial={{ top: hoverRect.top, height: hoverRect.height, opacity: 0 }}
            animate={{ top: hoverRect.top, height: hoverRect.height, opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={springs.moderate}
          />
        ) : null}
      </AnimatePresence>

      <button
        ref={buttonRef}
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(
          'group/new relative z-10 flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 font-sans text-sm text-muted-foreground transition-colors',
          'hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          disabled && 'cursor-not-allowed opacity-60',
        )}
      >
        {disabled ? (
          <Loader2 className="size-4 shrink-0 animate-spin" />
        ) : (
          <SquarePen className="size-4 shrink-0 text-muted-foreground/60 transition-colors group-hover/new:text-foreground" />
        )}
        <span className="flex-1 text-left">
          {disabled ? 'Creating…' : 'New session'}
        </span>
        <span className="hidden items-center gap-0.5 opacity-0 transition-opacity group-hover/new:opacity-100 sm:inline-flex">
          <Kbd className="h-4 min-w-4 px-1 text-[0.6rem]">{isMac ? '⌘' : 'Ctrl'}</Kbd>
          <Kbd className="h-4 min-w-4 px-1 text-[0.6rem]">J</Kbd>
        </span>
      </button>
    </div>
  );
}

function SidebarSearch() {
  const [isMac, setIsMac] = React.useState(true);
  useEffect(() => {
    setIsMac(isMacPlatform());
  }, []);

  function open() {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'k',
        code: 'KeyK',
        metaKey: isMac,
        ctrlKey: !isMac,
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  return (
    <button
      type="button"
      onClick={open}
      className={cn(
        'flex w-full items-center gap-2 rounded-xl border border-sidebar-border bg-background/40 px-3 py-2 text-left font-sans text-sm text-muted-foreground transition-colors',
        'hover:bg-background/70',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <Search className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="flex-1 truncate">Jump to…</span>
      <span className="hidden items-center gap-1 text-[0.65rem] sm:inline-flex">
        <Kbd className="h-4 min-w-4 px-1 text-[0.6rem]">{isMac ? '⌘' : 'Ctrl'}</Kbd>
        <Kbd className="h-4 min-w-4 px-1 text-[0.6rem]">K</Kbd>
      </span>
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-1.5 pt-1 font-sans text-[0.65rem] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">
      {children}
    </div>
  );
}

function SidebarSessions() {
  return (
    <div className="flex min-h-0 flex-1 flex-col pt-3">
      <SectionLabel>Sessions</SectionLabel>
      <div className="min-h-0 flex-1 overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']">
        <SessionList projectId={null} />
      </div>
    </div>
  );
}

export function ProximityNavGroup({
  items,
  pathname,
}: {
  items: NavItem[];
  pathname: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { activeIndex, itemRects, sessionRef, handlers, registerItem, measureItems } =
    useProximityHover<HTMLDivElement>(containerRef, { axis: 'y' });

  const activeRouteIdx = items.findIndex((item) => isPathnameActive(pathname, item.href));

  useEffect(() => {
    measureItems();
  }, [items.length, measureItems]);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => measureItems());
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [measureItems]);

  const hoverRect = activeIndex !== null ? itemRects[activeIndex] : null;
  const activeRect = activeRouteIdx >= 0 ? itemRects[activeRouteIdx] : null;
  const hoverIsOnActive = activeIndex === activeRouteIdx;

  return (
    <div ref={containerRef} className="relative" {...handlers}>
      {activeRect ? (
        <motion.div
          aria-hidden
          className={cn(
            'pointer-events-none absolute left-0 right-0 rounded-lg transition-colors duration-150',
            activeIndex !== null && !hoverIsOnActive
              ? 'bg-muted-foreground/[0.04]'
              : 'bg-muted-foreground/10',
          )}
          initial={false}
          animate={{ top: activeRect.top, height: activeRect.height }}
          transition={springs.moderate}
        />
      ) : null}

      <AnimatePresence>
        {hoverRect && !hoverIsOnActive ? (
          <motion.div
            key={`hover-${sessionRef.current}`}
            aria-hidden
            className="pointer-events-none absolute left-0 right-0 rounded-lg bg-sidebar-accent/60"
            initial={{
              top: hoverRect.top,
              height: hoverRect.height,
              opacity: 0,
            }}
            animate={{
              top: hoverRect.top,
              height: hoverRect.height,
              opacity: 1,
            }}
            exit={{ opacity: 0 }}
            transition={springs.moderate}
          />
        ) : null}
      </AnimatePresence>

      {items.map((item, index) => (
        <ProximityNavLink
          key={item.href}
          item={item}
          index={index}
          isActive={index === activeRouteIdx}
          isHovered={index === activeIndex}
          registerItem={registerItem}
        />
      ))}
    </div>
  );
}

function ProximityNavLink({
  item,
  index,
  isActive,
  isHovered,
  registerItem,
}: {
  item: NavItem;
  index: number;
  isActive: boolean;
  isHovered: boolean;
  registerItem: (index: number, element: HTMLElement | null) => void;
}) {
  const linkRef = useRef<HTMLAnchorElement>(null);
  useRegisterProximityItem(
    registerItem,
    index,
    linkRef as unknown as RefObject<HTMLElement | null>,
  );

  const emphasized = isActive || isHovered;
  const { icon: Icon, label, href } = item;

  return (
    <Link
      ref={linkRef}
      href={href}
      className={cn(
        'relative z-10 flex items-center gap-2.5 rounded-lg px-3 py-1.5 font-sans text-sm transition-[color,font-variation-settings] duration-150',
        emphasized ? 'text-foreground' : 'text-muted-foreground',
      )}
      style={{
        fontVariationSettings: isActive ? fontWeights.semibold : fontWeights.normal,
      }}
    >
      <Icon
        className="size-4 shrink-0 text-muted-foreground/40 transition-[stroke-width] duration-150"
        strokeWidth={emphasized ? 2 : 1.5}
        aria-hidden="true"
      />
      <span className="flex-1">{label}</span>
    </Link>
  );
}
