'use client';

import { ShieldCheckIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useState } from 'react';

import { RouteLoadingFallback } from '@/components/common/route-loading';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import {
  SidebarEdgePeek,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useAdminRole } from '@/hooks/admin/use-admin-role';
import { PROJECT_LANDING_PATH } from '@/lib/onboarding/landing-destination';

import { AdminSidebar, isAdminNavActive } from './admin-sidebar';

const NAV_LABELS: { href: string; label: string }[] = [
  { href: '/admin/accounts', label: 'Accounts' },
  { href: '/admin/projects', label: 'Projects' },
  { href: '/admin/analytics', label: 'Analytics' },
  { href: '/admin/sandboxes', label: 'Sandboxes' },
  { href: '/admin/utils', label: 'Maintenance' },
];

const ADMIN_SIDEBAR_COOKIE = 'admin_sidebar_state';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

function activeAdminLabel(pathname: string | null): string | null {
  const match = NAV_LABELS.find((item) => isAdminNavActive(pathname, item.href));
  return match?.label ?? null;
}

/**
 * The shell every /admin route renders inside.
 *
 * Built on the app's own `sidebar.tsx` (`SidebarProvider` + `Sidebar` +
 * `SidebarInset`), the same system `project-shell.tsx` uses — so the console
 * gets the app's real collapse, resize and edge-peek behaviour rather than a
 * bespoke frame.
 *
 * The provider is CONTROLLED, with its own `admin_sidebar_state` cookie. The
 * default `SidebarProvider` writes the shared `sidebar_state` cookie on every
 * toggle; letting the console write that would collapse the project sidebar on
 * the next app load (the same reason the settings shell controls its own — see
 * the note in `sidebar.tsx`). Controlled state means the provider never touches
 * the shared cookie.
 */
export function AdminShell({
  children,
  initialOpen,
}: {
  children: React.ReactNode;
  initialOpen: boolean;
}) {
  const { data: adminRole, isLoading } = useAdminRole();

  const [open, setOpen] = useState(initialOpen);
  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    document.cookie = `${ADMIN_SIDEBAR_COOKIE}=${next}; path=/; max-age=${COOKIE_MAX_AGE}`;
  }, []);

  // The console is gated on a role the client has to ask for. Hold the app's
  // standard route loader until the answer lands, rather than paint the shell
  // and yank it back.
  if (isLoading) {
    return (
      <div className="bg-background flex min-h-svh w-full items-center justify-center">
        <RouteLoadingFallback />
      </div>
    );
  }

  if (!adminRole?.isAdmin) {
    return (
      <div className="bg-background flex min-h-svh w-full items-center justify-center p-4">
        <EmptyState
          icon={ShieldCheckIcon}
          title="Admin access required"
          description="This account does not hold admin permissions. Contact a workspace admin if that looks wrong."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href={PROJECT_LANDING_PATH}>Back to app</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <SidebarProvider open={open} onOpenChange={handleOpenChange} className="h-svh">
      <AdminSidebar />
      {/* Collapsed-only hover flyout on the viewport's left edge — the same
          affordance the project sidebar uses to peek back in. */}
      <SidebarEdgePeek />
      {/* Flush main. No `shadow-*`/`border` overrides needed: `variant="sidebar"`
          means SidebarInset adds no inset card, so there is no shadow or rounded
          corner to fight. */}
      <SidebarInset className="min-h-0 overflow-hidden">
        <AdminContent>{children}</AdminContent>
      </SidebarInset>
    </SidebarProvider>
  );
}

/**
 * The flush content column. The seam between panel and content is the
 * sidebar's own `border-r` (`variant="sidebar"`), which slides away with the
 * panel on collapse — so there is no dangling border and, unlike the `inset`
 * variant, no drop shadow or rounded corner over the content.
 */
function AdminContent({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-background relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <AdminHeader />
      {children}
    </div>
  );
}

/**
 * The 44px header over the content: the reopen/open toggle (only when it is
 * needed) and the `Admin / <page>` breadcrumb. The header is `shrink-0`; the
 * page content below it (`AdminPageShell`) is the scroll container.
 */
function AdminHeader() {
  const pathname = usePathname();
  const { state, isMobile } = useSidebar();
  const activeLabel = activeAdminLabel(pathname);

  // Show a toggle here only where the in-panel one is unreachable: on mobile
  // (the panel is a closed sheet) and while the desktop panel is collapsed. A
  // second toggle beside an already-open panel would just be noise.
  const showToggle = isMobile || state === 'collapsed';

  return (
    <header className="border-border flex h-11 shrink-0 items-center gap-1 border-b px-2">
      {showToggle ? <SidebarTrigger className="text-muted-foreground" /> : null}
      <Breadcrumb className="min-w-0 flex-1">
        <BreadcrumbList className="text-foreground flex-nowrap gap-1 text-sm font-medium sm:gap-1">
          <BreadcrumbItem className="min-w-0">
            {pathname === '/admin' ? (
              <span className="flex h-7 items-center px-2">Admin</span>
            ) : (
              <BreadcrumbLink asChild>
                <Link
                  href="/admin"
                  className="text-muted-foreground hover:text-foreground flex h-7 items-center px-2"
                >
                  Admin
                </Link>
              </BreadcrumbLink>
            )}
          </BreadcrumbItem>
          {activeLabel ? (
            <>
              <BreadcrumbSeparator>
                <span aria-hidden className="bg-border block h-3.5 w-px rotate-12" />
              </BreadcrumbSeparator>
              <BreadcrumbItem className="min-w-0">
                <BreadcrumbPage className="flex h-7 items-center truncate px-2 font-medium">
                  {activeLabel}
                </BreadcrumbPage>
              </BreadcrumbItem>
            </>
          ) : null}
        </BreadcrumbList>
      </Breadcrumb>
    </header>
  );
}
