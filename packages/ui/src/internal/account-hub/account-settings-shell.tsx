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


import { getProject } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { Fragment, Suspense, useState, type CSSProperties, type ReactNode } from 'react';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '../../primitives/breadcrumb';
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from '../../primitives/sidebar';
import { Skeleton } from '../../primitives/skeleton';
import { cn } from '../lib/utils';

import { useTranslations } from '../../i18n';
import { HubLink, useAccountPanelId, useHubSearchParams } from './account-hub-location';
import { AccountSettingsSidebar } from './account-settings-sidebar';
import { AccountHubSheetProvider } from './hub-sheet';
import { accountHubCrumbs } from './sections';
import { useAccountDetail } from './use-account-detail';
import { useAccountHubSection } from './use-account-hub-access';
import { useAccountMembers } from './use-account-members';

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
  // Same key as the Members pane: the member crumb costs no request.
  const membersQuery = useAccountMembers(accountId);
  const memberId = hubParams.get('member');
  const member = memberId
    ? membersQuery.data?.find((entry) => entry.user_id === memberId)
    : undefined;
  // Same key as the project access panel: the project crumb costs no request.
  const projectId = activeSection === 'access-projects' ? hubParams.get('project') : null;
  const projectQuery = useQuery({
    queryKey: qk.project.summary(projectId ?? ''),
    queryFn: () => getProject(projectId!),
    enabled: !!projectId,
    ...contract('config'),
  });
  const crumbs = accountHubCrumbs(
    {
      accountId,
      activeSection,
      setup: hubParams.get('setup'),
      accountName: accountQuery.data?.name,
      memberId,
      memberName: member ? member.email || member.user_id : null,
      projectId,
      projectName: projectId ? projectQuery.data?.name : null,
    },
    tI18nComplete,
  );

  return (
    <Breadcrumb className="min-w-0 flex-1">
      {/* Ancestors are muted links with a hover fill; the page you are on is
          ink. Every crumb is one 28px lane, so the slashes and the hover
          fills share a centre line. Long names cap and truncate (the full
          name is the hover title) so the bar never wraps or pushes. */}
      <BreadcrumbList className="flex-nowrap items-center gap-0.5 text-sm sm:gap-0.5">
        {crumbs.map((crumb, index) => {
          // The account crumb and the slash before it leave below `md`.
          const desktopOnly = crumb.kind === 'account';
          const cap = crumb.kind === 'account' ? 'max-w-56' : 'max-w-64';
          return (
            <Fragment key={`${index}:${crumb.label}`}>
              {index > 0 ? (
                <BreadcrumbSeparator className={cn('text-border', desktopOnly && 'hidden md:block')}>
                  <span aria-hidden className="bg-border block h-3.5 w-px rotate-12" />
                </BreadcrumbSeparator>
              ) : null}
              <BreadcrumbItem className={cn('min-w-0', desktopOnly && 'hidden md:inline-flex')}>
                {crumb.pending ? (
                  <Skeleton className="mx-2 h-4 w-24 rounded-sm" />
                ) : crumb.to ? (
                  <BreadcrumbLink
                    asChild
                    className={cn(
                      'text-muted-foreground hover:bg-hover hover:text-foreground flex h-7 min-w-0 items-center rounded-md px-2',
                      cap,
                    )}
                  >
                    <HubLink to={crumb.to} title={crumb.label}>
                      <span className="truncate">{crumb.label}</span>
                    </HubLink>
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage
                    title={crumb.label}
                    className={cn('text-foreground flex h-7 items-center px-2 font-medium', cap)}
                  >
                    <span className="truncate">{crumb.label}</span>
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
        <header
          className="kx-titlebar-row kx-titlebar-band-height kx-account-hub-header flex h-11 shrink-0 items-center gap-1 border-b px-2"
          data-sidebar-collapsed={open ? undefined : ''}
        >
          <CollapsedTrigger />
          <Suspense fallback={null}>
            <ShellBreadcrumb />
          </Suspense>
        </header>
        {/* Bounded, not scrolling: the hub sheet splits this column, and the
            page and the sheet each scroll inside their own half. */}
        <div className="min-h-0 flex-1">
          <AccountHubSheetProvider>{children}</AccountHubSheetProvider>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
