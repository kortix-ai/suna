'use client';

import { useFormatter, useNow, useTranslations } from '@/i18n/use-translations';
import { Button } from '@kortix/ui/button';
import { useDismissDriveConflict, useDriveConflicts } from '@kortix/ui/files';
import { Popover, PopoverContent, PopoverTrigger } from '@kortix/ui/popover';
import { errorToast } from '@kortix/ui/toast';
import { CaretUpIcon } from '@phosphor-icons/react';
import { useId, useState } from 'react';

import { parentDrivePath } from './drive-explorer-source';

/** `/a/b/report (conflict …).txt` → name and the folder that holds it. */
function splitConflictPath(path: string): { name: string; folder: string } {
  const folder = parentDrivePath(path);
  const name = path.slice(path.lastIndexOf('/') + 1) || path;
  return { name, folder };
}

/** Static conflict control; place inside the Drive surface's relative container. */
export function DriveConflictsBar({
  driveId,
  onOpenFolder,
}: {
  driveId: string;
  onOpenFolder: (path: string) => void;
}) {
  const t = useTranslations('drives');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const conflicts = useDriveConflicts(driveId);
  const dismiss = useDismissDriveConflict();
  const titleId = useId();
  const descriptionId = useId();
  const [boundary, setBoundary] = useState<HTMLDivElement | null>(null);
  const list = conflicts.data ?? [];
  if (list.length === 0) return null;

  return (
    <div
      ref={setBoundary}
      className="pointer-events-none absolute inset-3 z-20 flex items-end justify-end"
    >
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="bg-popover text-muted-foreground hover:text-foreground border-border focus-visible:ring-ring pointer-events-auto flex h-9 max-w-full items-center gap-2 rounded-full border px-3.5 text-xs whitespace-nowrap shadow-md outline-none focus-visible:ring-1"
          >
            <span aria-hidden className="bg-kortix-orange size-1.5 shrink-0 rounded-full" />
            <span className="text-foreground truncate font-medium tabular-nums">
              {t('conflictCount', { count: list.length })}
            </span>
            <CaretUpIcon aria-hidden className="size-3 shrink-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          collisionBoundary={boundary}
          collisionPadding={0}
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          className="pointer-events-auto max-h-[var(--radix-popover-content-available-height)] w-110 max-w-[var(--radix-popover-content-available-width)] overflow-y-auto p-0"
        >
          <div className="px-3.5 pt-3 pb-2">
            <p id={titleId} className="text-sm font-medium">
              {t('conflictsTitle', { count: list.length })}
            </p>
            <p id={descriptionId} className="text-muted-foreground mt-0.5 text-xs text-pretty">
              {t('conflictsDescription')}
            </p>
          </div>
          <ul className="max-h-64 overflow-y-auto px-1.5 pb-1.5">
            {list.map((conflict) => {
              const { name, folder } = splitConflictPath(conflict.path);
              return (
                <li
                  key={conflict.conflictId}
                  className="group hover:bg-foreground/5 focus-within:bg-foreground/5 flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1" title={conflict.path}>
                    <p className="truncate text-xs font-medium">{name}</p>
                    <p className="text-muted-foreground truncate text-[11px]">
                      {folder}
                      <span aria-hidden> · </span>
                      {format.relativeTime(new Date(conflict.detectedAt), now)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="text-muted-foreground text-xs transition-none"
                      onClick={() => onOpenFolder(parentDrivePath(conflict.path))}
                    >
                      {t('conflictOpenFolder')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="text-muted-foreground text-xs transition-none"
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
                  </div>
                </li>
              );
            })}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
}
