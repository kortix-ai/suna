'use client';

import { Button } from '@/components/ui/button';
import { errorToast } from '@/components/ui/toast';
import { useDismissDriveConflict, useDriveConflicts } from '@/hooks/drives/use-drives';
import { useFormatter, useNow, useTranslations } from '@/i18n/use-translations';
import { WarningIcon } from '@phosphor-icons/react';

import { parentDrivePath } from './drive-model';

/**
 * Conflict copies on one drive: two writers changed the same file at once and
 * both versions were kept. Each row opens the folder that holds the copy, or
 * dismisses the notice (the copy stays). Renders nothing without conflicts.
 */
export function DriveConflictsBanner({
  driveId,
  canWrite,
  onOpenFolder,
}: {
  driveId: string;
  canWrite: boolean;
  onOpenFolder: (path: string) => void;
}) {
  const t = useTranslations('drives');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const conflicts = useDriveConflicts(driveId);
  const dismiss = useDismissDriveConflict();
  const open = conflicts.data ?? [];
  if (open.length === 0) return null;

  return (
    <section
      aria-label={t('conflictsTitle', { count: open.length })}
      className="bg-kortix-orange/10 shrink-0 border-b px-4 py-2"
    >
      <div className="flex items-center gap-2">
        <WarningIcon className="text-kortix-orange size-4 shrink-0" weight="fill" />
        <p className="text-sm font-medium">{t('conflictsTitle', { count: open.length })}</p>
      </div>
      <p className="text-muted-foreground mt-0.5 pl-6 text-xs text-pretty">
        {t('conflictsDescription')}
      </p>
      <ul className="mt-1.5 space-y-0.5 pl-6">
        {open.slice(0, 5).map((conflict) => (
          <li key={conflict.conflictId} className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={conflict.path}>
              {conflict.path}
            </span>
            <span className="text-muted-foreground hidden shrink-0 text-xs sm:inline">
              {format.relativeTime(new Date(conflict.detectedAt), now)}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => onOpenFolder(parentDrivePath(conflict.path))}
            >
              {t('conflictOpenFolder')}
            </Button>
            {canWrite ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={dismiss.isPending}
                onClick={() =>
                  dismiss.mutate(
                    { driveId, conflictId: conflict.conflictId },
                    { onError: () => errorToast(t('conflictDismissFailed')) },
                  )
                }
              >
                {t('conflictDismiss')}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {open.length > 5 ? (
        <p className="text-muted-foreground mt-1 pl-6 text-xs">
          {t('conflictsMore', { count: open.length - 5 })}
        </p>
      ) : null}
    </section>
  );
}
