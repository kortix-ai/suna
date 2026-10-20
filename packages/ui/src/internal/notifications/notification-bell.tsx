'use client';

/**
 * The bell (KRTX-1742): the person's notification inbox, across projects.
 *
 * It sits in the project sidebar header and in `AccountTopBar`, only while the
 * `notification_center` flag is on (`useNotificationCenter`). The badge is
 * the server's unread count, clamped at 99+. A row opens its session (or the
 * Triggers page for an alert) and marks itself read. When this browser shows
 * no notifications yet, the panel's footer offers to turn them on.
 *
 * `NotificationPanel` is the props-only half: the popover content renders
 * through a portal, so tests render the panel itself.
 */

import { HoverPrefetchLink } from '../components/hover-prefetch-link';
import { Button } from '../../primitives/button';
import { CountBadge } from '../../primitives/count-badge';
import Hint from '../../primitives/hint';
import { Popover, PopoverContent, PopoverTrigger } from '../../primitives/popover';
import { Skeleton } from '../../primitives/skeleton';
import { Tabs, TabsList, TabsTrigger } from '../../primitives/tabs';
import { ButtonGroup } from '../../primitives/button-group';
import { EmptyState } from '../../primitives/empty-state';
import { SolidCheckIcon } from '../icons/solid-check-icon';
import { ErrorState } from '../../primitives/error-state';
import { useUiViewerId } from '../../providers/ui-provider';
import { useLocale, useTranslations } from '../../i18n';
import { relativeTime } from '../lib/relative-time';
import { cn } from '../lib/utils';
import { isNotificationSupported } from '../lib/web-notifications';
import { useWebNotificationStore } from '../stores/web-notification-store';
import type { InboxNotification, InboxNotificationKind } from '@kortix/sdk';
import { useNotificationInbox } from '@kortix/sdk/react';
import {
  BellIcon,
  QuestionIcon,
  ShareIcon,
  ShieldWarningIcon,
  WarningIcon,
  XCircleIcon,
  XIcon,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';
import {
  badgeCount,
  tabRows,
  tabUnreadCount,
  withoutNotificationParam,
  type NotificationTab,
} from './notification-rows';
import { useNotificationCenter } from '../hooks/use-notification-center';
import { webPushSupported } from './web-push';

type KindIcon = (props: { className?: string; 'aria-hidden'?: boolean }) => ReactNode;

/** Every kind glyph is solid: Phosphor at `weight="fill"`, the done check is `SolidCheckIcon`. */
const solid = (Icon: PhosphorIcon): KindIcon =>
  function SolidKindIcon(props) {
    return <Icon weight="fill" {...props} />;
  };

/** The glyph names the kind by shape; the hue reports the state (color.md, D5). */
const KIND_MARK: Record<InboxNotificationKind, { icon: KindIcon; className: string }> = {
  turn_done: { icon: SolidCheckIcon, className: 'text-kortix-green' },
  turn_error: { icon: solid(XCircleIcon), className: 'text-kortix-red' },
  question: { icon: solid(QuestionIcon), className: 'text-kortix-yellow' },
  permission: { icon: solid(ShieldWarningIcon), className: 'text-kortix-yellow' },
  shared: { icon: solid(ShareIcon), className: 'text-muted-foreground' },
  automation_failed: { icon: solid(WarningIcon), className: 'text-kortix-red' },
  automation_recovered: { icon: SolidCheckIcon, className: 'text-kortix-green' },
  capture_device_down: { icon: solid(WarningIcon), className: 'text-kortix-red' },
  capture_device_recovered: { icon: SolidCheckIcon, className: 'text-kortix-green' },
};

export interface NotificationPanelProps {
  rows: readonly InboxNotification[];
  state: 'loading' | 'error' | 'ready';
  unreadCount: number;
  /** The footer offer to turn browser notifications on; null hides it. */
  prompt: string | null;
  onOpenRow: (row: InboxNotification) => void;
  onMarkAllRead: () => void;
  onRetry: () => void;
  onTurnOn: () => void;
  onDismissPrompt: () => void;
}

/** Props only: the header, the All / Needs you / Done tabs, the rows, and the footer offer. */
export function NotificationPanel({
  rows,
  state,
  unreadCount,
  prompt,
  onOpenRow,
  onMarkAllRead,
  onRetry,
  onTurnOn,
  onDismissPrompt,
}: NotificationPanelProps) {
  const t = useTranslations('notifications');
  const locale = useLocale();
  const [tab, setTab] = useState<NotificationTab>('all');
  const visible = tabRows(rows, tab);
  const needsCount = tabUnreadCount(rows, 'needs');
  const doneCount = tabUnreadCount(rows, 'done');
  return (
    <>
      <div className="flex items-center justify-between gap-2 px-4 pt-2">
        <h3 className="text-foreground text-sm font-medium">{t('bell.label')}</h3>
        {unreadCount > 0 ? (
          <Button variant="ghost" size="xs" className="text-muted-foreground -mr-2.5" onClick={onMarkAllRead}>
            {t('bell.markAllRead')}
          </Button>
        ) : null}
      </div>
      <Tabs value={tab} onValueChange={(value) => setTab(value as NotificationTab)}>
        <TabsList type="underline" size="sm" className="w-full justify-start gap-4 px-4">
          <TabsTrigger value="all" className="w-fit flex-none">
            {t('bell.tabAll')}
          </TabsTrigger>
          <TabsTrigger value="needs" className="w-fit flex-none gap-1.5">
            {t('bell.tabNeedsYou')}
            {needsCount > 0 ? <CountBadge count={needsCount} tone="waiting" /> : null}
          </TabsTrigger>
          <TabsTrigger value="done" className="w-fit flex-none gap-1.5">
            {t('bell.tabDone')}
            {doneCount > 0 ? <CountBadge count={doneCount} /> : null}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {state === 'loading' ? (
        <div className="space-y-1 p-2">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-11 py-0" />
          ))}
        </div>
      ) : state === 'error' ? (
        <ErrorState
          size="sm"
          title={t('bell.loadError')}
          action={
            <Button variant="outline" size="sm" onClick={onRetry}>
              {t('bell.retry')}
            </Button>
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState
          size="sm"
          title={tab === 'needs' && rows.length > 0 ? t('bell.emptyNeedsYou') : t('bell.empty')}
        />
      ) : (
        <ul className="max-h-96 space-y-0.5 overflow-y-auto p-1.5">
          {visible.map((row) => {
            const mark = KIND_MARK[row.kind];
            const unread = !row.read;
            return (
              <li key={row.id}>
                <HoverPrefetchLink
                  href={withoutNotificationParam(row.url)}
                  onClick={() => onOpenRow(row)}
                  data-unread={unread ? '' : undefined}
                  className="hover:bg-hover focus-visible:ring-ring flex items-start gap-3 rounded-lg px-3 py-2.5 outline-none focus-visible:ring-2"
                >
                  <mark.icon
                    className={cn('mt-0.5 size-4 shrink-0', mark.className, !unread && 'opacity-60')}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'block truncate text-sm',
                        unread ? 'text-foreground font-medium' : 'text-muted-foreground',
                      )}
                    >
                      {row.title}
                    </span>
                    <span className="text-muted-foreground mt-0.5 flex min-w-0 items-center gap-1 text-xs">
                      {/* The kind stays whole; a long project name truncates. */}
                      <span className="shrink-0">{t(`kind.${row.kind}`)}</span>
                      {row.project_name ? (
                        <>
                          <span aria-hidden className="shrink-0">·</span>
                          <span className="min-w-0 truncate">{row.project_name}</span>
                        </>
                      ) : null}
                      <span aria-hidden className="shrink-0">·</span>
                      <span className="shrink-0 tabular-nums">
                        {relativeTime(row.created_at, locale)}
                      </span>
                    </span>
                  </span>
                  {/* A fixed lane, so titles align whether or not a row is unread. */}
                  <span className="flex h-5 w-2 shrink-0 items-center justify-end">
                    {unread ? (
                      <>
                        <span aria-hidden className="bg-kortix-blue size-1.5 rounded-full" />
                        <span className="sr-only">{t('bell.unread')}</span>
                      </>
                    ) : null}
                  </span>
                </HoverPrefetchLink>
              </li>
            );
          })}
        </ul>
      )}
      {prompt ? (
        <div className="flex items-center gap-2 border-t px-4 py-2">
          <p className="text-muted-foreground min-w-0 flex-1 text-xs text-pretty">{prompt}</p>
          <ButtonGroup>
            <Button variant="secondary" size="xs" onClick={onTurnOn}>
              {t('bell.turnOn')}
            </Button>
            <Hint label={t('bell.dismiss')} side="top">
              <Button
                variant="secondary"
                size="icon-sm"
                aria-label={t('bell.dismiss')}
                onClick={onDismissPrompt}
              >
                <XIcon className="size-3.5 shrink-0" />
              </Button>
            </Hint>
          </ButtonGroup>
        </div>
      ) : null}
    </>
  );
}

