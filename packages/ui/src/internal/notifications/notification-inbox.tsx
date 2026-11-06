'use client';

/**
 * The Inbox (KRTX-1742): the person's notifications from every project, as a
 * page. The project sidebar's Inbox row opens it inside the project shell
 * (`uiRoutes().inbox`); `AccountTopBar` opens it on the account-level pages.
 *
 * A row opens its subject (its session, its Artifact, or the Loops or
 * Triggers page for an alert) and marks itself read. The tabs split what
 * waits on the person (Needs you) from the rest (Done). When this browser
 * shows no notifications yet, the page offers to turn them on. The footer
 * links to the per-kind Push and Email choices in Settings.
 *
 * `NotificationInboxView` is the props-only half: tests render it alone.
 */

import { ProjectPageHeader } from '../layout/project-page-header';
import { HoverPrefetchLink } from '../components/hover-prefetch-link';
import { Button } from '../../primitives/button';
import { ButtonGroup } from '../../primitives/button-group';
import { CountBadge } from '../../primitives/count-badge';
import { EmptyArt } from '../../primitives/empty-art';
import { EmptyState } from '../../primitives/empty-state';
import { ErrorState } from '../../primitives/error-state';
import Hint from '../../primitives/hint';
import { InfoBanner } from '../../primitives/info-banner';
import { Skeleton } from '../../primitives/skeleton';
import { Tabs, TabsList, TabsTrigger } from '../../primitives/tabs';
import { SolidCheckIcon } from '../icons/solid-check-icon';
import { UiLink, useUiViewerId } from '../../providers/ui-provider';
import { useLocale, useTranslations } from '../../i18n';
import { relativeTime } from '../lib/relative-time';
import { cn } from '../lib/utils';
import { isNotificationSupported } from '../lib/web-notifications';
import { useSettingsPanelStore } from '../stores/settings-panel-store';
import { useWebNotificationStore } from '../stores/web-notification-store';
import type { InboxNotification, InboxNotificationKind } from '@kortix/sdk';
import { useNotificationInbox } from '@kortix/sdk/react';
import {
  BellIcon,
  ChecksIcon,
  GearSixIcon,
  QuestionIcon,
  ShareIcon,
  ShieldWarningIcon,
  WarningIcon,
  XCircleIcon,
  XIcon,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';
import { tabRows, tabUnreadCount, withoutNotificationParam, type NotificationTab } from './notification-rows';
import { webPushSupported } from './web-push';

type KindIcon = (props: { className?: string; 'aria-hidden'?: boolean }) => ReactNode;

/** Every kind glyph is solid: Phosphor at `weight="fill"`, the done check is `SolidCheckIcon`. */
const solid = (Icon: PhosphorIcon): KindIcon =>
  function SolidKindIcon(props) {
    return <Icon weight="fill" {...props} />;
  };

/** The glyph names the kind by shape; the hue reports the state (color.md, D5). */
// `message` (Rooms) is retired: the API hides its stored rows.
type LiveKind = Exclude<InboxNotificationKind, 'message'>;

const KIND_MARK: Record<LiveKind, { icon: KindIcon; className: string }> = {
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

/** Where "Notification settings" goes: a page (outside a project) or the Settings overlay (inside one). */
export type InboxSettingsTarget = { href: string } | { onOpen: () => void };

export interface NotificationInboxViewProps {
  rows: readonly InboxNotification[];
  state: 'loading' | 'error' | 'ready';
  unreadCount: number;
  /** The offer to turn browser notifications on; null hides it. */
  prompt: string | null;
  settings: InboxSettingsTarget;
  /**
   * The row above the page outside a project (the account pages' top bar).
   * Then the title is the column's heading. Absent: the project page header.
   */
  header?: ReactNode;
  onOpenRow: (row: InboxNotification) => void;
  onMarkAllRead: () => void;
  onRetry: () => void;
  onTurnOn: () => void;
  onDismissPrompt: () => void;
}

/**
 * Props only: the page frame and header, the description, the All / Needs you
 * / Done tabs with "Mark all as read", the offer, the rows and the settings
 * footer. Inside a project the title is `ProjectPageHeader` (the Review,
 * Goals and Artifacts pages' header: it owns the desktop title-bar band).
 */
export function NotificationInboxView({
  rows,
  state,
  unreadCount,
  prompt,
  settings,
  header,
  onOpenRow,
  onMarkAllRead,
  onRetry,
  onTurnOn,
  onDismissPrompt,
}: NotificationInboxViewProps) {
  const t = useTranslations('notifications');
  const [tab, setTab] = useState<NotificationTab>('all');
  const visible = tabRows(rows, tab);
  const needsCount = tabUnreadCount(rows, 'needs');
  const doneCount = tabUnreadCount(rows, 'done');

  const settingsLabel = (
    <>
      <GearSixIcon className="size-3.5 shrink-0" />
      {t('inbox.settings')}
    </>
  );

  return (
    // `h-svh`: nothing above this box has a definite height (as the Review page).
    <div className="flex h-svh min-h-0 flex-col overflow-hidden">
      {header ?? <ProjectPageHeader title={t('inbox.title')} />}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 pb-20 md:px-8">
          <div className="flex flex-col gap-1.5">
            {header ? <h1 className="text-foreground text-xl font-medium text-balance">{t('inbox.title')}</h1> : null}
            <p className="text-muted-foreground text-sm text-pretty">{t('inbox.description')}</p>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Tabs value={tab} onValueChange={(value) => setTab(value as NotificationTab)}>
              <TabsList>
                <TabsTrigger value="all" className="gap-1.5">
                  {t('inbox.tabAll')}
                  {unreadCount > 0 ? <CountBadge count={unreadCount} /> : null}
                </TabsTrigger>
                <TabsTrigger value="needs" className="gap-1.5">
                  {t('inbox.tabNeedsYou')}
                  {needsCount > 0 ? <CountBadge count={needsCount} tone="waiting" /> : null}
                </TabsTrigger>
                <TabsTrigger value="done" className="gap-1.5">
                  {t('inbox.tabDone')}
                  {doneCount > 0 ? <CountBadge count={doneCount} /> : null}
                </TabsTrigger>
              </TabsList>
            </Tabs>
            {unreadCount > 0 ? (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={onMarkAllRead}>
                <ChecksIcon className="size-3.5 shrink-0" />
                {t('inbox.markAllRead')}
              </Button>
            ) : null}
          </div>
          {prompt ? (
            <InfoBanner
              icon={BellIcon}
              title={prompt}
              action={
                <ButtonGroup>
                  <Button variant="secondary" size="xs" onClick={onTurnOn}>
                    {t('inbox.turnOn')}
                  </Button>
                  <Hint label={t('inbox.dismiss')} side="top">
                    <Button variant="secondary" size="icon-sm" aria-label={t('inbox.dismiss')} onClick={onDismissPrompt}>
                      <XIcon className="size-3.5 shrink-0" />
                    </Button>
                  </Hint>
                </ButtonGroup>
              }
            />
          ) : null}
          {state === 'loading' ? (
            <div className="space-y-0.5">
              {[0, 1, 2].map((index) => (
                <Skeleton key={index} className="h-14 w-full rounded-lg" />
              ))}
            </div>
          ) : state === 'error' ? (
            <ErrorState
              size="sm"
              title={t('inbox.loadError')}
              action={
                <Button variant="outline" size="sm" onClick={onRetry}>
                  {t('inbox.retry')}
                </Button>
              }
            />
          ) : visible.length === 0 ? (
            <EmptyState
              size="sm"
              media={<EmptyArt icon={BellIcon} />}
              title={tab === 'needs' && rows.length > 0 ? t('inbox.emptyNeedsYou') : t('inbox.empty')}
              description={
                tab === 'needs' && rows.length > 0 ? t('inbox.emptyNeedsYouDescription') : t('inbox.emptyDescription')
              }
            />
          ) : (
            <ul className="space-y-0.5">
              {visible.map((row) => (
                <li key={row.id}>
                  <InboxRow row={row} onOpen={() => onOpenRow(row)} />
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-col gap-2 pt-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-muted-foreground text-sm text-pretty">{t('inbox.emailOptIn')}</p>
            {'href' in settings ? (
              <Button asChild variant="outline" size="sm" className="gap-1.5 self-start sm:self-auto">
                <UiLink href={settings.href}>{settingsLabel}</UiLink>
              </Button>
            ) : (
              <Button variant="outline" size="sm" className="gap-1.5 self-start sm:self-auto" onClick={settings.onOpen}>
                {settingsLabel}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One notification: the kind glyph, its subject, its detail, then kind, project and age. */
function InboxRow({ row, onOpen }: { row: InboxNotification; onOpen: () => void }) {
  const t = useTranslations('notifications');
  const locale = useLocale();
  const mark = KIND_MARK[row.kind as LiveKind] ?? KIND_MARK.shared;
  const unread = !row.read;
  return (
    <HoverPrefetchLink
      href={withoutNotificationParam(row.url)}
      onClick={onOpen}
      data-unread={unread ? '' : undefined}
      className="hover:bg-hover focus-visible:ring-ring flex items-start gap-3 rounded-lg px-3 py-2.5 outline-none focus-visible:ring-2"
    >
      <mark.icon className={cn('mt-0.5 size-4 shrink-0', mark.className, !unread && 'opacity-60')} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-sm', unread ? 'text-foreground font-medium' : 'text-muted-foreground')}>
          {row.title}
        </span>
        {row.body ? <span className="text-muted-foreground mt-0.5 block truncate text-sm">{row.body}</span> : null}
        <span className="text-muted-foreground mt-0.5 flex min-w-0 items-center gap-1 text-xs">
          {/* The kind stays whole; a long project name truncates. */}
          <span className="shrink-0">{t(`kind.${row.kind}`)}</span>
          {row.project_name ? (
            <>
              <span aria-hidden className="shrink-0">
                ·
              </span>
              <span className="min-w-0 truncate">{row.project_name}</span>
            </>
          ) : null}
          <span aria-hidden className="shrink-0">
            ·
          </span>
          <span className="shrink-0 tabular-nums">{relativeTime(row.created_at, locale)}</span>
        </span>
      </span>
      {/* A fixed lane, so titles align whether or not a row is unread. */}
      <span className="flex h-5 w-2 shrink-0 items-center justify-end">
        {unread ? (
          <>
            <span aria-hidden className="bg-kortix-blue size-1.5 rounded-full" />
            <span className="sr-only">{t('inbox.unread')}</span>
          </>
        ) : null}
      </span>
    </HoverPrefetchLink>
  );
}

/**
 * The Inbox page. Reads the inbox `NotificationHost` polls (one cache entry,
 * so the sidebar count and the page agree), and renders nothing while signed
 * out. `settingsHref`: the Settings page outside a project (`/settings/…`);
 * without it, "Notification settings" opens the project's Settings overlay.
 * `header` sits above the page (the account pages' top bar).
 */
export function NotificationInbox({ settingsHref, header }: { settingsHref?: string; header?: ReactNode }) {
  const t = useTranslations('notifications');
  const viewerId = useUiViewerId();
  const inbox = useNotificationInbox({ userId: viewerId });
  const notificationsOn = useWebNotificationStore((s) => s.preferences.enabled);
  const permission = useWebNotificationStore((s) => s.permission);
  const promptDismissed = useWebNotificationStore((s) => s.promptDismissed);
  const requestPermission = useWebNotificationStore((s) => s.requestPermission);
  const setPreference = useWebNotificationStore((s) => s.setPreference);
  const dismissPrompt = useWebNotificationStore((s) => s.dismissPrompt);
  if (!viewerId) return null;

  // A fresh profile enables notifications before OS permission is granted.
  const offerTurnOn =
    isNotificationSupported() &&
    (!notificationsOn || permission === 'default') &&
    permission !== 'denied' &&
    !promptDismissed;

  return (
    <NotificationInboxView
      rows={inbox.data?.notifications ?? []}
      state={inbox.data ? 'ready' : inbox.isError ? 'error' : 'loading'}
      unreadCount={inbox.unreadCount}
      prompt={offerTurnOn ? (webPushSupported() ? t('inbox.promptPush') : t('inbox.promptBackground')) : null}
      settings={
        settingsHref
          ? { href: settingsHref }
          : { onOpen: () => useSettingsPanelStore.getState().openSettings('sessions') }
      }
      header={header}
      onOpenRow={(row) => {
        if (!row.read) inbox.markRead([row.id]).catch(() => {});
      }}
      onMarkAllRead={() => {
        inbox.markAllRead().catch(() => {});
      }}
      onRetry={() => void inbox.refetch()}
      // From the click itself: the browser asks for permission only
      // inside a user gesture.
      onTurnOn={async () => {
        if ((await requestPermission()) === 'granted') setPreference('enabled', true);
      }}
      onDismissPrompt={dismissPrompt}
    />
  );
}
