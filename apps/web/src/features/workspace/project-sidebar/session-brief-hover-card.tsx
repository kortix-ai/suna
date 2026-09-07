'use client';

import type { SessionDisplayStatus, SessionSource } from '@/components/projects/session-label';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { LocalTime } from '@/components/ui/local-time';
import { Skeleton } from '@/components/ui/skeleton';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { ChangeRequest, ChangeRequestStatus } from '@kortix/sdk';
import { CheckCircleIcon, GitDiffIcon, XCircleIcon, type Icon } from '@phosphor-icons/react';
import type { ReactElement } from 'react';
import { SessionStatusMark } from './session-status-mark';

const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

const CHANGE_REQUEST_STATUS_ICON: Record<ChangeRequestStatus, Icon> = {
  open: GitDiffIcon,
  merged: CheckCircleIcon,
  closed: XCircleIcon,
};

const CHANGE_REQUEST_STATUS_CLASS: Record<ChangeRequestStatus, string> = {
  open: 'text-kortix-blue',
  merged: 'text-kortix-green',
  closed: 'text-muted-foreground',
};

const CHANGE_REQUEST_STATUS_KEY: Record<
  ChangeRequestStatus,
  'changeRequestStatus.open' | 'changeRequestStatus.merged' | 'changeRequestStatus.closed'
> = {
  open: 'changeRequestStatus.open',
  merged: 'changeRequestStatus.merged',
  closed: 'changeRequestStatus.closed',
};

export type ChangeRequestLoadState = 'loading' | 'error' | 'ready';

interface SessionBriefProps {
  title: string;
  status: SessionDisplayStatus;
  createdAt: string;
  source: SessionSource;
  changeRequests: readonly ChangeRequest[];
  changeRequestLoadState: ChangeRequestLoadState;
}

function useStatusLabel(status: SessionDisplayStatus): string {
  const t = useTranslations('sidebar.sessionList.status');
  const keys: Record<SessionDisplayStatus, Parameters<typeof t>[0]> = {
    'needs-you': 'needsYou',
    starting: 'starting',
    running: 'running',
    done: 'done',
    stopped: 'stopped',
    failed: 'failed',
    legacy: 'legacy',
  };
  return t(keys[status]);
}

function SessionCreatedTime({ createdAt, className }: { createdAt: string; className?: string }) {
  return (
    <time dateTime={createdAt} className={className}>
      <LocalTime value={createdAt} options={DATE_TIME_OPTIONS} fallback="—" />
    </time>
  );
}

function ChangeRequestStatus({ status }: { status: ChangeRequestStatus }) {
  const t = useTranslations('sidebar.sessionList.brief');
  const label = t(CHANGE_REQUEST_STATUS_KEY[status]);
  const StatusIcon = CHANGE_REQUEST_STATUS_ICON[status];

  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-end gap-1 text-xs font-medium',
        CHANGE_REQUEST_STATUS_CLASS[status],
      )}
    >
      <StatusIcon className="size-3.5" aria-hidden />
      {label}
    </span>
  );
}

function SessionBriefContent({
  title,
  status,
  createdAt,
  source,
  changeRequests,
  changeRequestLoadState,
}: SessionBriefProps) {
  const t = useTranslations('sidebar.sessionList.brief');
  const statusLabel = useStatusLabel(status);
  const hasExternalSource = source.kind !== 'chat';

  return (
    <div className="space-y-3">
      <p className="text-foreground line-clamp-2 text-sm leading-5 font-medium">{title}</p>

      <dl className="space-y-2 text-xs">
        <div className="flex items-center gap-3">
          <dt className="text-muted-foreground w-16 shrink-0">{t('status')}</dt>
          <dd className="text-foreground flex min-w-0 items-center gap-1.5 font-medium">
            <SessionStatusMark status={status} />
            <span className="truncate">{statusLabel}</span>
          </dd>
        </div>
        <div className="flex items-center gap-3">
          <dt className="text-muted-foreground w-16 shrink-0">{t('created')}</dt>
          <dd className="text-foreground min-w-0 tabular-nums">
            <SessionCreatedTime createdAt={createdAt} />
          </dd>
        </div>
        {hasExternalSource && (
          <div className="flex items-center gap-3">
            <dt className="text-muted-foreground w-16 shrink-0">{t('source')}</dt>
            <dd className="text-foreground min-w-0 truncate">
              {source.label}
              {source.triggerSlug ? (
                <span className="text-muted-foreground"> · {source.triggerSlug}</span>
              ) : null}
            </dd>
          </div>
        )}
      </dl>

      <div className="border-border border-t pt-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-muted-foreground text-xs font-medium">{t('changeRequests')}</p>
          {changeRequestLoadState === 'ready' && changeRequests.length > 0 ? (
            <span className="text-muted-foreground text-xs tabular-nums">
              {changeRequests.length}
            </span>
          ) : null}
        </div>

        {changeRequestLoadState === 'loading' ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        ) : changeRequestLoadState === 'error' ? (
          <p className="text-destructive text-xs">{t('changeRequestsUnavailable')}</p>
        ) : changeRequests.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t('noChangeRequests')}</p>
        ) : (
          <ul className="max-h-48 space-y-2 overflow-y-auto pr-1">
            {changeRequests.map((changeRequest) => (
              <li key={changeRequest.cr_id} className="flex items-start gap-2 text-xs">
                <span className="text-muted-foreground w-7 shrink-0 font-mono tabular-nums">
                  #{changeRequest.number}
                </span>
                <span className="text-foreground line-clamp-2 min-w-0 flex-1 leading-4">
                  {changeRequest.title}
                </span>
                <ChangeRequestStatus status={changeRequest.status} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function SessionBriefHoverCard({
  children,
  ...brief
}: SessionBriefProps & { children: ReactElement }) {
  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        aria-hidden
        side="right"
        align="start"
        sideOffset={8}
        collisionPadding={8}
        className="w-72 p-3 shadow-md"
      >
        <SessionBriefContent {...brief} />
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * The same brief remains available to keyboard and screen-reader users when
 * the visual HoverCard is absent or intentionally ignored by assistive tech.
 */
export function SessionBriefDescription({
  id,
  status,
  createdAt,
  source,
  changeRequests,
  changeRequestLoadState,
}: SessionBriefProps & { id: string }) {
  const t = useTranslations('sidebar.sessionList.brief');
  const statusLabel = useStatusLabel(status);

  return (
    <span id={id} className="sr-only">
      {t('status')}: {statusLabel}. {t('created')}: <SessionCreatedTime createdAt={createdAt} />.
      {source.kind !== 'chat'
        ? ` ${t('source')}: ${source.label}${source.triggerSlug ? `, ${source.triggerSlug}` : ''}.`
        : null}{' '}
      {changeRequestLoadState === 'loading'
        ? t('changeRequestsLoading')
        : changeRequestLoadState === 'error'
          ? t('changeRequestsUnavailable')
          : changeRequests.length === 0
            ? t('noChangeRequests')
            : `${t('changeRequests')}: ${changeRequests
                .map(
                  (changeRequest) =>
                    `#${changeRequest.number} ${changeRequest.title}, ${t(
                      CHANGE_REQUEST_STATUS_KEY[changeRequest.status],
                    )}`,
                )
                .join('; ')}.`}
    </span>
  );
}

export function MobileSessionCreatedTime({ createdAt }: { createdAt: string }) {
  return (
    <SessionCreatedTime
      createdAt={createdAt}
      className="text-muted-foreground block truncate text-xs leading-4 tabular-nums"
    />
  );
}
