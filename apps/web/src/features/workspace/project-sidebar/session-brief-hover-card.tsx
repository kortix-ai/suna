'use client';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import type { SessionDisplayStatus, SessionSource } from '@/components/projects/session-label';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { LocalTime } from '@/components/ui/local-time';
import { menuRow } from '@/components/ui/menu-recipe';
import { CR_ID_PREFIX } from '@/features/review-center/review-actions';
import { capabilityTabHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';
import { useTranslations } from '@/i18n/use-translations';
import { useSessionHoverStore } from '@/stores/session-hover-store';
import type { ChangeRequest, ChangeRequestStatus } from '@kortix/sdk';
import { GitDiffIcon } from '@phosphor-icons/react';
import { formatDistanceToNowStrict } from 'date-fns';
import { useEffect, type ReactElement } from 'react';
import { shortRelative } from './project-session-list-helpers';
import { SOURCE_ICONS } from './session-source-icons';
import { SessionStatusMark } from './session-status-mark';

const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

/**
 * Every change request wears the same glyph. Swapping the shape as well as the
 * colour made three states look like three different KINDS of object in a list
 * that holds one kind; the row already says "change request" by being in this
 * list, so the icon repeats that and the colour carries the only thing that
 * varies. Same split GitHub makes, and the same hues: in review, merged, closed.
 */
const CHANGE_REQUEST_STATUS_CLASS: Record<ChangeRequestStatus, string> = {
  open: 'text-kortix-blue',
  merged: 'text-kortix-green',
  closed: 'text-kortix-red',
};

const CHANGE_REQUEST_STATUS_KEY: Record<
  ChangeRequestStatus,
  'changeRequestStatus.open' | 'changeRequestStatus.merged' | 'changeRequestStatus.closed'
> = {
  open: 'changeRequestStatus.open',
  merged: 'changeRequestStatus.merged',
  closed: 'changeRequestStatus.closed',
};

interface SessionBrief {
  title: string;
  status: SessionDisplayStatus;
  createdAt: string;
  source: SessionSource;
  changeRequests: readonly ChangeRequest[];
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

/**
 * One change request as a row in the panel's list.
 *
 * It wears `menuRow` rather than local padding, for the same reason the footer's
 * open-change chooser does: this is the app-wide floating-list row, and hand-rolled
 * padding is how two lists that should line up stop lining up. The recipe also
 * owns the icon box (`[&_svg]:size-4`), so the status glyph carries colour only.
 */
function ChangeRequestRow({
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
  const className = menuRow('sm', 'default', 'cursor-pointer py-1.5 text-left');
  const content = (
    <>
      <GitDiffIcon className={CHANGE_REQUEST_STATUS_CLASS[changeRequest.status]} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{changeRequest.title}</span>
    </>
  );

  // Same split the footer change-requests pill makes: with the Review Center on,
  // every change opens in the unified inbox; with it off, the legacy per-CR
  // dialog is still the only detail view there is.
  if (reviewEnabled) {
    const reviewItemId = `${CR_ID_PREFIX}${changeRequest.cr_id}`;
    const href = `${capabilityTabHref(projectId, 'review')}?id=${encodeURIComponent(reviewItemId)}`;
    return (
      <HoverPrefetchLink href={href} onClick={onDismiss} className={className}>
        {content}
      </HoverPrefetchLink>
    );
  }

  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        onDismiss();
        onOpenChangeRequest(changeRequest.cr_id);
      }}
    >
      {content}
    </button>
  );
}

/**
 * The panel: an identity block, then the changes this session proposed.
 *
 * The two halves are separated by a hairline because only the lower one is
 * clickable. Without the seam a hover highlight appears on the third line and
 * not the first two, with nothing to explain why — the rule reads as "below
 * this, things are targets".
 *
 * `px-3.5` on the header is not a guess: the list is `p-1` and its rows are
 * `px-2.5`, so 3.5 spacing steps is exactly where the row labels start. The
 * title and the change titles share one left edge.
 */
