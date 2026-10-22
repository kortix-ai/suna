'use client';

import { HoverPrefetchLink } from '../../internal/components/hover-prefetch-link';
import {
  SESSION_STATUS_TRANSLATION_KEY,
  type SessionDisplayStatus,
  type SessionSource,
} from '../../session/actions/session-label';
import { FLOATING_PANEL_SURFACE } from '../../primitives/menu-recipe';
import { usePortalContainer } from '../../lib/portal-container';
import { cn } from '../../lib/utils';
import { floatingZ, useDialogDepth } from '../../lib/z-stack';
import { LocalTime } from '../../primitives/local-time';
import { menuRow } from '../../primitives/menu-recipe';
import { CR_ID_PREFIX } from '../review/review-actions';
import { reviewHref } from '../../internal/lib/capability-tab-routes';
import { useTranslations } from '../../i18n';
import { useSessionHoverStore } from '../../internal/stores/session-hover-store';
import type { ChangeRequest, ChangeRequestStatus } from '@kortix/sdk';
import { ArrowsSplitIcon, GitDiffIcon, RobotIcon } from '@phosphor-icons/react';
import { formatDistanceToNowStrict } from 'date-fns';
import { Slot } from 'radix-ui';
import { useEffect, useLayoutEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { shortRelative } from '../../session/actions/project-session-list-helpers';
import { SessionLabelBadges } from '../sessions/session-label-badges';
import { SOURCE_ICONS } from './session-source-icons';
import { isReviewOverdue, SessionStatusMark } from './session-status-mark';

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
  /** The session's free-form labels; the sidebar row has no room for them. */
  labels?: readonly string[];
  /** `needs-you` only: what the session waits on, see `SessionStatusMark`. */
  waitingOn?: 'answer' | 'review';
  /** The session was spawned by another one and is drawn under it. */
  spawned?: boolean;
  /** What this session started: its sub-agents and the sessions it spawned. */
  subagentCount?: number;
  spawnedCount?: number;
}

interface SessionBriefInteractionProps {
  projectId: string;
}

