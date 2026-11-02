'use client';

/**
 * Files storage, shown where people put files: how much a project's Files
 * hold against the plan's limit, the folders close to the largest folder a
 * session mounts (before a session fails to mount one), and a refused upload
 * in words with its numbers. Every figure comes from the API
 * (`GET /drives/:driveId/usage`, `driveLimitRefusal`); nothing is computed
 * from a guess here.
 */

import { type DriveFolderUsage, driveLimitRefusal } from '@kortix/sdk';
import { useDriveUsage } from '@kortix/sdk/react';
import { WarningIcon } from '@phosphor-icons/react';
import { useCallback } from 'react';
import { useLocale, useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import { Progress } from '../../primitives/progress';

export { useDriveUsage };

const UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;

/**
 * `5 GB`, `512 MB`, `3.4 KB` in the reader's locale. Binary steps (1 GB =
 * 1024 MB), the same figures the API's refusals print; one decimal under 10.
 */
export function formatStorageBytes(bytes: number, locale?: string): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: UNITS[unit],
    unitDisplay: 'short',
    maximumFractionDigits: unit === 0 || value >= 10 ? 0 : 1,
  }).format(value);
}

/** `near` from 90 % of the limit, `full` at it. A storage limit is a policy a person can act on: orange, never red. */
export type StorageTone = 'ok' | 'near' | 'full';

export function storageTone(used: number, limit: number | null): StorageTone {
  if (!limit || limit <= 0) return 'ok';
  if (used >= limit) return 'full';
  return used >= limit * 0.9 ? 'near' : 'ok';
}

/** One headline figure against its limit: the label, `1.2 GB of 5 GB`, and one bar. */
export function StorageMeter({
  label,
  usedBytes,
  limitBytes,
  className,
}: {
  label: string;
  usedBytes: number;
  limitBytes: number | null;
  className?: string;
}) {
  const t = useTranslations('drives');
  const locale = useLocale();
  const tone = storageTone(usedBytes, limitBytes);
  const used = formatStorageBytes(usedBytes, locale);
  const percent = limitBytes ? Math.min(100, (usedBytes / limitBytes) * 100) : 0;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-foreground min-w-0 truncate text-xs font-medium">{label}</span>
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {limitBytes ? t('storageOfLimit', { used, limit: formatStorageBytes(limitBytes, locale) }) : t('storageUsed', { used })}
        </span>
      </div>
      {limitBytes ? (
        <Progress
          value={percent}
          aria-label={label}
          className="h-1.5"
          indicatorClassName={tone === 'ok' ? 'bg-primary' : 'bg-kortix-orange'}
        />
      ) : null}
    </div>
  );
}

/** A folder at or past 80 % of the folder-mount cap, as one sentence. Null for a folder well under it. */
export function useFolderMountNotice() {
  const t = useTranslations('drives');
  const locale = useLocale();
  return useCallback(
    (folder: DriveFolderUsage | undefined, limitBytes: number): string | null => {
      if (!folder || folder.state === 'ok') return null;
      const params = {
        folder: folder.path.split('/').filter(Boolean).pop() ?? folder.path,
        size: formatStorageBytes(folder.bytes, locale),
        limit: formatStorageBytes(limitBytes, locale),
      };
      return folder.state === 'over_limit' ? t('folderOverMountLimit', params) : t('folderNearMountLimit', params);
    },
    [t, locale],
  );
}

/**
 * The storage block of the Files page: the project's Files against the plan's
 * limit (and the account's, when it is the closer one), what to do when it is
 * nearly full, and each folder close to the folder-mount cap.
 */
export function DriveStorageSummary({ driveId, className }: { driveId: string; className?: string }) {
  const t = useTranslations('drives');
  const usage = useDriveUsage(driveId);
  const folderNotice = useFolderMountNotice();
  const data = usage.data;
  if (!data || data.usedBytes === null) return null;
  const project = { used: data.usedBytes, limit: data.limits.projectBytes };
  const account = data.account;
  // The account figure shows only when it is the one closer to full.
  const accountLeft = account ? account.limitBytes - account.usedBytes : Number.POSITIVE_INFINITY;
  const projectLeft = project.limit === null ? Number.POSITIVE_INFINITY : project.limit - project.used;
  const tightest = account && accountLeft < projectLeft ? storageTone(account.usedBytes, account.limitBytes) : storageTone(project.used, project.limit);
  const folders = data.folders.filter((f) => f.state !== 'ok');
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <StorageMeter label={t('storageLabel')} usedBytes={project.used} limitBytes={project.limit} />
      {account && accountLeft < projectLeft ? (
        <AccountLine usedBytes={account.usedBytes} limitBytes={account.limitBytes} />
      ) : null}
      {tightest !== 'ok' ? (
        <StorageNotice>{tightest === 'full' ? t('storageFull') : t('storageNearFull')}</StorageNotice>
      ) : null}
      {folders.map((f) => (
        <StorageNotice key={f.path}>{folderNotice(f, data.limits.folderMountBytes)}</StorageNotice>
      ))}
    </div>
  );
}

function AccountLine({ usedBytes, limitBytes }: { usedBytes: number; limitBytes: number }) {
  const t = useTranslations('drives');
  const locale = useLocale();
  return (
    <p className="text-muted-foreground text-xs tabular-nums">
      {t('storageAccountLine', { used: formatStorageBytes(usedBytes, locale), limit: formatStorageBytes(limitBytes, locale) })}
    </p>
  );
}

/** A storage state a person can act on: the orange glyph and tint, the words in ink. */
export function StorageNotice({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <p role="status" className="bg-kortix-orange/15 text-foreground flex items-start gap-2 rounded-md px-2.5 py-2 text-xs text-pretty">
      <WarningIcon className="text-kortix-orange mt-px size-3.5 shrink-0" weight="fill" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/**
 * The sentence for a refused upload, in the reader's language, from the
 * refusal's code and numbers. Null for an error that is not a limit refusal:
 * the caller keeps the server's message then.
 */
export function useDriveLimitMessage() {
  const t = useTranslations('drives');
  const locale = useLocale();
  return useCallback(
    (error: unknown, fileName: string, fileSize?: number): string | null => {
      const refusal = driveLimitRefusal(error);
      if (!refusal) return null;
      const bytes = (n: number | undefined) => (n === undefined ? '' : formatStorageBytes(n, locale));
      const name = fileName;
      switch (refusal.code) {
        case 'storage_limit_exceeded':
          if (refusal.max === undefined || refusal.used === undefined || (refusal.requested ?? fileSize) === undefined) return refusal.message || null;
          return t(refusal.limit === 'account_bytes' ? 'uploadRefusedAccountFull' : 'uploadRefusedProjectFull', {
            name,
            needed: bytes(refusal.requested ?? fileSize),
            used: bytes(refusal.used),
            limit: bytes(refusal.max),
          });
        case 'file_too_large':
        case 'payload_too_large':
          if (refusal.max === undefined) return refusal.message || null;
          return t('uploadRefusedFileTooLarge', { name, size: bytes(refusal.requested ?? fileSize), limit: bytes(refusal.max) });
        case 'sub_path_too_large':
          return t('uploadRefusedFolderMount', {
            name,
            folder: refusal.path?.split('/').filter(Boolean).pop() ?? refusal.path ?? '',
            limit: bytes(refusal.max ?? 10 * 1024 ** 3),
          });
        case 'transfer_limit_exceeded':
          return t('uploadRefusedBusy', { name });
        case 'quota_exceeded':
          return t('uploadRefusedStorageFull', { name });
        default:
          return null;
      }
    },
    [t, locale],
  );
}