function SessionBriefContent({
  title,
  status,
  createdAt,
  source,
  changeRequests,
  projectId,
  reviewEnabled,
  onOpenChangeRequest,
  onDismiss,
}: SessionBrief & SessionBriefInteractionProps & { onDismiss: () => void }) {
  const SourceIcon = source.kind === 'chat' ? null : SOURCE_ICONS[source.kind];

  return (
    <>
      <div className="space-y-1.5 px-3.5 py-2.5">
        <div className="flex items-center gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <p className="text-foreground truncate text-sm font-medium">{title}</p>
            <span className="shrink-0">
              <SessionStatusMark status={status} />
            </span>
          </div>
          <RelativeCreatedTime createdAt={createdAt} />
        </div>

        {SourceIcon ? (
          <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
            <SourceIcon className="size-3.5 shrink-0" />
            <span className="text-foreground min-w-0 truncate">
              {source.label}
              {source.triggerSlug ? (
                <span className="text-muted-foreground"> · {source.triggerSlug}</span>
              ) : null}
            </span>
          </div>
        ) : null}
      </div>

      {changeRequests.length > 0 ? (
        <ul className="border-border max-h-64 overflow-y-auto overscroll-contain border-t p-1">
          {changeRequests.map((changeRequest) => (
            <li key={changeRequest.cr_id}>
              <ChangeRequestRow
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
    </>
  );
}

/**
 * Radix HoverCard strips every tab stop inside its content — `getTabbableNodes`
 * runs on each render and sets `tabindex="-1"` — because a hover card is a
 * preview surface, not a menu. Pointer clicks and `cmd`-clicks on the change
 * rows still work; the keyboard route to the same changes is the footer's
 * Review pill, which is a Popover and therefore fully tabbable. Do not try to
 * restore focusability here: the effect has no dependency array and will
 * overwrite whatever you set on the next commit.
 *
 * Timing and exclusivity belong to `useSessionHoverStore`, not to this instance,
 * because both are properties of the LIST: only one card may be open at a time,
 * and the second row the pointer visits must not pay the opening delay again.
 * Radix's own delays are zeroed and its `onOpenChange` left unwired — with
 * `closeDelay={0}` it would report a close the instant the pointer left the row,
 * cancelling the window in which the pointer travels into the card. The store is
 * the only thing that decides whether this card is showing.
 *
 * `animated={false}` for the reason submenus opt out of their enter animation:
 * the card opens to the right, into the path the pointer is already taking, so
 * an enter animation is time spent moving content away from the hand.
 */
export function SessionBriefHoverCard({
  sessionId,
  children,
  ...brief
}: SessionBrief & SessionBriefInteractionProps & { sessionId: string; children: ReactElement }) {
  const open = useSessionHoverStore((state) => state.activeSessionId === sessionId);
  const openSession = useSessionHoverStore((state) => state.openSession);
  const closeSession = useSessionHoverStore((state) => state.closeSession);
  const dismiss = useSessionHoverStore((state) => state.dismiss);

  // A row can be filtered out, or the sidebar unmounted, while its card shows.
  // Without this the store keeps naming a row that no longer exists and the
  // group is still warm the next time the list mounts.
  useEffect(
    () => () => {
      const store = useSessionHoverStore.getState();
      if (store.activeSessionId === sessionId) store.dismiss();
    },
    [sessionId],
  );

  return (
    <HoverCard open={open} openDelay={0} closeDelay={0}>
      <HoverCardTrigger
        asChild
        onPointerEnter={() => openSession(sessionId)}
        onPointerLeave={() => closeSession(sessionId)}
        onFocus={() => openSession(sessionId)}
        onBlur={() => closeSession(sessionId)}
      >
        {children}
      </HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="start"
        sideOffset={14}
        animated={false}
        className="w-72 overflow-hidden rounded-md p-0 shadow-xs"
        onPointerEnter={() => openSession(sessionId)}
        onPointerLeave={() => closeSession(sessionId)}
        // WCAG 1.4.13: content shown on hover must be dismissible without moving
        // the pointer. Radix's own dismissal path runs through `setOpen`, which
        // is inert here because the store owns `open`, so Escape is wired
        // straight to the store. DismissableLayer listens on the document, so it
        // fires even though nothing inside the card can hold focus.
        onEscapeKeyDown={dismiss}
      >
        <SessionBriefContent {...brief} onDismiss={dismiss} />
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
}: Omit<SessionBrief, 'title'> & { id: string }) {
  const t = useTranslations('sidebar.sessionList.brief');
  const statusLabel = useStatusLabel(status);

  return (
    <span id={id} className="sr-only">
      {t('status')}: {statusLabel}. {t('created')}: <SessionCreatedTime createdAt={createdAt} />.
      {source.kind !== 'chat'
        ? ` ${t('source')}: ${source.label}${source.triggerSlug ? `, ${source.triggerSlug}` : ''}.`
        : null}{' '}
      {changeRequests.length > 0
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
