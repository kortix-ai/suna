'use client';

/**
 * Reminders — every scheduled check-in on the project's sessions the viewer
 * can open. A reminder is a trigger scoped to one session (API:
 * `routes/session-reminders.ts`); this page is the place to see what will
 * fire next and to pause or remove one, since each fire is a model turn.
 */

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Hint from '@/components/ui/hint';
import { InlineMeta } from '@/components/ui/inline-meta';
import { useOptionalSidebar } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { FeatureGateScreen } from '@/features/workspace/feature-gate-screen';
import { SidebarToggle } from '@/features/workspace/project-layout/sidebar-toggle';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { ProjectReminder, SessionReminderState } from '@kortix/sdk';
import { useFeatureFlag, useProjectReminders } from '@kortix/sdk/react';
import {
  AlarmIcon,
  ArrowUpRightIcon,
  PauseIcon,
  PlayIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { formatFireTime, reminderTitle } from './reminder-format';
import { useNow, useRefetchAfterFire } from './use-refetch-after-fire';

const TABS: readonly SessionReminderState[] = ['active', 'paused', 'done'];

/** Status tile per the tinted-icon pattern: yellow = pending, green = done, red = stopped by an error. */
function tone(reminder: ProjectReminder) {
  if (reminder.last_error) return { tile: 'bg-kortix-red/15', icon: 'text-kortix-red' };
  if (reminder.state === 'active')
    return { tile: 'bg-kortix-yellow/15', icon: 'text-kortix-yellow' };
  if (reminder.state === 'done') return { tile: 'bg-kortix-green/15', icon: 'text-kortix-green' };
  return { tile: 'bg-muted', icon: 'text-muted-foreground' };
}

function RemindersHeader() {
  const t = useTranslations('reminders');
  const sidebar = useOptionalSidebar();
  return (
    <div
      className="kx-titlebar-row kx-titlebar-band-height relative flex shrink-0 items-center gap-1 border-b px-2"
      data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
    >
      <SidebarToggle />
      <div className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2">
        <h1 className="text-foreground shrink-0 text-sm font-medium">{t('title')}</h1>
      </div>
      <Link
        href="/docs/connect/reminders"
        target="_blank"
        rel="noopener noreferrer"
        prefetch={false}
        className="text-muted-foreground hover:text-foreground flex w-fit flex-none items-center gap-1 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors"
      >
        {t('docs')}
        <ArrowUpRightIcon className="size-3 shrink-0" aria-hidden />
      </Link>
    </div>
  );
}

export function ProjectRemindersView({ projectId }: { projectId: string }) {
  const t = useTranslations('reminders');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const sessionFilter = useSearchParams().get('session');
  const gate = useFeatureFlag(projectId, 'reminders');
  const reminders = useProjectReminders(gate.enabled ? projectId : null);
  useRefetchAfterFire(reminders.data?.reminders, reminders.refetch);
  const now = useNow();
  const [tab, setTab] = useState<SessionReminderState>('active');
  const [removing, setRemoving] = useState<ProjectReminder | null>(null);

  const all = (reminders.data?.reminders ?? []).filter(
    (reminder) => !sessionFilter || reminder.session_id === sessionFilter,
  );
  const rows = all.filter((reminder) => reminder.state === tab);
  const filteredSessionName = sessionFilter && (all[0]?.session_name ?? t('untitledSession'));

  const schedule = (reminder: ProjectReminder) =>
    reminder.cron
      ? t('cron', { expression: `${reminder.cron} ${reminder.timezone}` })
      : reminder.every
        ? t('every', { period: reminder.every })
        : t('once');

  const timing = (reminder: ProjectReminder) => {
    if (reminder.state === 'active' && reminder.next_fire_at) {
      return t('nextFire', { time: formatFireTime(reminder.next_fire_at, locale, now) });
    }
    if (reminder.last_fired_at) {
      return t('firedAt', { time: formatFireTime(reminder.last_fired_at, locale, now) });
    }
    return reminder.state === 'paused' ? t('pausedLabel') : null;
  };

  const setEnabled = (reminder: ProjectReminder, enabled: boolean) => {
    reminders.update.mutate(
      { sessionId: reminder.session_id as string, reminderId: reminder.id, enabled },
      {
        onSuccess: () => successToast(enabled ? t('resumed') : t('paused')),
        onError: (error) => errorToast(error instanceof Error ? error.message : t('updateFailed')),
      },
    );
  };

  const confirmRemove = () => {
    if (!removing) return;
    reminders.remove.mutate(
      { sessionId: removing.session_id as string, reminderId: removing.id },
      {
        onSuccess: () => {
          successToast(t('removed'));
          setRemoving(null);
        },
        onError: (error) => errorToast(error instanceof Error ? error.message : t('updateFailed')),
      },
    );
  };

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <RemindersHeader />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl space-y-5 px-4 py-10 pb-20 lg:py-20">
          <p className="text-muted-foreground text-sm">{t('description')}</p>

          <div className="space-y-4">
            {gate.enabled ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Tabs value={tab} onValueChange={(value) => setTab(value as SessionReminderState)}>
                  <TabsListCompact>
                    {TABS.map((value) => (
                      <TabsTriggerCompact key={value} value={value}>
                        {t(
                          value === 'active'
                            ? 'tabActive'
                            : value === 'paused'
                              ? 'tabPaused'
                              : 'tabDone',
                        )}
                        <Badge variant="secondary" size="sm">
                          {all.filter((reminder) => reminder.state === value).length}
                        </Badge>
                      </TabsTriggerCompact>
                    ))}
                  </TabsListCompact>
                </Tabs>
                {sessionFilter ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => router.replace(pathname)}
                    aria-label={t('clearFilter')}
                  >
                    <span className="max-w-60 truncate">
                      {t('sessionFilter', { name: filteredSessionName })}
                    </span>
                    <XIcon className="size-3.5 shrink-0" />
                  </Button>
                ) : null}
              </div>
            ) : null}

            {gate.isLoading ? (
              <Skeleton className="h-14 rounded-md" />
            ) : !gate.enabled ? (
              <FeatureGateScreen featureName={t('title')} description={t('gateDescription')} />
            ) : reminders.isLoading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((key) => (
                  <Skeleton key={key} className="h-14 rounded-md" />
                ))}
              </div>
            ) : reminders.isError ? (
              <ErrorState
                size="sm"
                title={t('loadFailed')}
                action={
                  <Button variant="outline" size="sm" onClick={() => void reminders.refetch()}>
                    {t('retry')}
                  </Button>
                }
              />
            ) : all.length === 0 ? (
              <EmptyState
                icon={AlarmIcon}
                size="sm"
                title={t('emptyTitle')}
                description={t('emptyDescription')}
                action={
                  <Button asChild variant="outline" size="sm" className="gap-1.5">
                    <Link
                      href="/docs/connect/reminders"
                      target="_blank"
                      rel="noopener noreferrer"
                      prefetch={false}
                    >
                      {t('docs')}
                      <ArrowUpRightIcon className="size-3.5 shrink-0" aria-hidden />
                    </Link>
                  </Button>
                }
              />
            ) : rows.length === 0 ? (
              <p className="text-muted-foreground px-3 py-6 text-center text-xs">
                {t('emptyTabDescription')}
              </p>
            ) : (
              <ul className="space-y-2" data-testid="reminder-list">
                {rows.map((reminder) => {
                  const colors = tone(reminder);
                  const when = timing(reminder);
                  return (
                    <li
                      key={reminder.id}
                      data-reminder-id={reminder.id}
                      className="bg-popover flex items-center gap-3 rounded-md border px-4 py-2.5"
                    >
                      <span
                        className={cn(
                          'flex size-9 shrink-0 items-center justify-center rounded-sm',
                          colors.tile,
                        )}
                      >
                        <AlarmIcon weight="fill" className={cn('size-5', colors.icon)} />
                      </span>
                      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <p
                          className="text-foreground truncate text-sm font-medium"
                          title={reminder.prompt}
                        >
                          {reminderTitle(reminder)}
                        </p>
                        <InlineMeta>
                          <span className="shrink-0">{schedule(reminder)}</span>
                          {when ? <span className="shrink-0">{when}</span> : null}
                          <HoverPrefetchLink
                            href={`/projects/${projectId}/sessions/${reminder.session_id}`}
                            className="hover:text-foreground truncate transition-colors"
                          >
                            {reminder.session_name ?? t('untitledSession')}
                          </HoverPrefetchLink>
                        </InlineMeta>
                        {reminder.last_error ? (
                          <p className="text-kortix-red text-xs">{reminder.last_error}</p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {reminder.state !== 'done' ? (
                          <Hint label={reminder.state === 'active' ? t('pause') : t('resume')}>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={reminder.state === 'active' ? t('pause') : t('resume')}
                              disabled={reminders.update.isPending}
                              onClick={() => setEnabled(reminder, reminder.state !== 'active')}
                            >
                              {reminder.state === 'active' ? (
                                <PauseIcon className="size-4 shrink-0" />
                              ) : (
                                <PlayIcon className="size-4 shrink-0" />
                              )}
                            </Button>
                          </Hint>
                        ) : null}
                        <Hint label={t('remove')}>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('remove')}
                            onClick={() => setRemoving(reminder)}
                          >
                            <TrashIcon className="size-4 shrink-0" />
                          </Button>
                        </Hint>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t('removeTitle')}
        description={t('removeDescription')}
        confirmLabel={t('remove')}
        confirmVariant="destructive"
        isPending={reminders.remove.isPending}
        onConfirm={confirmRemove}
      />
    </div>
  );
}
