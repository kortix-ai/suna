'use client';

import { Label } from '@kortix/ui/label';
import { Skeleton } from '@kortix/ui/skeleton';
import { StorageMeter, StorageNotice, formatStorageBytes, storageTone } from '@kortix/ui/files';
import { useAccountStorageUsage } from '@kortix/sdk/react';
import { useLocale, useTranslations } from '@/i18n/use-translations';

/**
 * Files storage of the account: the total against the plan's account limit,
 * then each project's Files against the plan's project limit, largest first.
 * The API decides every figure (`GET /drives/usage`); a member without
 * `billing.read` gets a 403 and the section stays out.
 */
export function AccountStorageSection({ accountId }: { accountId: string | undefined }) {
  const t = useTranslations('drives');
  const locale = useLocale();
  // No id: the caller's own account, as the API answers it.
  const usage = useAccountStorageUsage(accountId);

  if (usage.isLoading) {
    return (
      <section className="space-y-4">
        <Label>{t('accountStorageTitle')}</Label>
        <Skeleton className="h-24 w-full rounded-md" />
      </section>
    );
  }
  const data = usage.data;
  if (!data) return null;
  const { projectBytes, accountBytes } = data.limits;
  const tone = storageTone(data.usedBytes, accountBytes);

  return (
    <section className="space-y-4" data-testid="account-storage">
      <Label>{t('accountStorageTitle')}</Label>
      <div className="bg-popover rounded-md border px-4 py-4">
        <StorageMeter label={t('storageLabel')} usedBytes={data.usedBytes} limitBytes={accountBytes} />
        {projectBytes !== null && accountBytes !== null ? (
          <p className="text-muted-foreground mt-2 text-xs">
            {t('accountStorageDescription', {
              project: formatStorageBytes(projectBytes, locale),
              account: formatStorageBytes(accountBytes, locale),
            })}
          </p>
        ) : null}
        {tone !== 'ok' ? (
          <div className="mt-3">
            <StorageNotice>{tone === 'full' ? t('storageFull') : t('storageNearFull')}</StorageNotice>
          </div>
        ) : null}
      </div>
      {data.projects.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t('accountStorageEmpty')}</p>
      ) : (
        <ul className="bg-popover divide-border divide-y rounded-md border">
          {data.projects.map((p) => (
            <li key={p.driveId} className="px-4 py-3">
              <StorageMeter label={p.name || p.projectId} usedBytes={p.usedBytes ?? 0} limitBytes={projectBytes} />
            </li>
          ))}
        </ul>
      )}
      {!data.complete ? <p className="text-muted-foreground text-xs">{t('accountStorageIncomplete')}</p> : null}
    </section>
  );
}
