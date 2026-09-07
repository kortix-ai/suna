'use client';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import type {
  SessionDisplayStatus,
  SessionSource,
  SessionSourceKind,
} from '@/components/projects/session-label';
import { LocalTime } from '@/components/ui/local-time';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Slack } from '@/features/icon/icons/slack';
import { Telegram } from '@/features/icon/icons/telegram';
import { CR_ID_PREFIX } from '@/features/review-center/review-actions';
import { capabilityTabHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';
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
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type FocusEvent,
  type ReactElement,
} from 'react';
import { shortRelative } from './project-session-list-helpers';
import { SessionStatusMark } from './session-status-mark';

const HOVER_OPEN_DELAY_MS = 200;
const HOVER_CLOSE_DELAY_MS = 100;

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

interface SessionBriefInteractionProps {
  projectId: string;
  reviewEnabled: boolean;
  onOpenChangeRequest: (changeRequestId: string) => void;
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

const CHANGE_REQUEST_ACTION_CLASS =
  'hover:bg-accent focus-visible:ring-ring -mx-1 flex min-h-6 w-[calc(100%+0.5rem)] min-w-0 cursor-pointer items-center gap-2 rounded-sm px-1 text-left text-xs focus-visible:ring-2 focus-visible:outline-none';

function ChangeRequestAction({
  changeRequest,
  projectId,
  reviewEnabled,
  onOpenChangeRequest,
  onDismiss,
}: {
  changeRequest: ChangeRequest;
  projectId: string;
  reviewEnabled: boolean;
  onOpenChangeRequest: (changeRequestId: string) => void;
  onDismiss: () => void;
}) {
  const content = (
    <>
      <ChangeRequestStatusIcon status={changeRequest.status} />
      <span className="text-foreground min-w-0 flex-1 truncate">{changeRequest.title}</span>
    </>
  );

  if (reviewEnabled) {
    const reviewItemId = `${CR_ID_PREFIX}${changeRequest.cr_id}`;
    const href = `${capabilityTabHref(projectId, 'review')}?id=${encodeURIComponent(reviewItemId)}`;
    return (
      <HoverPrefetchLink href={href} onClick={onDismiss} className={CHANGE_REQUEST_ACTION_CLASS}>
        {content}
      </HoverPrefetchLink>
    );
  }

  return (
    <button
      type="button"
      className={CHANGE_REQUEST_ACTION_CLASS}
      onClick={() => {
        onDismiss();
        onOpenChangeRequest(changeRequest.cr_id);
      }}
    >
      {content}
    </button>
  );
}

function SessionBriefContent({
  title,
  status,
  createdAt,
  source,
  changeRequests,
  changeRequestLoadState,
  projectId,
  reviewEnabled,
  onOpenChangeRequest,
  onDismiss,
}: SessionBriefProps & SessionBriefInteractionProps & { onDismiss: () => void }) {
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
            <li key={changeRequest.cr_id}>
              <ChangeRequestAction
                changeRequest={changeRequest}
                projectId={projectId}
                reviewEnabled={reviewEnabled}
                onOpenChangeRequest={onOpenChangeRequest}
                onDismiss={onDismiss}
              />
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
}: SessionBriefProps & SessionBriefInteractionProps & { children: ReactElement }) {
  const [open, setOpen] = useState(false);
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const openNow = useCallback(() => {
    clearTimer();
    setOpen(true);
  }, [clearTimer]);

  const updateAfterDelay = useCallback(
    (nextOpen: boolean, delay: number) => {
      clearTimer();
      timer.current = setTimeout(() => setOpen(nextOpen), delay);
    },
    [clearTimer],
  );

  const handleContentBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      updateAfterDelay(false, HOVER_CLOSE_DELAY_MS);
    }
  };

  // Radix HoverCard makes every descendant untabbable. Popover preserves the
  // same hover behavior while keeping each change-request action keyboardable.
  // Mount its portal beside the trigger so those actions follow it in Tab order.
  return (
    <div ref={setPortalContainer} className="contents">
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          clearTimer();
          setOpen(nextOpen);
        }}
      >
        <PopoverTrigger
          asChild
          onPointerEnter={() => updateAfterDelay(true, HOVER_OPEN_DELAY_MS)}
          onPointerLeave={() => updateAfterDelay(false, HOVER_CLOSE_DELAY_MS)}
          onFocus={openNow}
          onBlur={() => updateAfterDelay(false, HOVER_CLOSE_DELAY_MS)}
        >
          {children}
        </PopoverTrigger>
        <PopoverContent
          container={portalContainer ?? undefined}
          side="right"
          align="start"
          sideOffset={14}
          className="w-72 p-3 shadow-xs"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onPointerEnter={openNow}
          onPointerLeave={() => updateAfterDelay(false, HOVER_CLOSE_DELAY_MS)}
          onFocusCapture={openNow}
          onBlurCapture={handleContentBlur}
        >
          <SessionBriefContent {...brief} onDismiss={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
    </div>
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
