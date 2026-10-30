'use client';

import { ApiError } from '@kortix/sdk';
import { useSetCaptureEnabled } from '@kortix/sdk/react';
import {
  BuildingsIcon,
  CaretDownIcon,
  CheckIcon,
  GearSixIcon,
  SignOutIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { notFound, usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import { ProjectPendingScreen } from '@/components/projects/project-pending-screen';
import { Button } from '@kortix/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@kortix/ui/dropdown-menu';
import { EntityAvatar } from '@kortix/ui/entity-avatar';
import Hint from '@kortix/ui/hint';
import { KortixLogo } from '@kortix/ui/kortix-logo';
import Loading from '@kortix/ui/loading';
import { errorToast } from '@kortix/ui/toast';
import { UserAvatar } from '@kortix/ui/user-avatar';
import { EmptyState } from '@kortix/ui/empty-state';
import { ErrorState } from '@kortix/ui/error-state';
import { HubLink } from '@kortix/ui/internal/account-hub/account-hub-location';
import { ThemeSubmenu, useLogoutFlow } from '@/features/layout/user-menu-shared';
import { useAuth } from '@/features/providers/auth-provider';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@kortix/ui';
import { hubTarget } from '@kortix/ui/internal/stores/account-panel-store';

import {
  CAPTURE_SECTIONS,
  captureHref,
  rememberCaptureAccount,
  sectionOf,
  useCaptureArea,
} from '@kortix/ui/internal/capture/use-capture-area';

/**
 * The frame of Kortix Capture: its own top bar (wordmark, Devices, the
 * organization switcher, Settings), no project sidebar. Gated on the account's Capture workspace: a non-member
 * gets the 404 the API gives; Capture switched off shows how to switch it on.
 */
export function CaptureAreaShell({
  accountId,
  children,
}: {
  accountId: string;
  children: ReactNode;
}) {
  const area = useCaptureArea(accountId);
  const t = useTranslations('capture.area');

  useEffect(() => {
    if (area.workspace.data) rememberCaptureAccount(accountId);
  }, [accountId, area.workspace.data]);

  if (area.workspace.isLoading) return <ProjectPendingScreen />;
  if (!area.workspace.data) {
    // Not a member (403) or no such account (404): the API's answer. Anything else
    // (offline, a timeout, a 5xx) is a failed read the person can retry.
    const status =
      area.workspace.error instanceof ApiError ? area.workspace.error.status : undefined;
    if (status === 403 || status === 404) notFound();
    return (
      <main className="flex min-h-svh items-center justify-center px-4">
        <ErrorState
          size="sm"
          title={t('loadFailed')}
          action={
            <Button variant="outline" size="sm" onClick={() => area.workspace.refetch()}>
              {t('tryAgain')}
            </Button>
          }
        />
      </main>
    );
  }

  return (
    // `data-kx-titlebar-owner`: the top bar is the way back to Kortix, so the
    // desktop window's own Back steps aside and the bar clears the traffic lights.
    <div className="bg-background flex min-h-svh flex-col" data-kx-titlebar-owner="">
      <CaptureTopBar accountId={accountId} />
      {area.enabled ? (
        children
      ) : (
        <main className="flex flex-1 items-center justify-center px-4 py-16">
          <CaptureOff accountId={accountId} canManage={area.canManage} name={area.accountName} />
        </main>
      )}
    </div>
  );
}

function CaptureOff({
  accountId,
  canManage,
  name,
}: {
  accountId: string;
  canManage: boolean;
  name: string;
}) {
  const t = useTranslations('capture.area');
  const setEnabled = useSetCaptureEnabled(accountId);
  return (
    <div className="flex max-w-sm flex-col items-center gap-4 text-center">
      <EmptyState
        size="sm"
        title={t('off.title', { name })}
        description={canManage ? t('off.bodyAdmin') : t('off.bodyMember')}
      />
      {canManage ? (
        <Button
          size="sm"
          disabled={setEnabled.isPending}
          onClick={() => setEnabled.mutate(true, { onError: () => errorToast(t('off.failed')) })}
        >
          {setEnabled.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
          {t('off.turnOn')}
        </Button>
      ) : null}
    </div>
  );
}

function CaptureTopBar({ accountId }: { accountId: string }) {
  const t = useTranslations('capture.area');
  const pathname = usePathname();
  const section = sectionOf(pathname);
  const area = useCaptureArea(accountId);
  return (
    <header
      data-sidebar-collapsed
      className="kx-titlebar-row kx-titlebar-band-height bg-background sticky top-0 z-30 flex h-12 shrink-0 items-center gap-4 overflow-x-auto border-b px-4"
    >
      <nav aria-label={t('breadcrumb')} className="flex items-center gap-1.5">
        <Hint label={t('backToKortix')}>
          <Link
            href="/projects"
            className="text-muted-foreground hover:bg-hover hover:text-foreground flex h-8 items-center gap-2 rounded-md px-2 text-sm font-medium transition-colors"
          >
            <KortixLogo variant="icon" size={14} />
            {t('kortix')}
          </Link>
        </Hint>
        <span aria-hidden className="text-muted-foreground text-sm">
          /
        </span>
        <Link
          href={captureHref(accountId, 'devices')}
          className="text-foreground px-1 text-sm font-semibold whitespace-nowrap"
        >
          {t('wordmark')}
        </Link>
      </nav>
      {area.enabled ? (
        <nav aria-label={t('wordmark')} className="flex flex-wrap items-center gap-0.5">
          {CAPTURE_SECTIONS.filter((item) => item !== 'settings' || area.canManage).map((item) => {
            const active = section === item;
            return (
              <Link
                key={item}
                href={captureHref(accountId, item)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-8 items-center rounded-md px-3 text-sm font-medium transition-colors',
                  active
                    ? 'bg-active text-foreground'
                    : 'text-muted-foreground hover:bg-hover hover:text-foreground',
                )}
              >
                {t(`nav.${item}`)}
              </Link>
            );
          })}
        </nav>
      ) : null}
      <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
        <AccountSwitcher accountId={accountId} />
        <ProfileMenu accountId={accountId} />
      </div>
    </header>
  );
}

/**
 * Who you are, and the way to everything outside Capture: this organization's
 * settings, your own settings (the accounts list), theme and log out. Kortix
 * Capture's own settings are the Settings tab.
 */
function ProfileMenu({ accountId }: { accountId: string }) {
  const t = useTranslations('capture.area');
  const tSidebar = useTranslations('sidebar');
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const deferAfterClose = (fn: () => void) => {
    setOpen(false);
    requestAnimationFrame(() => fn());
  };
  const { openConfirm, dialog } = useLogoutFlow(deferAfterClose);
  const email = user?.email ?? '';
  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-base"
            className="rounded-full"
            aria-label={t('signedInAs', { email })}
          >
            <UserAvatar email={email} size="sm" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="text-muted-foreground truncate font-normal">
            {email}
          </DropdownMenuLabel>
          <DropdownMenuItem asChild size="sm">
            <HubLink to={hubTarget(accountId)}>
              <BuildingsIcon />
              {tSidebar('workspace.accountSettings')}
            </HubLink>
          </DropdownMenuItem>
          <DropdownMenuItem asChild size="sm">
            <Link href="/settings/profile" prefetch>
              <GearSixIcon />
              {tSidebar('workspace.settings')}
            </Link>
          </DropdownMenuItem>
          <ThemeSubmenu />
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={openConfirm} size="sm">
            <SignOutIcon />
            {tSidebar('workspace.logOut')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Sibling of the dropdown, never a child — see `useLogoutFlow`. */}
      {dialog}
    </>
  );
}

/** The organization (Kortix account) the area shows; switching keeps the section. */
function AccountSwitcher({ accountId }: { accountId: string }) {
  const t = useTranslations('capture.area');
  const area = useCaptureArea(accountId);
  const router = useRouter();
  const section = sectionOf(usePathname());
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="max-w-56 gap-1.5"
          aria-label={t('switchOrg')}
        >
          <EntityAvatar label={area.accountName || '?'} size="xs" />
          <span className="min-w-0 truncate">{area.accountName}</span>
          <CaretDownIcon className="text-muted-foreground size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>{t('organizations')}</DropdownMenuLabel>
        {area.accounts.map((account) => (
          <DropdownMenuItem
            key={account.account_id}
            onSelect={() => router.push(captureHref(account.account_id, section))}
          >
            <EntityAvatar label={account.name} size="xs" />
            <span className="min-w-0 flex-1 truncate">{account.name}</span>
            {account.account_id === accountId ? <CheckIcon className="size-3.5 shrink-0" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One page of the area: title and description left, actions right, content
 * below. `width="full"` for the timeline, which uses the whole window.
 */
export function CapturePage({
  title,
  description,
  actions,
  breadcrumb,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 pt-7 pb-14 sm:px-8">
      <div className="flex flex-col gap-3">
        {breadcrumb}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <h1 className="text-foreground text-xl font-medium text-balance">{title}</h1>
            {description ? (
              <p className="text-muted-foreground text-sm text-pretty">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      </div>
      {children}
    </main>
  );
}
