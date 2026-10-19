'use client';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { ProgressRing } from '@/components/ui/progress-ring';
import { SolidCheckIcon } from '@/features/icon/icons/solid-check-icon';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { formatFileSize } from '@kortix/shared/constants';
import { CaretDownIcon, WarningCircleIcon, XIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { getFileIcon } from './file-icon';

export interface DriveUpload {
  id: string;
  file: File;
  /** Folder it lands in; `undefined` is the source's root. */
  targetPath?: string;
  status: 'queued' | 'uploading' | 'done' | 'error';
  error?: string;
}

/**
 * Every upload of this explorer, one row per file, docked bottom-right over
 * the listing — the listing stays usable while files go up. The header counts
 * what is left; a failed row keeps its reason and a Retry.
 */
export function DriveUploadTray({
  uploads,
  onRetry,
  onDismiss,
}: {
  uploads: DriveUpload[];
  onRetry: (id: string) => void;
  onDismiss: () => void;
}) {
  const t = useTranslations('drives');
  const [collapsed, setCollapsed] = useState(false);
  if (uploads.length === 0) return null;

  const total = uploads.length;
  const done = uploads.filter((u) => u.status === 'done').length;
  const failed = uploads.filter((u) => u.status === 'error').length;
  const active = total - done - failed;

  const title =
    active > 0
      ? t('uploadsInProgress', { done: done + failed, total })
      : failed > 0
        ? t('uploadsFailedCount', { count: failed })
        : t('uploadsComplete', { count: done });

  return (
    <section
      aria-label={title}
      className="bg-popover border-border animate-in fade-in-0 slide-in-from-bottom-2 absolute right-3 bottom-3 z-40 w-80 max-w-[calc(100%-1.5rem)] overflow-hidden rounded-md border shadow-lg duration-(--duration-moderate) motion-reduce:animate-none"
    >
      <div className="flex h-10 items-center gap-2 pr-1.5 pl-3">
        {active > 0 ? (
          <ProgressRing value={((done + failed) / total) * 100} className="shrink-0" />
        ) : failed > 0 ? (
          <WarningCircleIcon className="text-destructive size-4 shrink-0" />
        ) : (
          <SolidCheckIcon className="size-4 shrink-0" />
        )}
        <p aria-live="polite" className="min-w-0 flex-1 truncate text-sm font-medium tabular-nums">
          {title}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('uploadsToggle')}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
          className="text-muted-foreground hover:text-foreground"
        >
          <CaretDownIcon
            className={cn('size-3.5 transition-transform duration-(--duration-moderate) motion-reduce:transition-none', collapsed && 'rotate-180')}
          />
        </Button>
        {active === 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('uploadsDismiss')}
            onClick={onDismiss}
            className="text-muted-foreground hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>

      {!collapsed ? (
        <ul className="border-border/60 max-h-64 overflow-y-auto border-t py-1">
          {uploads.map((u) => (
            <li key={u.id} className="flex h-9 items-center gap-2.5 px-3">
              {getFileIcon(u.file.name, { className: 'text-muted-foreground size-4 shrink-0' })}
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-sm',
                  u.status === 'done' ? 'text-foreground' : 'text-muted-foreground',
                )}
                title={u.file.name}
              >
                {u.file.name}
              </span>
              <UploadStatus upload={u} onRetry={() => onRetry(u.id)} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function UploadStatus({ upload, onRetry }: { upload: DriveUpload; onRetry: () => void }) {
  const t = useTranslations('drives');
  switch (upload.status) {
    case 'queued':
      return (
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {formatFileSize(upload.file.size)}
        </span>
      );
    case 'uploading':
      return <Loading className="size-3.5 shrink-0" />;
    case 'done':
      return <SolidCheckIcon className="text-muted-foreground size-3.5 shrink-0" />;
    case 'error':
      return (
        <Hint label={upload.error ?? t('uploadFailed', { name: upload.file.name })} side="left">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onRetry}
            className="text-destructive hover:text-destructive -mr-1.5 shrink-0"
          >
            {t('uploadRetry')}
          </Button>
        </Hint>
      );
  }
}
