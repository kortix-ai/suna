'use client';

import {
  ChartLineUpIcon,
  CubeIcon,
  KanbanIcon,
  SquaresFourIcon,
  UsersIcon,
  WrenchIcon,
  type Icon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import Hint from '@/components/ui/hint';
import { KortixLogo } from '@/components/ui/kortix-logo';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { PROJECT_LANDING_PATH } from '@/lib/onboarding/landing-destination';

interface AdminNavItem {
  href: string;
  label: string;
  icon: Icon;
}

/** Every route under `app/admin/*`, in the order an operator works them. */
const NAV_ITEMS: AdminNavItem[] = [
  { href: '/admin', label: 'Overview', icon: SquaresFourIcon },
  { href: '/admin/accounts', label: 'Accounts', icon: UsersIcon },
  { href: '/admin/projects', label: 'Projects', icon: KanbanIcon },
  { href: '/admin/analytics', label: 'Analytics', icon: ChartLineUpIcon },
  { href: '/admin/sandboxes', label: 'Sandboxes', icon: CubeIcon },
  { href: '/admin/utils', label: 'Maintenance', icon: WrenchIcon },
];

/** `/admin` matches only itself; every other row owns its subtree. */
export function isAdminNavActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === '/admin') return pathname === '/admin';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The admin console's navigation panel — the app's own `sidebar.tsx`
 * primitives: `offcanvas` collapse, so collapsing hands the panel to the
 * edge-peek hover flyout ({@link SidebarEdgePeek}, rendered by the shell)
 * instead of leaving a rail. A `SidebarRail` resizes it; rows are
 * `SidebarMenuButton`s with tooltips.
 *
 * `variant="sidebar"` (flush), NOT `inset`. `inset` gives the content a
 * `rounded-xl shadow-sm` floating card — the drop shadow and rounded corner Jay
 * flagged. Flush has neither: the seam is the panel's own `border-r`, and the
 * collapsed peek is still a floating flyout (that geometry is variant-agnostic,
 * applied only while peeking).
 *
 * The header carries two controls, per Jay: the Kortix mark (small, a `Link`
 * back to the app) and the collapse `SidebarTrigger`. No "Back to app" text row
 * — the mark is the way back.
 */
export function AdminSidebar() {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();

  return (
    <Sidebar collapsible="offcanvas" variant="sidebar">
      <SidebarHeader>
        <div className="flex h-8 w-full items-center justify-between gap-2">
          <Hint label="Back to app" side="bottom">
            <Link
              href={PROJECT_LANDING_PATH}
              prefetch
              aria-label="Back to app"
              className="focus-visible:ring-ring flex items-center rounded-md px-1 outline-none focus-visible:ring-2"
              onClick={() => setOpenMobile(false)}
            >
              <KortixLogo variant="brandmark" size={16} className="text-foreground" />
            </Link>
          </Hint>
          <SidebarTrigger className="shrink-0" />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    asChild
                    isActive={isAdminNavActive(pathname, item.href)}
                    tooltip={item.label}
                  >
                    <Link href={item.href} prefetch onClick={() => setOpenMobile(false)}>
                      <item.icon />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarRail />
    </Sidebar>
  );
}
