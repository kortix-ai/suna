'use client';

import { DownloadSimpleIcon } from '@phosphor-icons/react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useTranslations } from '@/i18n/use-translations';
import { desktopDownloadUrl, isDesktop } from '@/lib/desktop';

import { CapturePage } from '../area/capture-area-shell';
import { captureHref } from '../area/use-capture-area';
import { ThisComputerPage } from '../desktop/capture-section';

/**
 * This computer (`/capture/[accountId]/this-computer`). In the desktop app it
 * is the desktop lane's "Record this computer" page for the account in the
 * route. A browser has no engine: the page says where to get the desktop app.
 */
export function ThisComputerView({ accountId }: { accountId: string }) {
  const t = useTranslations('capture.thisComputer');
  const tDevices = useTranslations('capture.devices');
  if (isDesktop()) return <ThisComputerPage accountId={accountId} />;
  return (
    <CapturePage
      title={t('title')}
      description={t('browserDescription')}
      breadcrumb={
        <nav aria-label={t('breadcrumb')} className="flex items-center gap-2 text-xs">
          <Link
            href={captureHref(accountId, 'devices')}
            className="text-muted-foreground hover:text-foreground"
          >
            {tDevices('title')}
          </Link>
          <span aria-hidden className="text-muted-foreground">
            /
          </span>
          <span className="text-foreground">{t('title')}</span>
        </nav>
      }
    >
      <div className="bg-background rounded-md border px-4 py-12">
        <EmptyState
          size="sm"
          title={t('browserTitle')}
          description={t('browserBody')}
          action={
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <a href={desktopDownloadUrl()} target="_blank" rel="noreferrer">
                <DownloadSimpleIcon className="size-3.5 shrink-0" />
                {t('getDesktop')}
              </a>
            </Button>
          }
        />
      </div>
    </CapturePage>
  );
}
