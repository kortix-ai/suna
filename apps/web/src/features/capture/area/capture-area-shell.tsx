'use client';

import { ApiError } from '@kortix/sdk';
import { useSetCaptureEnabled } from '@kortix/sdk/react';
import { CalendarBlankIcon, CaretDownIcon, CheckIcon, GearSixIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { notFound, usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { ProjectPendingScreen } from '@/components/projects/project-pending-screen';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import Hint from '@/components/ui/hint';
import { KortixLogo } from '@/components/ui/kortix-logo';
import Loading from '@/components/ui/loading';
import { errorToast } from '@/components/ui/toast';
import { UserAvatar } from '@/components/ui/user-avatar';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useAuth } from '@/features/providers/auth-provider';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';

import {
  CAPTURE_RANGES,
  CAPTURE_SECTIONS,
  captureHref,
  rememberCaptureAccount,
  sectionOf,
  useCaptureArea,
  useCaptureRange,
  type CaptureRangeDays,
} from './use-capture-area';

/**
 * The frame of Kortix Capture: its own top bar (wordmark, Overview /
 * Workflows / Devices, the date range, the organization switcher), no
 * project sidebar. Gated on the account's Capture workspace: a non-member
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
    <div className="bg-background flex min-h-svh flex-col">
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
  const { user } = useAuth();
  return (
    <header
      data-sidebar-collapsed
      className="kx-titlebar-row bg-background sticky top-0 z-30 flex min-h-12 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-1.5"
    >
      <div className="flex items-center gap-2">
        <Hint label={t('backToKortix')}>
          <Link
            href="/projects"
            aria-label={t('backToKortix')}
            className="text-foreground hover:bg-hover flex size-8 items-center justify-center rounded-md transition-colors"
          >
            <KortixLogo variant="icon" size={16} />
          </Link>
        </Hint>
        <Link
          href={captureHref(accountId, area.readsEveryone ? 'overview' : 'devices')}
          className="text-foreground text-sm font-semibold whitespace-nowrap"
        >
          {t('wordmark')}
        </Link>
      </div>
      {area.enabled ? (
        <nav aria-label={t('wordmark')} className="flex flex-wrap items-center gap-0.5">
          {CAPTURE_SECTIONS.filter((item) => area.readsEveryone || item === 'devices').map(
            (item) => {
              const active =
                section === item || (item === 'devices' && section === 'this-computer');
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
            },
          )}
        </nav>
      ) : null}
      <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
        {area.enabled && (section === 'overview' || section === 'workflows') ? <RangeMenu /> : null}
        <AccountSwitcher accountId={accountId} />
        {area.isAdmin ? (
          <Hint label={t('nav.settings')}>
            <Button
              asChild
              variant="ghost"
              size="icon-sm"
              aria-label={t('nav.settings')}
              className={cn(section === 'settings' && 'bg-active')}
            >
              <Link
                href={captureHref(accountId, 'settings')}
                aria-current={section === 'settings' ? 'page' : undefined}
              >
                <GearSixIcon className="size-4 shrink-0" />
              </Link>
            </Button>
          </Hint>
        ) : null}
        {user ? (
          <span aria-label={t('signedInAs', { email: user.email ?? '' })} role="img">
            <UserAvatar email={user.email ?? ''} size="sm" />
          </span>
        ) : null}
      </div>
    </header>
  );
}

function RangeMenu() {
  const t = useTranslations('capture.area');
  const range = useCaptureRange();
  const label = (days: CaptureRangeDays) =>
    days === 1 ? t('range.today') : t('range.lastDays', { days });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5" aria-label={t('range.label')}>
          <CalendarBlankIcon className="size-3.5 shrink-0" />
          {label(range.days)}
          <CaretDownIcon className="text-muted-foreground size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuRadioGroup
          value={String(range.days)}
          onValueChange={(value) => range.setDays(Number(value) as CaptureRangeDays)}
        >
          {CAPTURE_RANGES.map((days) => (
            <DropdownMenuRadioItem key={days} value={String(days)}>
              {label(days)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The organization (Kortix account) the area shows; switching keeps the section. */
function AccountSwitcher({ accountId }: { accountId: string }) {
  const t = useTranslations('capture.area');
  const area = useCaptureArea(accountId);
  const router = useRouter();
  const section = sectionOf(usePathname());
  const keep = section === 'this-computer' ? 'devices' : section;
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
            onSelect={() => router.push(captureHref(account.account_id, keep))}
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
