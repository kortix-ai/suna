'use client';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { getSessionDisplayTitle } from '@/features/workspace/project-sidebar/project-session-list-helpers';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { LONG_AGO, relativeTime } from '@/lib/relative-time';
import type { ProjectSession } from '@kortix/sdk';

/**
 * One row of Recently deleted (KRTX-2853): a session the viewer deleted (or,
 * as a manager, one they can open), still inside its restore window. Not a
 * link: a deleted session reads 404 until it is restored.
 */
export function DeletedSessionRow({
  session,
  restoring,
  onRestore,
}: {
  session: ProjectSession;
  restoring: boolean;
  onRestore: (session: ProjectSession) => void;
}) {
  const t = useTranslations('sidebar.recentlyDeleted');
  const locale = useLocale();
  const title = getSessionDisplayTitle(session);
  const deletedAt = session.deleted_at ? new Date(session.deleted_at) : null;
  const restoreUntil = session.restore_until ? new Date(session.restore_until) : null;
  const exact = (date: Date) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);

  return (
    <div
      className="bg-popover flex items-center gap-3 rounded-md border px-3 py-2"
      data-deleted-session-id={session.session_id}
    >
      <div className="min-w-0 flex-1">
        <p className="text-foreground truncate text-sm">{title}</p>
        <p className="text-muted-foreground truncate text-xs">
          {deletedAt ? (
            <time dateTime={session.deleted_at!} title={exact(deletedAt)}>
              {t('deletedAgo', {
                when: relativeTime(session.deleted_at, locale, undefined, LONG_AGO),
              })}
            </time>
          ) : null}
          {deletedAt && restoreUntil ? ' · ' : null}
          {restoreUntil ? (
            <time dateTime={session.restore_until!} title={exact(restoreUntil)}>
              {t('restorableUntil', {
                date: new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(
                  restoreUntil,
                ),
              })}
            </time>
          ) : null}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={restoring}
        onClick={() => onRestore(session)}
        aria-label={t('restoreNamed', { title })}
      >
        {restoring ? <Loading className="size-3.5 shrink-0" /> : null}
        {t('restore')}
      </Button>
    </div>
  );
}
