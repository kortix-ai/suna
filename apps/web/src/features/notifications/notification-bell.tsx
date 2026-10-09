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

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useAuth } from '@/features/providers/auth-provider';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';
import { isNotificationSupported } from '@/lib/web-notifications';
import { useWebNotificationStore } from '@/stores/web-notification-store';
import type { InboxNotification, InboxNotificationKind } from '@kortix/sdk';
import { useNotificationInbox } from '@kortix/sdk/react';
import {
  BellIcon,
  CheckCircleIcon,
  QuestionIcon,
  ShareIcon,
  ShieldWarningIcon,
  WarningIcon,
  XCircleIcon,
  XIcon,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import { useState } from 'react';
import { badgeCount, withoutNotificationParam } from './notification-rows';
import { useNotificationCenter } from './use-notification-center';
import { webPushSupported } from './web-push';

/** The glyph names the kind by shape; the hue reports the state (color.md, D5). */
const KIND_MARK: Record<InboxNotificationKind, { icon: PhosphorIcon; className: string }> = {
  turn_done: { icon: CheckCircleIcon, className: 'text-kortix-green' },
  turn_error: { icon: XCircleIcon, className: 'text-kortix-red' },
  question: { icon: QuestionIcon, className: 'text-kortix-yellow' },
  permission: { icon: ShieldWarningIcon, className: 'text-kortix-yellow' },
  shared: { icon: ShareIcon, className: 'text-muted-foreground' },
  automation_failed: { icon: WarningIcon, className: 'text-kortix-red' },
  automation_recovered: { icon: CheckCircleIcon, className: 'text-kortix-green' },
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

/** Props only: the header, the rows, and the footer offer. */
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
  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
        <h3 className="text-foreground text-sm font-medium">{t('bell.label')}</h3>
        {unreadCount > 0 ? (
          <Button variant="ghost" size="sm" onClick={onMarkAllRead}>
            {t('bell.markAllRead')}
          </Button>
        ) : null}
      </div>
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
      ) : rows.length === 0 ? (
        <EmptyState size="sm" title={t('bell.empty')} />
      ) : (
        <ul className="max-h-96 space-y-0.5 overflow-y-auto p-1">
          {rows.map((row) => {
            const mark = KIND_MARK[row.kind];
            const unread = !row.read;
            return (
              <li key={row.id}>
                <HoverPrefetchLink
                  href={withoutNotificationParam(row.url)}
                  onClick={() => onOpenRow(row)}
                  data-unread={unread ? '' : undefined}
                  className="hover:bg-hover focus-visible:ring-ring flex items-start gap-3 rounded-md px-3 py-2 outline-none focus-visible:ring-2"
                >
                  <mark.icon className={cn('mt-0.5 size-4 shrink-0', mark.className)} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          'truncate text-sm font-medium',
                          unread ? 'text-foreground' : 'text-muted-foreground',
                        )}
                      >
                        {row.title}
                      </span>
                      {unread ? (
                        <>
                          <span
                            aria-hidden
                            className="bg-kortix-blue size-1.5 shrink-0 rounded-full"
                          />
                          <span className="sr-only">{t('bell.unread')}</span>
                        </>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground mt-0.5 flex min-w-0 items-center gap-1.5 text-xs">
                      {/* The kind stays whole; a long project name truncates. */}
                      <span className="shrink-0">{t(`kind.${row.kind}`)}</span>
                      {row.project_name ? (
                        <>
                          <span aria-hidden className="shrink-0">•</span>
                          <span className="min-w-0 truncate">{row.project_name}</span>
                        </>
                      ) : null}
                      <span aria-hidden className="shrink-0">•</span>
                      <span className="shrink-0 tabular-nums">
                        {relativeTime(row.created_at, locale)}
                      </span>
                    </span>
                  </span>
                </HoverPrefetchLink>
              </li>
            );
          })}
        </ul>
      )}
      {prompt ? (
        <div className="flex items-center gap-2 border-t px-4 py-2.5">
          <p className="text-muted-foreground min-w-0 flex-1 text-xs text-pretty">{prompt}</p>
          <Button variant="outline" size="sm" onClick={onTurnOn}>
            {t('bell.turnOn')}
          </Button>
          <Hint label={t('bell.dismiss')} side="top">
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('bell.dismiss')}
              onClick={onDismissPrompt}
            >
              <XIcon className="size-4 shrink-0" />
            </Button>
          </Hint>
        </div>
      ) : null}
    </>
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
}: {
  projectId?: string;
  onNavigate?: () => void;
}) {
  const t = useTranslations('notifications');
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const notificationCenter = useNotificationCenter(projectId);
  const inbox = useNotificationInbox({ userId: user?.id, enabled: notificationCenter });
  const notificationsOn = useWebNotificationStore((s) => s.preferences.enabled);
  const permission = useWebNotificationStore((s) => s.permission);
  const promptDismissed = useWebNotificationStore((s) => s.promptDismissed);
  const toggleEnabled = useWebNotificationStore((s) => s.toggleEnabled);
  const dismissPrompt = useWebNotificationStore((s) => s.dismissPrompt);
  if (!user || !notificationCenter) return null;

  const count = inbox.unreadCount;
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
            <BellIcon className="size-4" />
            {count > 0 ? (
              <Badge variant="secondary" size="tabular" className="absolute -top-1 -right-1">
                {badgeCount(count)}
              </Badge>
            ) : null}
          </Button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent align="end" sideOffset={8} className="w-96 overflow-hidden p-0">
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
