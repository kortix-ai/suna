'use client';

/**
 * Header chip for this session's reminders (scheduled check-ins that re-prompt
 * the session). Renders nothing until the session has a reminder that can
 * still fire; then an alarm with the active count, and a popover to pause,
 * resume, or remove one, or to open the project Reminders page on this
 * session. The session reminders read needs `project.session.start`, so a
 * read-only viewer's 403 simply leaves the chip hidden.
 */

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Hint from '@/components/ui/hint';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  formatFireTime,
  reminderTitle,
} from '@/features/workspace/project-reminders/reminder-format';
import {
  useNow,
  useRefetchAfterFire,
} from '@/features/workspace/project-reminders/use-refetch-after-fire';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import type { SessionReminder } from '@kortix/sdk';
import { qk, useFeatureFlag, useSessionReminders, useSessionWorking } from '@kortix/sdk/react';
import { AlarmIcon, PauseIcon, PlayIcon, TrashIcon } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

export function SessionRemindersIndicator({ runtimeSessionId }: { runtimeSessionId: string }) {
  const t = useTranslations('reminders');
  const locale = useLocale();
  // Route params: `id` = project, `sessionId` = the Kortix session reminders key on.
  const { id: projectId, sessionId } = useParams<{ id: string; sessionId: string }>();
  const gate = useFeatureFlag(projectId, 'reminders');
  const reminders = useSessionReminders(gate.enabled ? projectId : null, sessionId);
  useRefetchAfterFire(reminders.data?.reminders, reminders.refetch);
  const now = useNow();
  // An agent sets reminders mid-turn with `kortix remind`; nothing announces
  // that to this query. The turn ending is the moment to look again.
  const working = useSessionWorking(projectId ?? '', sessionId ?? '', {
    enabled: gate.enabled && !!projectId && !!sessionId,
    runtimeSessionId,
  });
  const isWorking = working.state === 'working';
  const wasWorking = useRef(isWorking);
  const queryClient = useQueryClient();
  useEffect(() => {
    // The whole project prefix: the sidebar row and its count move with the chip.
    if (wasWorking.current && !isWorking && projectId) {
      void queryClient.invalidateQueries({ queryKey: qk.project.reminders(projectId) });
    }
    wasWorking.current = isWorking;
  }, [isWorking, projectId, queryClient]);
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState<SessionReminder | null>(null);

  const live = (reminders.data?.reminders ?? []).filter((reminder) => reminder.state !== 'done');
  if (live.length === 0) return null;
  const activeCount = live.filter((reminder) => reminder.state === 'active').length;

  const setEnabled = (reminder: SessionReminder, enabled: boolean) =>
    reminders.update.mutate(
      { reminderId: reminder.id, enabled },
      {
        onSuccess: () => successToast(enabled ? t('resumed') : t('paused')),
        onError: (error) => errorToast(error instanceof Error ? error.message : t('updateFailed')),
      },
    );

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('chipLabel', { count: activeCount })}
            className="relative"
            data-testid="session-reminders-chip"
          >
            <AlarmIcon className="size-4" />
            {activeCount > 0 ? (
              <Badge variant="secondary" size="tabular" className="absolute -top-1 -right-1">
                {activeCount}
              </Badge>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={8} className="w-80 overflow-hidden p-0">
          <div className="border-b px-4 pt-4 pb-3">
            <h3 className="text-foreground text-sm font-medium">{t('chipTitle')}</h3>
          </div>
          <ul className="max-h-64 divide-y overflow-auto">
            {live.map((reminder) => (
              <li key={reminder.id} className="flex items-center gap-2 px-4 py-2.5">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="text-foreground truncate text-sm" title={reminder.prompt}>
                    {reminderTitle(reminder)}
                  </p>
                  <p className="text-muted-foreground truncate text-xs">
                    {reminder.state === 'active' && reminder.next_fire_at
                      ? t('nextFire', { time: formatFireTime(reminder.next_fire_at, locale, now) })
                      : t('pausedLabel')}
                  </p>
                </div>
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
              </li>
            ))}
          </ul>
          <div className="border-t px-4 py-2">
            <Button asChild variant="ghost" size="sm" className="w-full justify-center">
              <HoverPrefetchLink
                href={`/projects/${projectId}/reminders?session=${sessionId}`}
                onClick={() => setOpen(false)}
              >
                {t('manage')}
              </HoverPrefetchLink>
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(next) => !next && setRemoving(null)}
        title={t('removeTitle')}
        description={t('removeDescription')}
        confirmLabel={t('remove')}
        confirmVariant="destructive"
        isPending={reminders.remove.isPending}
        onConfirm={() =>
          removing &&
          reminders.remove.mutate(removing.id, {
            onSuccess: () => {
              successToast(t('removed'));
              setRemoving(null);
            },
            onError: (error) =>
              errorToast(error instanceof Error ? error.message : t('updateFailed')),
          })
        }
      />
    </>
  );
}