/**
 * The bell (Paper B12 in the toast's badge-glow style): the glyph muted, then
 * again in the badge's colour under `BELL_REFLECTION_MASK`, so the
 * colour reaches in from the corner the count sits on, as `EntityTile` in
 * `components/ui/toast.tsx` and `TriggerTile` draw it. Yellow when something
 * waits on the person (the Needs you tab), blue otherwise.
 */
/**
 * The toast's `REFLECTION_MASK` scaled from its 20px icon to the 16px bell
 * (16px → 12px), centred on the glyph's bottom-right corner where the count
 * sits. At full size it would tint the whole bell.
 */
const BELL_REFLECTION_MASK = 'radial-gradient(circle 12px at 100% 100%, #000 35%, transparent 100%)';

export function BellMark({
  count,
  needsYou,
  surface = 'bg-background',
}: {
  count: number;
  needsYou: boolean;
  surface?: 'bg-background' | 'bg-sidebar';
}) {
  const tone = needsYou
    ? { reflection: 'text-kortix-yellow', disc: 'bg-kortix-yellow' }
    : { reflection: 'text-kortix-blue', disc: 'bg-kortix-blue' };
  return (
    <span className="relative size-4 shrink-0">
      <BellIcon className="size-4" />
      {count > 0 ? (
        <>
          <BellIcon
            aria-hidden
            className={cn('absolute inset-0 size-4', tone.reflection)}
            style={{ maskImage: BELL_REFLECTION_MASK, WebkitMaskImage: BELL_REFLECTION_MASK }}
          />
          {/* Off the glyph's corner, so the bell stays whole. The disc's own
              ring paints the surface behind the button, so it reads as cut out. */}
          <span
            aria-hidden
            className={cn('absolute -right-2.5 -bottom-2 flex rounded-full p-px', surface)}
          >
            <span
              data-slot="bell-count"
              className={cn(
                'text-background flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-[9px] leading-none font-semibold tabular-nums', // audit:allow a numeral in a 13px disc on a 16px glyph; no type rung fits
                tone.disc,
              )}
            >
              {badgeCount(count)}
            </span>
          </span>
        </>
      ) : null}
    </span>
  );
}

