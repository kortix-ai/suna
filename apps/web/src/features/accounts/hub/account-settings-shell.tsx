'use client';

/**
 * The frame every `/accounts/**` route renders inside: the settings sidebar
 * on the left, and on the right a 44px breadcrumb bar (`Settings / <here>`)
 * over the scrolling content column.
 *
 * Mounted by `app/(app)/accounts/layout.tsx`, which is what makes the
 * sidebar survive a route change — the account hub, the token detail page,
 * and the two guided-setup wizards all sit in this one frame. The sidebar
 * width is pinned to 300px here and does not read the resizable project
 * sidebar's cookie; the two are different surfaces.
 */

import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { Fragment, lazy, Suspense, useState, type CSSProperties, type ReactNode } from 'react';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import { AccountSettingsSidebar } from './account-settings-sidebar';
import { accountHubCrumbs } from './sections';
import { useAccountDetail } from './use-account-detail';
import { useAccountHubSection } from './use-account-hub-access';

/** `--container-sidebar` in the design: 300px, not the project sidebar's 320. */
export const SETTINGS_SIDEBAR_WIDTH_PX = 300;

// Lazy for the same reason `AppHeader` lazy-loads it: the palette is a large
// chunk nobody needs on first paint. The sidebar's search button asks for it
// through `openCommandPalette()`, which buffers the request until this mounts.
const CommandPalette = lazy(() =>
  import('@/features/workspace/command-palette').then((mod) => ({
    default: mod.CommandPalette,
  })),
);

/** The toggle lives in the sidebar while it is docked; it moves here once hidden. */
function CollapsedTrigger() {
  const { state, isMobile } = useSidebar();
  if (state === 'expanded' && !isMobile) return null;
  return <SidebarTrigger className="text-muted-foreground" />;
}

/** Reads the route and `?tab=`, so it renders under `Suspense`. */
function ShellBreadcrumb() {
  const pathname = usePathname();
  const params = useParams<{ id?: string }>();
  const accountId = params?.id;
  const { activeSection } = useAccountHubSection(accountId);
  const accountQuery = useAccountDetail(accountId);
  const crumbs = accountHubCrumbs(pathname, accountId, activeSection, accountQuery.data?.name);

  return (
    <Breadcrumb className="min-w-0 flex-1">
      <BreadcrumbList className="text-foreground flex-nowrap gap-1 text-sm font-medium sm:gap-1">
        {crumbs.map((crumb, index) => {
          // The account crumb and the slash before it leave below `md`.
          const desktopOnly = crumb.kind === 'account';
          return (
            <Fragment key={`${index}:${crumb.label}`}>
              {index > 0 ? (
                <BreadcrumbSeparator className={cn(desktopOnly && 'hidden md:block')}>
                  <span aria-hidden className="bg-border block h-3.5 w-px rotate-12" />
                </BreadcrumbSeparator>
              ) : null}
              <BreadcrumbItem className={cn('min-w-0', desktopOnly && 'hidden md:inline-flex')}>
                {crumb.pending ? (
                  <Skeleton className="mx-2 h-4 w-24 rounded-sm" />
                ) : crumb.href ? (
                  <BreadcrumbLink
                    asChild
                    className="text-foreground hover:bg-hover flex h-7 min-w-0 items-center rounded-sm px-2"
                  >
                    <Link href={crumb.href} className="truncate">
                      {crumb.label}
                    </Link>
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage className="flex h-7 items-center truncate px-2 font-medium">
                    {crumb.label}
                  </BreadcrumbPage>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

export function AccountSettingsShell({ children }: { children: ReactNode }) {
  // Controlled, so the provider does not persist this shell's open state into
  // the `sidebar_state` cookie the project sidebar reads on its next load.
  const [open, setOpen] = useState(true);

  return (
    <SidebarProvider
      open={open}
      onOpenChange={setOpen}
      className="h-svh"
      style={{ '--sidebar-width': `${SETTINGS_SIDEBAR_WIDTH_PX}px` } as CSSProperties}
    >
      <AccountSettingsSidebar />
      <SidebarInset className="min-h-0">
        <header className="flex h-11 shrink-0 items-center gap-1 border-b px-2">
          <CollapsedTrigger />
          <Suspense fallback={null}>
            <ShellBreadcrumb />
          </Suspense>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </SidebarInset>
      <Suspense fallback={null}>
        <CommandPalette />
      </Suspense>
    </SidebarProvider>
  );
}
