'use client';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { SolidCheckIcon } from '@/features/icon/icons/solid-check-icon';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { formatFileSize } from '@kortix/shared/constants';
import { CaretDownIcon, WarningCircleIcon, XIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { uploadedFraction } from '../upload-batch';
import { getFileIcon } from './file-icon';

export interface DriveUpload {
  id: string;
  file: File;
  /** Folder it lands in; `undefined` is the source's root. */
  targetPath?: string;
  status: 'queued' | 'uploading' | 'done' | 'error';
  /** Bytes sent so far. */
  sent?: number;
  error?: string;
}

/**
 * A gauge: a round-capped arc for the share done, a clear gap at each end,
 * then the track for what is left. It fills by bytes, so one large file moves
 * as it goes up instead of jumping from empty to full.
 */
function UploadGauge({ value, className }: { value: number; className?: string }) {
  const R = 8;
  const STROKE = 2.5;
  const C = 2 * Math.PI * R;
  // Round caps reach STROKE/2 past each end: the visible gap is GAP.
  const GAP = 1.5 + STROKE;
  const arc = Math.max(0, Math.min(1, value)) * C;
  const track = arc > 0 ? Math.max(0, C - arc - 2 * GAP) : C;
  const ease = 'transition-[stroke-dasharray,stroke-dashoffset] duration-(--duration-moderate) ease-out motion-reduce:transition-none';
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      className={cn('size-4 shrink-0 -rotate-90', className)}
    >
      {track > 0 ? (
        <circle
          cx="10"
          cy="10"
          r={R}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={`${track} ${C}`}
          strokeDashoffset={arc > 0 ? -(arc + GAP) : 0}
          stroke="currentColor"
          className={cn('text-border', ease)}
        />
      ) : null}
      {arc > 0 ? (
        <circle
          cx="10"
          cy="10"
          r={R}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={`${arc} ${C}`}
          stroke="currentColor"
          className={cn('text-foreground', ease)}
        />
      ) : null}
    </svg>
  );
}

/**
 * Every upload of this explorer, one row per file, docked bottom-right over
 * the listing — the listing stays usable while files go up. The header counts
 * files and fills by bytes; a failed row keeps its reason and a Retry.
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

  const fraction = uploadedFraction(uploads);

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
          <UploadGauge value={fraction} className="size-5" />
        ) : failed > 0 ? (
          <WarningCircleIcon className="text-kortix-red size-5 shrink-0" />
        ) : (
          <SolidCheckIcon className="text-kortix-green size-5" />
        )}
        <p aria-live="polite" className="min-w-0 flex-1 truncate text-sm font-medium tabular-nums">
          {title}
        </p>
        {active > 0 ? (
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {/* 100% only once every file is confirmed, not when the last byte leaves. */}
            {Math.min(99, Math.round(fraction * 100))}%
          </span>
        ) : null}
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
      return <UploadGauge value={(upload.sent ?? 0) / Math.max(1, upload.file.size)} />;
    case 'done':
      return <SolidCheckIcon className="text-kortix-green" />;
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
