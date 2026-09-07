'use client';

import type {
  SessionDisplayStatus,
  SessionSource,
  SessionSourceKind,
} from '@/components/projects/session-label';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { LocalTime } from '@/components/ui/local-time';
import { Slack } from '@/features/icon/icons/slack';
import { Telegram } from '@/features/icon/icons/telegram';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { ChangeRequest, ChangeRequestStatus } from '@kortix/sdk';
import {
  CalendarDotsIcon,
  CheckCircleIcon,
  EnvelopeIcon,
  GitDiffIcon,
  WebhooksLogoIcon,
  XCircleIcon,
  type Icon,
} from '@phosphor-icons/react';
import { formatDistanceToNowStrict } from 'date-fns';
import type { ComponentType, ReactElement } from 'react';
import { shortRelative } from './project-session-list-helpers';
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

const SOURCE_ICONS: Record<
  Exclude<SessionSourceKind, 'chat'>,
  ComponentType<{ className?: string }>
> = {
  slack: Slack,
  telegram: Telegram,
  email: EnvelopeIcon,
  schedule: CalendarDotsIcon,
  webhook: WebhooksLogoIcon,
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

function RelativeCreatedTime({ createdAt }: { createdAt: string }) {
  const createdDate = new Date(createdAt);
  const relativeTime = Number.isNaN(createdDate.getTime())
    ? '—'
    : shortRelative(formatDistanceToNowStrict(createdDate, { addSuffix: false }));

  return (
    <time
      dateTime={createdAt}
      className="text-muted-foreground shrink-0 text-xs tabular-nums"
      suppressHydrationWarning
    >
      {relativeTime}
    </time>
  );
}

function ChangeRequestStatusIcon({ status }: { status: ChangeRequestStatus }) {
  const StatusIcon = CHANGE_REQUEST_STATUS_ICON[status];

  return (
    <StatusIcon
      className={cn('size-4 shrink-0', CHANGE_REQUEST_STATUS_CLASS[status])}
      aria-hidden
    />
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
  const SourceIcon = source.kind === 'chat' ? null : SOURCE_ICONS[source.kind];
  const visibleChangeRequests = changeRequestLoadState === 'ready' ? changeRequests : [];

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <p className="text-foreground truncate text-sm leading-5 font-medium">{title}</p>
          <span className="shrink-0">
            <SessionStatusMark status={status} />
          </span>
        </div>
        <RelativeCreatedTime createdAt={createdAt} />
      </div>

      {SourceIcon ? (
        <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
          <SourceIcon className="size-4 shrink-0" />
          <span className="text-foreground min-w-0 truncate">
            {source.label}
            {source.triggerSlug ? (
              <span className="text-muted-foreground"> · {source.triggerSlug}</span>
            ) : null}
          </span>
        </div>
      ) : null}

      {visibleChangeRequests.length > 0 ? (
        <ul className="max-h-48 space-y-2 overflow-y-auto pr-1">
          {visibleChangeRequests.map((changeRequest) => (
            <li key={changeRequest.cr_id} className="flex min-w-0 items-center gap-2 text-xs">
              <ChangeRequestStatusIcon status={changeRequest.status} />
              <span className="text-foreground min-w-0 flex-1 truncate">{changeRequest.title}</span>
            </li>
          ))}
        </ul>
      ) : null}
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
        sideOffset={14}
        collisionPadding={8}
        className="w-72 p-3 shadow-xs"
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
      {changeRequestLoadState === 'ready' && changeRequests.length > 0
        ? `${t('changeRequests')}: ${changeRequests
            .map(
              (changeRequest) =>
                `#${changeRequest.number} ${changeRequest.title}, ${t(
                  CHANGE_REQUEST_STATUS_KEY[changeRequest.status],
                )}`,
            )
            .join('; ')}.`
        : null}
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