/**
 * The bell and its popover. Renders nothing, and reads no inbox, while signed
 * out or while the flag is off for `projectId` (without one: for every cached
 * project). `onNavigate` runs when a row opens its subject (the mobile sidebar
 * closes its sheet).
 */
export function NotificationBell({
  projectId,
  onNavigate,
  surface = 'bg-background',
}: {
  projectId?: string;
  onNavigate?: () => void;
  /** The surface the bell sits on: the count disc paints it, so the disc reads as cut out. */
  surface?: 'bg-background' | 'bg-sidebar';
}) {
  const t = useTranslations('notifications');
  const viewerId = useUiViewerId();
  const [open, setOpen] = useState(false);
  const notificationCenter = useNotificationCenter(projectId);
  const inbox = useNotificationInbox({ userId: viewerId, enabled: notificationCenter });
  const notificationsOn = useWebNotificationStore((s) => s.preferences.enabled);
  const permission = useWebNotificationStore((s) => s.permission);
  const promptDismissed = useWebNotificationStore((s) => s.promptDismissed);
  const toggleEnabled = useWebNotificationStore((s) => s.toggleEnabled);
  const dismissPrompt = useWebNotificationStore((s) => s.dismissPrompt);
  if (!viewerId || !notificationCenter) return null;

  const count = inbox.unreadCount;
  const needsYou = tabUnreadCount(inbox.data?.notifications ?? [], 'needs') > 0;
  const label = count > 0 ? t('bell.unreadLabel', { count }) : t('bell.label');
  // Browser notifications are off here, and the browser would still ask.
  const offerTurnOn =
    isNotificationSupported() && !notificationsOn && permission !== 'denied' && !promptDismissed;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint side="bottom" label={t('bell.label')}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={label}
            className="relative shrink-0"
          >
            <BellMark count={count} needsYou={needsYou} surface={surface} />
          </Button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent align="start" sideOffset={8} className="w-96 overflow-hidden p-0">
        <NotificationPanel
          rows={inbox.data?.notifications ?? []}
          state={inbox.data ? 'ready' : inbox.isError ? 'error' : 'loading'}
          unreadCount={count}
          prompt={
            offerTurnOn
              ? webPushSupported()
                ? t('bell.promptPush')
                : t('bell.promptBackground')
              : null
          }
          onOpenRow={(row) => {
            setOpen(false);
            onNavigate?.();
            if (!row.read) inbox.markRead([row.id]).catch(() => {});
          }}
          onMarkAllRead={() => {
            inbox.markAllRead().catch(() => {});
          }}
          onRetry={() => void inbox.refetch()}
          // From the click itself: the browser asks for permission only
          // inside a user gesture.
          onTurnOn={() => void toggleEnabled()}
          onDismissPrompt={dismissPrompt}
        />
      </PopoverContent>
    </Popover>
  );
}
