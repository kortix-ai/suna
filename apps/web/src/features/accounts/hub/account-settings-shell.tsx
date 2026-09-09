'use client';

/**
 * The account hub's frame: the settings sidebar on the left, and on the right
 * a 44px breadcrumb bar (`Settings / <account> / <here>`) over the scrolling
 * content column.
 *
 * Mounted once, inside `AccountHubPanel`'s modal. Nothing here ever remounts
 * while the hub is open — switching section or account is a `replaceState` and
 * a render, so the sidebar and the bar simply keep their state. The sidebar
 * width is pinned to 300px and does not read the resizable project sidebar's
 * cookie; the two are different surfaces.
 */


import { Fragment, Suspense, useState, type CSSProperties, type ReactNode } from 'react';

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

import { useTranslations } from '@/i18n/use-translations';
import { HubLink, useAccountPanelId, useHubSearchParams } from './account-hub-location';
import { AccountSettingsSidebar } from './account-settings-sidebar';
import { accountHubCrumbs } from './sections';
import { useAccountDetail } from './use-account-detail';
import { useAccountHubSection } from './use-account-hub-access';

/** `--container-sidebar` in the design: 300px, not the project sidebar's 320. */
export const SETTINGS_SIDEBAR_WIDTH_PX = 300;


/** The toggle lives in the sidebar while it is docked; it moves here once hidden. */
function CollapsedTrigger() {
  const { state, isMobile } = useSidebar();
  if (state === 'expanded' && !isMobile) return null;
  return <SidebarTrigger className="text-muted-foreground" />;
}

/** Reads the URL's params, so it renders under `Suspense`. */
function ShellBreadcrumb() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const accountId = useAccountPanelId();
  const hubParams = useHubSearchParams();
  const { activeSection } = useAccountHubSection(accountId);
  const accountQuery = useAccountDetail(accountId);
  const crumbs = accountHubCrumbs(
    {
      accountId,
      activeSection,
      setup: hubParams.get('setup'),
      accountName: accountQuery.data?.name,
    },
    tI18nComplete,
  );

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
                ) : crumb.to ? (
                  <BreadcrumbLink
                    asChild
                    className="text-foreground hover:bg-hover flex h-7 min-w-0 items-center rounded-sm px-2"
                  >
                    <HubLink to={crumb.to} className="truncate">
                      {crumb.label}
                    </HubLink>
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
      // `h-full min-h-0`, not `min-h-svh`: the frame is the modal, which is
      // already `h-dvh`. A second viewport-height floor inside a fixed
      // full-screen box double-counts the viewport on mobile browsers whose
      // toolbars move.
      className={cn('bg-surface h-full min-h-0')}
      style={{ '--sidebar-width': `${SETTINGS_SIDEBAR_WIDTH_PX}px` } as CSSProperties}
    >
      <AccountSettingsSidebar />
      <SidebarInset className="bg-surface min-h-0">
        <header className="flex h-11 shrink-0 items-center gap-1 border-b px-2">
          <CollapsedTrigger />
          <Suspense fallback={null}>
            <ShellBreadcrumb />
          </Suspense>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