function useStatusLabel(status: SessionDisplayStatus, waitingOn?: 'answer' | 'review'): string {
  const t = useTranslations('sidebar.sessionList.status');
  if (status === 'needs-you' && waitingOn === 'answer') return t('needsInput');
  return t(SESSION_STATUS_TRANSLATION_KEY[status]);
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
  onDismiss,
}: {
  changeRequest: ChangeRequest;
  projectId: string;
  onDismiss: () => void;
}) {
  const className = menuRow('sm', 'default', 'cursor-pointer py-1.5 text-left');
  const content = (
    <>
      <GitDiffIcon className={CHANGE_REQUEST_STATUS_CLASS[changeRequest.status]} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{changeRequest.title}</span>
    </>
  );

  // Every change opens in the Review Center inbox, the same place the footer
  // Review pill leads.
  const reviewItemId = `${CR_ID_PREFIX}${changeRequest.cr_id}`;
  const review = reviewHref(projectId);
  // A host without the Review page lists the change without a link.
  if (!review) return <div className={menuRow('sm', 'default', 'py-1.5 text-left')}>{content}</div>;
  const href = `${review}?id=${encodeURIComponent(reviewItemId)}`;
  return (
    <HoverPrefetchLink href={href} onClick={onDismiss} className={className}>
      {content}
    </HoverPrefetchLink>
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
  labels,
  waitingOn,
  spawned = false,
  subagentCount = 0,
  spawnedCount = 0,
  projectId,
  onDismiss,
}: SessionBrief & SessionBriefInteractionProps & { onDismiss: () => void }) {
  const SourceIcon = source.kind === 'chat' ? null : SOURCE_ICONS[source.kind];
  const statusLabel = useStatusLabel(status, waitingOn);
  const t = useTranslations('sidebar.sessionList.brief');

  return (
    <>
      <div className="space-y-1.5 px-3.5 py-2.5">
        <div className="flex items-center gap-3">
          <p className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">{title}</p>
          <RelativeCreatedTime createdAt={createdAt} />
        </div>

        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <SessionStatusMark
            status={status}
            waitingOn={waitingOn}
            overdue={isReviewOverdue(changeRequests)}
          />
          <span>{statusLabel}</span>
        </div>

        {spawned && (
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <ArrowsSplitIcon aria-hidden className="size-4 shrink-0" />
            <span>{t('spawned')}</span>
          </div>
        )}

        {subagentCount > 0 && (
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <RobotIcon aria-hidden className="size-4 shrink-0" />
            <span>{t('subAgentCount', { count: subagentCount })}</span>
          </div>
        )}

        {spawnedCount > 0 && (
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <ArrowsSplitIcon aria-hidden className="size-4 shrink-0" />
            <span>{t('spawnedCount', { count: spawnedCount })}</span>
          </div>
        )}

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

        {labels?.length ? <SessionLabelBadges session={{ labels: [...labels] }} max={6} className="flex-wrap" /> : null}
      </div>

      {changeRequests.length > 0 ? (
        <ul className="border-border max-h-64 overflow-y-auto overscroll-contain border-t p-1">
          {changeRequests.map((changeRequest) => (
            <li key={changeRequest.cr_id}>
              <ChangeRequestRow
                changeRequest={changeRequest}
                projectId={projectId}
                onDismiss={onDismiss}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

const CARD_EDGE_PX = 8;

/**
 * The one card for the whole session list. Rows do not own a card: the active
 * row renders its brief into this host's slot (`SessionBriefCard`), and the
 * host lines up with that row. Moving to the next row therefore moves the same
 * card, with a 150ms glide, instead of unmounting one card and mounting another
 * at a new place. Radix HoverCard cannot do this: it exports no `Anchor`, so a
 * single instance cannot follow the pointer between triggers.
 *
 * The first open fades in over 100ms and does not move: the card opens to the
 * right, into the path the pointer is already taking. The glide is only for a
 * move between rows, never for keyboard focus or reduced motion.
 *
 * The left padding is the gap between row and card. It is part of the card's
 * box, so the pointer never leaves on its way in and the card needs no close
 * grace for the crossing beyond the store's own.
 *
 * Mount it once, client-side only, where hover cards can show at all.
 */
export function SessionBriefCardHost() {
  const activeSessionId = useSessionHoverStore((state) => state.activeSessionId);
  const anchor = useSessionHoverStore((state) => state.anchor);
  const via = useSessionHoverStore((state) => state.via);
  const setSlot = useSessionHoverStore((state) => state.setSlot);
  const openSession = useSessionHoverStore((state) => state.openSession);
  const closeSession = useSessionHoverStore((state) => state.closeSession);
  const dismiss = useSessionHoverStore((state) => state.dismiss);
  const container = usePortalContainer();
  const depth = useDialogDepth();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const shown = useRef(false);
  const visible = !!activeSessionId && !!anchor;

  // Before paint: line up with the row, kept inside the viewport.
  useLayoutEffect(() => {
    const el = wrapperRef.current;
    if (!el || !visible || !anchor) {
      shown.current = false;
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const top = Math.max(CARD_EDGE_PX, Math.min(rect.top, window.innerHeight - CARD_EDGE_PX - el.offsetHeight));
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // A move between rows glides; the first open fades in, as the reminders card does.
    el.style.transition =
      shown.current && via === 'pointer' && !reduce
        ? 'transform var(--duration-normal) var(--ease-in-out)'
        : 'opacity var(--duration-fast) var(--ease-out)';
    el.style.transform = `translate(${rect.right}px, ${top}px)`;
    shown.current = true;
  }, [visible, activeSessionId, anchor, via]);

  // WCAG 1.4.13: dismissible without moving the pointer. A scroll moves the
  // row away from the card, so it closes too, unless it scrolls the card itself.
  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && dismiss();
    const onScroll = (event: Event) => {
      if (!wrapperRef.current?.contains(event.target as Node)) dismiss();
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [visible, dismiss]);

  return createPortal(
    <div
      ref={wrapperRef}
      data-slot="session-brief-card"
      className={cn('fixed top-0 left-0 pl-3.5 starting:opacity-0', !visible && 'hidden')}
      style={{ zIndex: floatingZ(depth) }}
      onPointerEnter={() => activeSessionId && openSession(activeSessionId)}
      onPointerLeave={() => activeSessionId && closeSession(activeSessionId)}
    >
      <div ref={setSlot} className={cn(FLOATING_PANEL_SURFACE, 'w-72 overflow-hidden rounded-md shadow-xs')} />
    </div>,
    container ?? document.body,
  );
}

/**
 * A row's trigger plus its brief, rendered into the shared card while the row
 * is active. Timing and exclusivity belong to `useSessionHoverStore`: only one
 * card may show at a time, and the second row the pointer visits must not pay
 * the opening delay again.
 */
function SessionBriefCard({
  id,
  children,
  content,
}: {
  id: string;
  children: ReactElement;
  content: ReactNode;
}) {
  const open = useSessionHoverStore((state) => state.activeSessionId === id);
  const slot = useSessionHoverStore((state) => state.slot);
  const openSession = useSessionHoverStore((state) => state.openSession);
  const closeSession = useSessionHoverStore((state) => state.closeSession);

  // A row can be filtered out, or the sidebar unmounted, while its card shows.
  // Without this the store keeps naming a row that no longer exists and the
  // group is still warm the next time the list mounts.
  useEffect(
    () => () => {
      const store = useSessionHoverStore.getState();
      if (store.activeSessionId === id) store.dismiss();
    },
    [id],
  );

  return (
    <>
      {/* data-state as the Radix trigger set it: the row hides its markers while the card is open. */}
      <Slot.Root
        data-state={open ? 'open' : 'closed'}
        onPointerEnter={(event) => {
          if (event.pointerType !== 'touch') openSession(id, event.currentTarget, 'pointer');
        }}
        onPointerLeave={() => closeSession(id)}
        onFocus={(event) => openSession(id, event.currentTarget, 'focus')}
        onBlur={() => closeSession(id)}
      >
        {children}
      </Slot.Root>
      {open && slot ? createPortal(content, slot) : null}
    </>
  );
}

export function SessionBriefHoverCard({
  sessionId,
  children,
  ...brief
}: SessionBrief & SessionBriefInteractionProps & { sessionId: string; children: ReactElement }) {
  const dismiss = useSessionHoverStore((state) => state.dismiss);
  return (
    <SessionBriefCard id={sessionId} content={<SessionBriefContent {...brief} onDismiss={dismiss} />}>
      {children}
    </SessionBriefCard>
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
  waitingOn,
}: Omit<SessionBrief, 'title'> & { id: string }) {
  const t = useTranslations('sidebar.sessionList.brief');
  const statusLabel = useStatusLabel(status, waitingOn);

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

/**
 * The hover card of a sub-agent row: what it is and when it ran. Same store,
 * same shell as `SessionBriefHoverCard`, so one card is open at a time across
 * sessions, sub-agents and spawned children, and moving between them is free.
 */
export function SubagentHoverCard({
  id,
  title,
  createdAt,
  updatedAt,
  children,
}: {
  id: string;
  title: string;
  createdAt: number | null;
  updatedAt: number | null;
  children: ReactElement;
}) {
  const t = useTranslations('sidebar.sessionList.brief');
  const created = createdAt ?? updatedAt;
  const createdIso = created ? new Date(created).toISOString() : null;

  return (
    <SessionBriefCard
      id={id}
      content={
        <div className="space-y-1.5 px-3.5 py-2.5">
          <div className="flex items-center gap-3">
            <p className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">{title}</p>
            {createdIso && <RelativeCreatedTime createdAt={createdIso} />}
          </div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <RobotIcon aria-hidden className="size-4 shrink-0" />
            <span>{t('subAgent')}</span>
          </div>
          {createdIso && (
            <div className="text-muted-foreground text-xs">
              {t('created')}: <SessionCreatedTime createdAt={createdIso} />
            </div>
          )}
        </div>
      }
    >
      {children}
    </SessionBriefCard>
  );
}
