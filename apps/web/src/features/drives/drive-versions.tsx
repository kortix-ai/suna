'use client';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useDriveVersions, useRestoreDriveVersion } from '@/hooks/drives/use-drives';
import { useFormatter, useTranslations } from '@/i18n/use-translations';
import { ArrowCounterClockwiseIcon, ClockCounterClockwiseIcon } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

import { type DriveVersion, dayKey, groupVersionsByDay } from './drive-model';

const KNOWN_KINDS = new Set(['created', 'edit', 'sync', 'restore']);
const KNOWN_AUTHORS = new Set(['drive', 'session']);

export function DriveVersions({ driveId }: { driveId: string }) {
  const t = useTranslations('drives');
  const format = useFormatter();
  const versions = useDriveVersions(driveId, true);
  const restore = useRestoreDriveVersion();
  const [pending, setPending] = useState<DriveVersion | null>(null);

  const groups = useMemo(() => groupVersionsByDay(versions.data ?? []), [versions.data]);
  const latestId = groups[0]?.versions[0]?.id ?? null;
  const now = new Date();
  const todayKey = dayKey(now.toISOString());
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const yesterdayKey = dayKey(yesterday.toISOString());

  const dayLabel = (day: string, sample: string) => {
    if (day === todayKey) return t('today');
    if (day === yesterdayKey) return t('yesterday');
    return format.dateTime(new Date(sample), { dateStyle: 'long' });
  };

  const kindLabel = (kind: DriveVersion['kind']) =>
    t(`versionKind.${kind && KNOWN_KINDS.has(kind) ? kind : 'edit'}`);

  const details = (version: DriveVersion) => {
    const parts = [format.dateTime(new Date(version.createdAt), { timeStyle: 'short' })];
    if (version.author && KNOWN_AUTHORS.has(version.author)) {
      parts.push(t(`versionAuthor.${version.author}`));
    }
    const changed = version.changes?.changed ?? 0;
    const deleted = version.changes?.deleted ?? 0;
    if (changed > 0) parts.push(t('versionChanged', { count: changed }));
    if (deleted > 0) parts.push(t('versionDeleted', { count: deleted }));
    return parts.join(' · ');
  };

  const confirmRestore = () => {
    if (!pending) return;
    restore.mutate(
      { driveId, versionId: pending.id },
      {
        onSuccess: () => {
          setPending(null);
          successToast(t('restored'));
        },
        onError: () => errorToast(t('restoreFailed')),
      },
    );
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl space-y-6 px-4 py-6">
        {versions.isLoading ? (
          <div className="space-y-2" aria-hidden>
            <Skeleton className="h-4 w-24 rounded-sm" />
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-14 w-full rounded-md" />
            ))}
          </div>
        ) : versions.isError ? (
          <ErrorState
            size="sm"
            title={t('versionsLoadError')}
            action={
              <Button variant="outline" size="sm" onClick={() => void versions.refetch()}>
                {t('retry')}
              </Button>
            }
          />
        ) : groups.length === 0 ? (
          <EmptyState
            size="sm"
            icon={ClockCounterClockwiseIcon}
            title={t('noVersions')}
            description={t('noVersionsDescription')}
          />
        ) : (
          groups.map((group) => (
            <section key={group.day} className="space-y-2">
              <Label>{dayLabel(group.day, group.versions[0]!.createdAt)}</Label>
              <ul className="space-y-2">
                {group.versions.map((version) => {
                  const isLatest = version.id === latestId;
                  return (
                    <li
                      key={version.id}
                      className="bg-popover flex items-center gap-3 rounded-md border px-4 py-2"
                    >
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <p className="truncate text-sm font-medium">{kindLabel(version.kind)}</p>
                        <p className="text-muted-foreground truncate text-xs">{details(version)}</p>
                      </div>
                      {isLatest ? (
                        <span className="text-muted-foreground shrink-0 text-xs">
                          {t('current')}
                        </span>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setPending(version)}
                          disabled={restore.isPending}
                        >
                          <ArrowCounterClockwiseIcon className="size-3.5 shrink-0" />
                          {t('restore')}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => (open ? undefined : setPending(null))}
        title={t('restoreTitle')}
        description={t('restoreDescription', {
          time: pending
            ? format.dateTime(new Date(pending.createdAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              })
            : '',
        })}
        confirmLabel={t('restore')}
        cancelLabel={t('cancel')}
        confirmIcon={<ArrowCounterClockwiseIcon className="size-4 shrink-0" />}
        isPending={restore.isPending}
        onConfirm={confirmRestore}
      />
    </div>
  );
}
